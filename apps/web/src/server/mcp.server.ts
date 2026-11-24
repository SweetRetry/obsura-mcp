import {
  ASPECT_RATIOS,
  controlsOf,
  models,
  type MediaModel,
  type Pricing,
  type Quote,
} from "@workspace/model-providers"
import {
  type ClientCapabilities,
  inputRequired,
  inputResponse,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
  type ServerContext,
} from "@modelcontextprotocol/server"
import env from "@env"
import { z } from "zod"

import { previewOf } from "./generation/preview.server"
import { storedOf } from "./generation/runs.server"
import {
  advanceTask,
  checkTask,
  mediaModelOf,
  submitTask,
  taskByClientKey,
  taskOf,
  type TaskRow,
} from "./generation/tasks.server"
import { isOn, offOf } from "./generation/switches.server"
import { costReport, listTasks, taskView, type TaskView } from "./generation/views.server"

/** Who is calling, from the verified access token: the user (`sub`) and the OAuth client (`azp`). */
export type Caller = { userId: string; clientId: string | null }

const FINAL = new Set(["succeeded", "partial", "failed"])
const POLL_MS = 4_000
/** Keeps a waiting call inside the 60 s request timeout MCP clients default to. */
const MAX_WAIT_S = 45
const MAX_BATCH = 6

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Report = (message: string) => void

/**
 * Progress notifications for this call, when the client sent a progress token. A client may reset
 * its timeout on each one, and the first one turns the response into a stream.
 */
function reporterOf(ctx: ServerContext): Report {
  const progressToken = ctx.mcpReq._meta?.progressToken
  if (progressToken === undefined) return () => {}
  let progress = 0
  return (message) => {
    progress += 1
    void ctx.mcpReq
      .notify({ method: "notifications/progress", params: { progressToken, progress, message } })
      .catch(() => {})
  }
}

/**
 * Advances a task until it is final, `seconds` pass or the client hangs up, so one tool call can
 * return the result.
 */
async function waitFor(taskId: string, seconds: number, ctx: ServerContext, report: Report) {
  const deadline = Date.now() + Math.min(seconds, MAX_WAIT_S) * 1000
  let task = await taskOf(taskId)
  while (
    task &&
    !FINAL.has(task.state) &&
    !ctx.mcpReq.signal.aborted &&
    Date.now() + POLL_MS < deadline
  ) {
    await sleep(POLL_MS)
    await advanceTask(taskId)
    task = await taskOf(taskId)
    if (task) report(`Task ${taskId} is ${task.state}.`)
  }
  return task
}

/** A batch as tool output: the JSON views, plus a link per output so the client can open it. */
function batchResult(results: (TaskView | { refused: string })[]) {
  const views = results.filter((result): result is TaskView => "id" in result)
  const open = views.filter((view) => !FINAL.has(view.state)).map((view) => view.id)
  const note = open.length
    ? `Still running: ${open.join(", ")}. Call get_task with each task_id (wait_seconds up to ${MAX_WAIT_S}) to collect it.`
    : undefined
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ tasks: results, note }) },
      ...views.flatMap((view) => outputLinks(view)),
    ],
    structuredContent: { tasks: results },
  }
}

/** A task as tool output: the JSON view, plus a link per output so the client can open it. */
function taskResult(view: TaskView) {
  const note = FINAL.has(view.state)
    ? undefined
    : `Still ${view.state}. Call get_task with task_id "${view.id}" (wait_seconds up to ${MAX_WAIT_S}) to collect it.`
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(note ? { ...view, note } : view) },
      ...outputLinks(view),
    ],
    structuredContent: view,
  }
}

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
const TASK_POLL_MS = 5_000

/**
 * A batch as an MCP task (the tasks extension): working until every task in it is final, then
 * completed with the result a blocking `generate` call returns.
 */
