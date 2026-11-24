import type { Layer, Output } from "@workspace/model-providers"
import { storage } from "void/storage"

import { factsOf, mimeOf } from "./facts"
import type { Sent } from "./provider.server"

/** A delivered file in R2 under `o/<id>`. The random id is the capability in its public URL. */
type Stored = {
  id: string
  mime: string
  bytes: number
  width?: number
  height?: number
  durationMs?: number
  layer?: Layer
}

/**
 * Where one run of a task stands, kept in `provider_ref`: the provider's task while it runs, the
 * files it delivered, or why it failed. `lost` is a run whose outcome is unknown (a timeout or a
 * 5xx), and `billable` marks a failure that began as lost, since the provider may have charged it.
 * `undelivered` is why a finished provider task's files could not be copied yet.
 */
export type Run =
  | { pending: string; undelivered?: string }
  | { stored: Stored[]; tokens?: number }
  | { failed: string; billable?: true }
  | { lost: string }

export const runsOf = (providerRef: string | null): Run[] =>
  providerRef ? (JSON.parse(providerRef) as Run[]) : []

/** Every file a task's runs delivered, in run order. */
export const storedOf = (providerRef: string | null) =>
  runsOf(providerRef).flatMap((run) => ("stored" in run ? run.stored : []))

export const outputKey = (id: string) => `o/${id}`

/** The output id in a `/f/<id>.<ext>` file name, or null when it is not one. */
export function outputIdOf(fileName: string) {
  const id = fileName.split(".")[0] ?? ""
  return /^[0-9a-f]{32}$/.test(id) ? id : null
}

const FETCH_TRIES = 3
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A provider's output link, asked again after a dropped connection, a 5xx or a 429. */
async function download(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url).catch((error: unknown) => {
      if (attempt === FETCH_TRIES) throw error
      return null
    })
    if (response && (response.ok || (response.status < 500 && response.status !== 429)))
      return response
    if (attempt === FETCH_TRIES) return response!
    await sleep(1000 * attempt)
  }
}

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")

/** Copies one delivered output into R2, so no provider link (which expires) is kept. */
async function store(taskId: string, output: Output): Promise<Stored> {
  let bytes: Uint8Array
  let mime: string
  if (output.asset.kind === "inline") {
    bytes = Uint8Array.from(atob(output.asset.base64), (char) => char.charCodeAt(0))
    mime = output.asset.mime
  } else {
    const response = await download(output.asset.url)
    if (!response.ok) throw new Error(`Fetching an output answered ${response.status}`)
    bytes = new Uint8Array(await response.arrayBuffer())
    mime = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream"
  }
  mime = mimeOf(bytes, mime)
  const id = randomId()
  await storage.put(outputKey(id), bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { task: taskId },
  })
  const facts = factsOf(bytes)
  return {
    id,
    mime,
    bytes: bytes.length,
    width: facts.width ?? output.width,
    height: facts.height ?? output.height,
    durationMs: facts.durationMs,
    ...(output.layer && { layer: output.layer }),
  }
}

/**
 * What a provider's answer for one run becomes. A done run is stored at once. A polled run whose
 * files could not be copied stays pending, so the next poll fetches them again.
 */
export async function runOf(taskId: string, sent: Sent, providerTask?: string): Promise<Run> {
  if (sent.state === "pending") return { pending: sent.taskId }
  if (sent.state === "failed") return { failed: sent.reason }
  if (sent.state === "unknown") return { lost: sent.reason }
  if (!sent.result.results.length) return { failed: "The provider delivered no file." }
  try {
    const stored = await Promise.all(sent.result.results.map((output) => store(taskId, output)))
    return { stored, ...(sent.result.usage && { tokens: sent.result.usage.tokens }) }
  } catch (error) {
    return providerTask
      ? { pending: providerTask, undelivered: String(error) }
      : { failed: String(error), billable: true }
  }
}
