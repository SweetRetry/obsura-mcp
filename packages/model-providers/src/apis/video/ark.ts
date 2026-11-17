import { z } from "zod"

import { apiModelOf } from "../../lib/model"
import type { Outcome } from "../../lib/result"
import { type Adapter, json, unreadable } from "../api"
import { contentOf } from "./content"

const created = z.object({ id: z.string() })

const task = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "expired"]),
  content: z.object({ video_url: z.string(), last_frame_url: z.string().optional() }).optional(),
  usage: z.object({ completion_tokens: z.number() }).optional(),
  error: z.object({ message: z.string() }).nullish(),
})

/**
 * Seedance on Ark submits a task, then polls it. The prompt and references share one `content` list.
 * Ark spells 4K `4k`. An entry without a ratio control (edit) takes the input's shape
 * (`adaptive`), and one without a duration control (edit) takes the input's length (`-1`).
 */
export const arkVideo: Adapter = {
  submit(model, { prompt, references, params }) {
    return {
      method: "POST",
      path: "/contents/generations/tasks",
      body: json({
        model: apiModelOf(model),
        content: [{ type: "text", text: prompt }, ...references.map(contentOf)],
        // Plain entries leave the task to Ark (`auto`), which reads it from the prompt and references.
        ...(model.mode === "edit" && { omni_reference_task_type: "edit" }),
        ratio: params.aspectRatio ?? "adaptive",
        ...(params.resolution && { resolution: params.resolution.toLowerCase() }),
        duration: params.duration ?? -1,
        // No seed control in the product, so the request asks for a random one.
        seed: -1,
        ...(params.audio !== undefined && { generate_audio: params.audio }),
        ...(params.lastFrame && { return_last_frame: true }),
        watermark: params.watermark ?? false,
      }),
    }
  },
  read(body) {
    const parsed = created.safeParse(body)
    return parsed.success
      ? { state: "pending", taskId: parsed.data.id }
      : unreadable("Ark task", parsed.error)
  },
  poll: {
    call: (taskId) => ({ method: "GET", path: `/contents/generations/tasks/${taskId}` }),
    read(body): Outcome {
      const parsed = task.safeParse(body)
      if (!parsed.success) return unreadable("Ark task", parsed.error)
      const { id, status, content, usage, error } = parsed.data
      if (status === "queued" || status === "running") return { state: "pending", taskId: id }
      if (status === "succeeded" && content) {
        return {
          state: "done",
          result: {
            type: "video",
            results: [
              { asset: { kind: "url", url: content.video_url } },
              ...(content.last_frame_url
                ? [{ asset: { kind: "url" as const, url: content.last_frame_url } }]
                : []),
            ],
            ...(usage && { usage: { tokens: usage.completion_tokens } }),
          },
        }
      }
      return { state: "failed", reason: error?.message ?? `Task ${status}` }
    },
  },
}