function mcpTask(batch: TaskRow[], origin: string) {
  const times = batch.flatMap((task) =>
    [task.createdAt, task.startedAt, task.finishedAt].flatMap((at) => (at ? [at.getTime()] : []))
  )
  const handle = {
    taskId: batch.map((task) => task.id).join(","),
    createdAt: new Date(Math.min(...batch.map((task) => task.createdAt.getTime()))).toISOString(),
    lastUpdatedAt: new Date(Math.max(...times)).toISOString(),
    ttlMs: null,
    pollIntervalMs: TASK_POLL_MS,
  }
  const done = batch.filter((task) => FINAL.has(task.state)).length
  if (done < batch.length)
    return {
      ...handle,
      status: "working" as const,
      statusMessage: `${done} of ${batch.length} tasks done.`,
    }
  const result = batchResult(batch.map((task) => taskView(task, origin)))
  return { ...handle, status: "completed" as const, result: { resultType: "complete", ...result } }
}

const outputLinks = (view: TaskView) =>
  view.outputs.map((output, index) => ({
    type: "resource_link" as const,
    uri: output.url,
    name: `${view.modality}-${index + 1}`,
    mimeType: output.mime,
  }))

const refused = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
})

/**
 * Whether the client can show the user a confirmation form. Only a 2026-07-28 request says so (the
 * handler fills the capabilities in from its envelope); a 2025-era request is served statelessly,
 * has none and cannot be asked anything. A bare `elicitation: {}` means form mode.
 */
function canConfirm(capabilities: ClientCapabilities | undefined) {
  const elicitation = capabilities?.elicitation
  return !!elicitation && (elicitation.form !== undefined || Object.keys(elicitation).length === 0)
}

type Checked = { model: MediaModel; runs: number; quote: Quote }

/** What the user is asked before a batch is recorded: per task the model, the runs and the quote, then the total. */
function confirmation(batch: Checked[]) {
  const usd = (quote: Quote) => (quote.usd === null ? "price unknown" : `$${+quote.usd.toFixed(4)}`)
  const line = ({ model, runs, quote }: Checked) =>
    `${model.name} (${model.modality}), ${runs} ${runs === 1 ? "run" : "runs"}, ${usd(quote)}`
  if (batch.length === 1) return `Generate ${line(batch[0]!)} at list price?`
  const known = batch.every(({ quote }) => quote.usd !== null)
  const total = batch.reduce((sum, { quote }) => sum + (quote.usd ?? 0), 0)
  return [
    `Generate ${batch.length} tasks at list price?`,
    ...batch.map((task, i) => `${i + 1}. ${line(task)}`),
    known
      ? `Total $${+total.toFixed(4)}`
      : `Total at least $${+total.toFixed(4)} (some prices unknown)`,
  ].join("\n")
}

const params = z
  .object({
    aspectRatio: z.enum([...ASPECT_RATIOS, "adaptive"]),
    resolution: z.string(),
    quality: z.string(),
    complexity: z.string(),
    count: z.number(),
    duration: z.number(),
    audio: z.boolean(),
    lastFrame: z.boolean(),
    watermark: z.boolean(),
    sequential: z.boolean(),
    transparent: z.boolean(),
    layers: z.number(),
    textRecognition: z.boolean(),
  })
  .partial()
  .describe("Controls the model offers; list_models shows each model's options and defaults.")

const reference = z.object({
  url: z.url().describe("A public URL the provider can fetch."),
  role: z.enum(["reference", "first-frame", "last-frame", "mask"]).default("reference"),
  mime: z.string().describe("e.g. image/png, image/jpeg, video/mp4"),
})

/** A price as JSON: the rates and what they bill, without a token model's estimator. */
function priceView(price: Pricing) {
  const { per, rates, videoIn, referenceImage } = price
  return { per, rates, videoIn, referenceImage }
}

/** Where a model's guide is read as an MCP resource. */
const guideUri = (model: MediaModel) => `obscura://guides/${model.id}`

