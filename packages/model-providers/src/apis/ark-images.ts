import { z } from "zod"

import { apiModelOf } from "../lib/model"
import { type AspectRatio, type Resolution, ratioOf } from "../lib/params"
import type { Layer } from "../lib/result"
import { type Adapter, json, unreadable } from "./api"

const image = z.object({
  url: z.string(),
  size: z.string().optional(),
  // A decomposed layer: its stacking order, its box on the source, and recognized text.
  z_index: z.number().optional(),
  bounding_box: z
    .object({ absolute: z.tuple([z.number(), z.number(), z.number(), z.number()]) })
    .optional(),
  text_recognition: z.object({ text: z.string() }).optional(),
})

const response = z.object({
  data: z.array(z.union([image, z.object({ error: z.object({ message: z.string() }) })])),
  usage: z.object({ generated_images: z.number() }).optional(),
})

const SIDE: Partial<Record<Resolution, number>> = {
  "1K": 1024,
  "1.5K": 1536,
  "2K": 2048,
  "3K": 3072,
  "4K": 4096,
}

/** Width and height for a resolution at a ratio: the square's area reshaped, each side rounded to 16. Null for video. */
function pixelsOf(
  ratio: AspectRatio,
  resolution: Resolution
): { width: number; height: number } | null {
  const side = SIDE[resolution]
  if (!side) return null
  const [w, h] = ratio.split(":").map(Number) as [number, number]
  const round = (n: number) => Math.round(n / 16) * 16
  const width = side * Math.sqrt(w / h)
  return { width: round(width), height: round((side * side) / width) }
}

/** `"2048x2048"` into numbers, when Ark reports the delivered size. */
const sizeOf = (size?: string) => {
  const [width, height] = (size ?? "").split("x").map(Number)
  return width && height ? { width, height } : {}
}

/** The layer fields of a decomposition item, when it is one. */
function layerOf(item: z.infer<typeof image>): Layer | undefined {
  if (item.z_index === undefined || !item.bounding_box) return undefined
  const text = item.text_recognition?.text
  return { z: item.z_index, box: item.bounding_box.absolute, ...(text && { text }) }
}

/**
 * Seedream answers in the same call. A resolution (`2K`) leaves the ratio to the prompt, so a chosen
 * ratio is sent as `WxH` pixels. A model with no ratio control (layer decomposition, which keeps the
 * source's shape) sends the tier itself.
 */
export const arkImages: Adapter = {
  submit(model, { prompt, references, params }) {
    const resolution = params.resolution ?? "2K"
    const ratio = ratioOf(params.aspectRatio)
    const pixels = ratio && pixelsOf(ratio, resolution)
    const images = references.map((reference) => reference.url)
    return {
      method: "POST",
      path: "/images/generations",
      body: json({
        model: apiModelOf(model),
        ...(prompt && { prompt }),
        size: pixels ? `${pixels.width}x${pixels.height}` : resolution,
        ...(images.length === 1 && { image: images[0] }),
        ...(images.length > 1 && { image: images }),
        ...(params.sequential !== undefined && {
          sequential_image_generation: params.sequential ? "auto" : "disabled",
        }),
        // An alpha channel needs PNG, and Ark refuses `transparent` with JPEG.
        ...(params.transparent && { background: "transparent", output_format: "png" }),
        ...(model.mode === "layers" && {
          layer_decomposition: true,
          layer_decomposition_options: {
            max_images: params.layers,
            text_recognition: params.textRecognition,
          },
        }),
        watermark: params.watermark ?? false,
        response_format: "url",
      }),
    }
  },
  read(body) {
    const parsed = response.safeParse(body)
    if (!parsed.success) return unreadable("Ark image", parsed.error)
    const results = parsed.data.data.flatMap((item) => {
      if (!("url" in item)) return []
      const layer = layerOf(item)
      return [
        {
          asset: { kind: "url" as const, url: item.url },
          ...sizeOf(item.size),
          ...(layer && { layer }),
        },
      ]
    })
    if (!results.length) {
      const failed = parsed.data.data.find((item) => "error" in item)
      return {
        state: "failed",
        reason: failed && "error" in failed ? failed.error.message : "No image",
      }
    }
    return { state: "done", result: { type: "image", results } }
  },
}