const isoDate = z.iso.datetime({ offset: true }).or(z.iso.date())

/** A fresh MCP server for one request, with the caller bound into every tool. */
export function mcpServer(caller: Caller) {
  const origin = env.BETTER_AUTH_URL
  const server = new McpServer(
    { name: "obscura", version: "0.1.0" },
    { capabilities: { extensions: { [TASKS_EXTENSION]: {} } } }
  )
  const takesTasks = () => !!server.server.getClientCapabilities()?.extensions?.[TASKS_EXTENSION]

  /** The caller's tasks behind an MCP task id, or nothing when any of them is missing or not theirs. */
  async function batchOf(mcpTaskId: string) {
    const ids = mcpTaskId.split(",")
    if (ids.length > MAX_BATCH) return undefined
    const batch = await Promise.all(ids.map((id) => taskOf(id)))
    return batch.every((task) => task?.userId === caller.userId) ? (batch as TaskRow[]) : undefined
  }

  const taskIdParams = { params: z.object({ taskId: z.string() }) }
  server.server.setRequestHandler("tasks/get", taskIdParams, async ({ taskId }) => {
    const batch = await batchOf(taskId)
    if (!batch) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "No such task.")
    await Promise.all(
      batch.filter((task) => !FINAL.has(task.state)).map((task) => advanceTask(task.id))
    )
    return mcpTask((await batchOf(taskId)) ?? batch, origin)
  })
  server.server.setRequestHandler("tasks/cancel", taskIdParams, async () => {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      "A generation can't be cancelled: its provider is already running and billing it."
    )
  })

  server.registerTool(
    "list_models",
    {
      title: "List models",
      description: [
        "Image, video and audio generation models: id, capabilities, controls with their options and defaults,",
        "and list price. A model with a guide takes its syntax in the prompt: call get_model_guide before",
        "writing for it, and follow the guide over what you remember about the model.",
      ].join(" "),
      inputSchema: z.object({ modality: z.enum(["image", "video", "audio"]).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ modality }) => {
      const off = await offOf()
      const list = models
        .filter((model) => (!modality || model.modality === modality) && isOn(off, model))
        .map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
          modality: model.modality,
          capabilities: model.capabilities,
          controls: controlsOf(model.params).map(({ label: _, widget: __, ...control }) => control),
          maxReferences: model.maxReferences,
          outputsPerRun: model.outputsPerRun,
          guide: model.guide && guideUri(model),
          price: model.price && priceView(model.price),
        }))
      return { content: [{ type: "text", text: JSON.stringify(list) }] }
    }
  )

  server.registerTool(
    "get_model_guide",
    {
      title: "Get model guide",
      description: [
        "The prompt-writing guide of a model that list_models marks with a guide: its current version,",
        "prompt syntax and parameters. Read it before the first generate call for that model.",
      ].join(" "),
      inputSchema: z.object({ model: z.string().describe("A model id or name from list_models.") }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const model = mediaModelOf(input.model)
      if (!model) return refused(`Unknown model "${input.model}". Call list_models.`)
      if (!model.guide)
        return refused(`${model.name} has no guide. Its controls are in list_models.`)
      return { content: [{ type: "text", text: model.guide }] }
    }
  )

  // The same guides as resources, for clients that let a person attach one.
  for (const model of models) {
    const { guide } = model
    if (!guide) continue
    server.registerResource(
      `${model.id}-guide`,
      guideUri(model),
      { title: `${model.name} prompt guide`, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide }] })
    )
  }

  server.registerTool(
    "generate",
    {
      title: "Generate media",
      description: [
        `Generate images, video or audio: 1 to ${MAX_BATCH} tasks in one call, each with its own model,`,
        "prompt, params and references. Send tasks the user asked for together: a client that can ask",
        "its user is sent one confirmation with every task's quote, and if any task is invalid nothing",
        "is recorded. Each run is billed by the provider, so prefer runs=1 unless asked for variations.",
        "Images usually finish within the call; video returns tasks to collect with get_task.",
        "Pass a client_key per task to make a retry idempotent.",
        "Returns the tasks in order with their quotes and, once done, public output URLs.",
      ].join(" "),
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              model: z.string().describe("A model id or name from list_models."),
              prompt: z
                .string()
                .default("")
                .describe(
                  "Required, except by a model whose mode runs without one (layer decomposition)."
                ),
              params: params.optional(),
              references: z.array(reference).max(50).optional(),
              runs: z.number().int().min(1).max(4).default(1),
              client_key: z.string().max(200).optional(),
            })
          )
          .min(1)
          .max(MAX_BATCH),
        wait_seconds: z
          .number()
          .min(0)
          .optional()
          .describe(
            `How long to wait for the results, at most ${MAX_WAIT_S}. Default ${MAX_WAIT_S} when every task is image or audio, 0 when any is video.`
          ),
      }),
    },
    async (input, ctx) => {
      const requests = input.tasks.map((task) => ({
        model: task.model,
        prompt: task.prompt,
        params: task.params as never,
        references: task.references,
        runs: task.runs,
        clientKey: task.client_key,
      }))
      const keys = requests.flatMap((request) => request.clientKey ?? [])
      if (new Set(keys).size !== keys.length)
        return refused("Each task in a batch needs its own client_key.")

      // A retry of a task that already exists spends nothing, so only new tasks are checked and confirmed.
      const retried = await Promise.all(
        requests.map(
          (request) =>
            request.clientKey !== undefined && taskByClientKey(caller.userId, request.clientKey)
        )
      )
      const fresh = requests.flatMap((request, i) => (retried[i] ? [] : [{ request, n: i + 1 }]))
      const checked = await Promise.all(fresh.map(({ request }) => checkTask(request)))
      const problems = checked.flatMap((result, i) =>
        "refused" in result ? [`Task ${fresh[i]!.n}: ${result.refused}`] : []
      )
      if (problems.length) return refused(`Nothing was recorded. ${problems.join(" ")}`)

      if (fresh.length && canConfirm(server.server.getClientCapabilities())) {
        const answer = inputResponse(ctx.mcpReq.inputResponses, "confirm")
        if (answer.kind !== "elicit")
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: confirmation(checked as Checked[]),
                requestedSchema: { type: "object", properties: {} },
              }),
            },
          })
        if (answer.action === "decline")
          return refused("The user declined these generations. Do not retry them unless they ask.")
        if (answer.action !== "accept")
          return refused(
            `The confirmation was not answered (${answer.action}): the client closed it without showing a choice. Ask the user before retrying.`
          )
      }

      const submitted = await Promise.all(requests.map((request) => submitTask(caller, request)))
      const accepted = submitted.flatMap((result) => ("ok" in result ? [result.ok] : []))
      if (
        takesTasks() &&
        accepted.length === submitted.length &&
        accepted.some((task) => !FINAL.has(task.state))
      )
        return { resultType: "task", ...mcpTask(accepted, origin) } as unknown as CallToolResult
      const anyVideo = submitted.some((result) => "ok" in result && result.ok.modality === "video")
      const wait = input.wait_seconds ?? (anyVideo ? 0 : MAX_WAIT_S)
      const report = reporterOf(ctx)
      const results = await Promise.all(
        submitted.map(async (result, i) => {
          if ("refused" in result) return { refused: `Task ${i + 1}: ${result.refused}` }
          const task = (await waitFor(result.ok.id, wait, ctx, report)) ?? result.ok
          return taskView(task, origin)
        })
      )
      return batchResult(results)
    }
  )

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "A generation task's state, outputs and cost. Polls the provider; wait_seconds blocks until it finishes or the time passes.",
      inputSchema: z.object({
        task_id: z.string(),
        wait_seconds: z
          .number()
          .min(0)
          .default(0)
          .describe(`How long to wait for the task to finish, at most ${MAX_WAIT_S}.`),
      }),
    },
    async ({ task_id, wait_seconds }, ctx) => {
      const found = await taskOf(task_id)
      if (!found || found.userId !== caller.userId) return refused("No such task.")
      await advanceTask(task_id)
      const task = (await waitFor(task_id, wait_seconds, ctx, reporterOf(ctx))) ?? found
      return taskResult(taskView(task, origin))
    }
  )

  server.registerTool(
    "view_output",
    {
      title: "View output",
      description: [
        "Look at a task's generated images, scaled to fit 1024px, to judge them before refining",
        "the prompt. index (1-based, as in the output names) picks one image; without it, all of",
        "them. Video and audio can't be viewed; open their URLs instead.",
      ].join(" "),
      inputSchema: z.object({
        task_id: z.string(),
        index: z.number().int().min(1).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ task_id, index }) => {
      const task = await taskOf(task_id)
      if (!task || task.userId !== caller.userId) return refused("No such task.")
      const files = storedOf(task.providerRef)
      const urls = taskView(task, origin).outputs.map((output) => output.url)
      const picked = files
        .map((file, i) => ({ ...file, n: i + 1, url: urls[i] }))
        .filter((file) => index === undefined || file.n === index)
      if (picked.length === 0)
        return refused(
          files.length === 0
            ? `The task has no outputs yet (${task.state}).`
            : `The task has ${files.length} outputs; index ${index} is out of range.`
        )
      const images = picked.filter((file) => file.mime.startsWith("image/"))
      if (images.length === 0)
        return refused(`These outputs are ${picked[0]?.mime}, not images. Open their URLs instead.`)
      try {
        const previews = await Promise.all(images.map((file) => previewOf(file.id)))
        return {
          content: images.flatMap((file, i) => {
            const preview = previews[i]
            const label = `${task.modality}-${file.n}: ${file.url} (${file.width ?? "?"}x${file.height ?? "?"})`
            return preview
              ? [
                  { type: "text" as const, text: label },
                  { type: "image" as const, data: preview.data, mimeType: preview.mimeType },
                ]
              : [{ type: "text" as const, text: `${label} is missing from storage.` }]
          }),
        }
      } catch (error) {
        return refused(`Could not render a preview: ${(error as Error).message}`)
      }
    }
  )

  server.registerTool(
    "list_tasks",
    {
      title: "Search tasks",
      description:
        "Search the generation log, newest first: by words in the prompt (or a task id), model, state and date. Each task has its outputs' URLs, state and cost.",
      inputSchema: z.object({
        query: z.string().optional().describe("Words the prompt contains, or a task id."),
        model: z.string().optional().describe("A model id from list_models."),
        limit: z.number().int().min(1).max(200).default(20),
        state: z
          .enum(["queued", "running", "confirming", "succeeded", "partial", "failed"])
          .optional(),
        since: isoDate.optional(),
        until: isoDate.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, model, limit, state, since, until }) => {
      const rows = await listTasks(caller.userId, {
        query,
        model,
        limit,
        state,
        until: until ? new Date(until) : undefined,
        since: since ? new Date(since) : undefined,
      })
      const views = rows.map((row) => taskView(row, origin))
      return { content: [{ type: "text", text: JSON.stringify(views) }] }
    }
  )

  server.registerTool(
    "cost_report",
    {
      title: "Cost report",
      description:
        "Cost audit in USD at list price over a date range: totals, per model and per day, with quoted vs delivered cost and runs the provider may have billed without delivering.",
      inputSchema: z.object({ since: isoDate.optional(), until: isoDate.optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ since, until }) => {
      const report = await costReport(caller.userId, {
        since: since ? new Date(since) : undefined,
        until: until ? new Date(until) : undefined,
      })
      return { content: [{ type: "text", text: JSON.stringify(report) }] }
    }
  )

  return server
}
