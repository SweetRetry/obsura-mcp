import type { MediaModel } from "../lib/model"
import { ASPECT_RATIOS, type Params, type ParamSpec, type Resolution } from "../lib/params"
import type { Pricing, Rate, Rates } from "../lib/price"
import type { Provider } from "../lib/provider"

/** ByteDance's own models, served by Volcengine Ark (火山方舟). */
export const bytedance: Provider = {
  id: "bytedance",
  name: "ByteDance",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  keyEnv: "ARK_API_KEY",
  // Docs: https://www.volcengine.com/docs/82379
}

/** Seedream takes any `WxH`, so every ratio is offered. Resolution is what its price keys on. */
function imageParams(resolutions: readonly Resolution[], resolution: Resolution = "2K"): ParamSpec {
  return {
    aspectRatio: { options: ASPECT_RATIOS, default: "16:9" },
    resolution: { options: resolutions, default: resolution },
  }
}

const cny = (amount: number): Rate => ({ amount, currency: "CNY" })

/** CNY at each resolution. */
type ByResolution = Partial<Record<Resolution, number>>

const byResolution = (amounts: ByResolution): Rates => ({
  by: "resolution",
  rates: Object.fromEntries(
    Object.entries(amounts).map(([resolution, amount]) => [resolution, cny(amount)])
  ),
})

/** 0.13 CNY covers outputs up to 2.61M px (1K and 1.5K), 0.23 up to 4.63M px (2K). Input images cost 0.05 each. */
const seedream55Price: Pricing = {
  per: "output",
  rates: byResolution({ "1K": 0.13, "1.5K": 0.13, "2K": 0.23 }),
  referenceImage: cny(0.05),
}

/**
 * Seedance bills width × height × frames over 1024 tokens. A clip has 24 frames a second plus one:
 * a 5 s clip at 480p was billed 121 frames (50,638 tokens) on 2026-11-01. The pixels are the most a
 * frame has at each resolution over Ark's ratios; 1080p and 4K are not measured, so they have no quote.
 */
const SEEDANCE_PIXELS: ByResolution = { "480p": 864 * 496, "720p": 1112 * 834 }

function seedanceTokens({ resolution, duration }: Partial<Params>) {
  const pixels = resolution && SEEDANCE_PIXELS[resolution]
  if (!pixels || !duration) return null
  return Math.ceil((pixels * (24 * duration + 1)) / 1024)
}

/** Seedance's price: CNY per million tokens at each resolution, and a lower rate when a run sends video in. */
const seedancePrice = (rates: ByResolution, videoIn?: ByResolution): Pricing => ({
  per: "million-tokens",
  rates: byResolution(rates),
  ...(videoIn && { videoIn: byResolution(videoIn) }),
  tokensOf: seedanceTokens,
})

/** One Seedance model, as the price page and the create-task API describe it. */
type SeedanceFamily = {
  id: string
  name: string
  resolutions: Resolution[]
  maxDuration: number
  /** Images, videos and audio clips together. */
  maxReferences: number
  /** CNY per million tokens without video input, and with it. */
  rates: ByResolution
  videoInRates: ByResolution
  /** Takes `omni_reference_task_type`, so editing can be its own entry. Only the 2.5 series does. */
  taskTypes: boolean
}

/**
 * Every Seedance model from one shape. The plain entry takes text, frames and every kind of
 * reference, and Ark infers the task (`auto`). Its ratio defaults to `adaptive`, which takes the
 * shape of a first frame or an input video. A model that takes task types also gets an Edit entry,
 * because an edit must follow the input's length (`duration: -1`), which the duration control
 * cannot say; on one that does not, editing stays with the plain entry and Ark's inference.
 * A run that sends video in is billed at the lower rate, but Ark counts the input's seconds too.
 * Docs: https://docs.volcengine.com/docs/ark/create-video-generation-task-api , prices:
 * https://docs.volcengine.com/docs/82379/1544106 .
 */
function seedance(family: SeedanceFamily): MediaModel[] {
  const { id, name, resolutions, maxDuration, maxReferences, taskTypes } = family
  const shared = {
    provider: "bytedance",
    modality: "video",
    api: "ark-video",
    maxReferences,
  } as const
  const controls = {
    resolution: { options: resolutions, default: "720p" },
    watermark: { default: false },
    audio: { default: true },
    lastFrame: { default: false },
  } satisfies ParamSpec
  const plain: MediaModel = {
    ...shared,
    id,
    name,
    capabilities: [
      "text-to-video",
      "first-frame",
      "first-last-frame",
      "reference-to-video",
      "video-extend",
      ...(taskTypes ? [] : (["video-edit"] as const)),
      "web-search",
    ],
    params: {
      ...controls,
      aspectRatio: {
        options: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
        default: "adaptive",
      },
      duration: { min: 4, max: maxDuration, step: 1, default: 5 },
    },
    price: seedancePrice(family.rates, family.videoInRates),
  }
  if (!taskTypes) return [plain]
  const edit: MediaModel = {
    ...shared,
    id: `${id}:edit`,
    apiModel: id,
    mode: "edit",
    name: `${name} Edit`,
    capabilities: ["video-edit"],
    params: controls,
    price: seedancePrice(family.videoInRates),
  }
  return [plain, edit]
}

export const bytedanceModels: MediaModel[] = [
  {
    id: "doubao-seedream-5-5-261028",
    provider: "bytedance",
    name: "Seedream 5.5",
    modality: "image",
    api: "ark-images",
    capabilities: ["text-to-image", "image-edit", "multi-reference"],
    params: { ...imageParams(["1K", "1.5K", "2K"]), transparent: { default: false } },
    maxReferences: 10,
    price: seedream55Price,
    // Docs: https://docs.volcengine.com/docs/ark/seedream-5-5
    // The price page calls it doubao-seedream-5-5. No group images and no 3K or 4K tiers.
  },
  {
    id: "doubao-seedream-5-5-261028:layers",
    apiModel: "doubao-seedream-5-5-261028",
    mode: "layers",
    provider: "bytedance",
    name: "Seedream 5.5 Layers",
    modality: "image",
    api: "ark-images",
    capabilities: ["layer-decomposition"],
    params: {
      resolution: { options: ["1K", "1.5K", "2K"], default: "2K" },
      layers: { min: 2, max: 100, step: 1, default: 30 },
      textRecognition: { default: false },
    },
    maxReferences: 1,
    price: seedream55Price,
    // Docs: https://docs.volcengine.com/docs/ark/seedream-5-5 (图层拆分)
    // Splits one PNG or JPEG into a base image and up to 99 transparent PNG layers, each with its
    // z-order and box on the source. Ark's `auto` size is left out because it cannot be priced ahead.
    // No 5.5 layer price is published. Ark bills every output image, so each layer is priced as one,
    // an inference from its billing formula; 5.0 Pro bills layers at half its image price.
  },
  {
    id: "doubao-seedream-5-0-pro-260628",
    provider: "bytedance",
    name: "Seedream 5.0 Pro",
    modality: "image",
    api: "ark-images",
    capabilities: ["text-to-image", "image-edit", "multi-reference"],
    params: imageParams(["1K", "1.5K", "2K"], "1.5K"),
    maxReferences: 10,
    price: { per: "output", rates: byResolution({ "1K": 0.3, "1.5K": 0.3, "2K": 0.6 }) },
    // Docs: https://ark.volcengine.com/region:cn-beijing/docs/seedream-5-0-pro
    // Alias doubao-seedream-5-0-pro. 0.30 CNY covers outputs up to 2.61M px (1K and 1.5K). The first
    // input image is free, and each further one costs 0.02 CNY.
  },
  {
    id: "doubao-seedream-5-0-flash-260915",
    provider: "bytedance",
    name: "Seedream 5.0 Flash",
    modality: "image",
    api: "ark-images",
    capabilities: ["text-to-image", "image-edit", "multi-reference"],
    params: imageParams(["1K", "1.5K", "2K"]),
    price: { per: "output", rates: cny(0.12) },
    // Docs: https://ark.volcengine.com/region:cn-beijing/model/detail?Id=doubao-seedream-5-0-flash
    // Alias doubao-seedream-5-0-flash. Flat price for every size. Input images are not billed.
  },
  {
    id: "doubao-seedream-5-0-260128",
    provider: "bytedance",
    name: "Seedream 5.0 Lite",
    modality: "image",
    api: "ark-images",
    capabilities: [
      "text-to-image",
      "image-edit",
      "multi-reference",
      "sequential-images",
      "web-search",
    ],
    params: { ...imageParams(["1K", "2K", "3K", "4K"]), sequential: { default: false } },
    maxReferences: 14,
    price: { per: "output", rates: cny(0.22) },
    // Docs: https://ark.volcengine.com/region:cn-beijing/model/detail?Id=doubao-seedream-5-0
    // Alias doubao-seedream-5-0-lite-260128. The model square marks it as retiring, with no date.
    // Flat price. Input images are not billed, up to 14.
  },
  ...seedance({
    id: "doubao-seedance-2-5-260628",
    name: "Seedance 2.5",
    resolutions: ["480p", "720p", "1080p", "4K"],
    maxDuration: 30,
    maxReferences: 50,
    rates: { "480p": 70, "720p": 70, "1080p": 77, "4K": 31 },
    videoInRates: { "480p": 42, "720p": 42, "1080p": 46, "4K": 19 },
    taskTypes: true,
    // The price page calls it doubao-seedance-2.5. Up to 30 images, 10 videos and 10 audio clips.
  }),
  ...seedance({
    id: "doubao-seedance-2-5-flash-261115",
    name: "Seedance 2.5 Flash",
    resolutions: ["480p", "720p"],
    maxDuration: 30,
    maxReferences: 20,
    rates: { "480p": 46, "720p": 46 },
    videoInRates: { "480p": 28, "720p": 28 },
    taskTypes: true,
    // The price page calls it doubao-seedance-2.5-flash. Up to 10 images, 5 videos and 5 audio clips.
  }),
  ...seedance({
    id: "doubao-seedance-2-0-260128",
    name: "Seedance 2.0",
    resolutions: ["480p", "720p", "1080p", "4K"],
    maxDuration: 15,
    maxReferences: 15,
    rates: { "480p": 46, "720p": 46, "1080p": 51, "4K": 26 },
    videoInRates: { "480p": 28, "720p": 28, "1080p": 31, "4K": 16 },
    taskTypes: false,
    // The price page calls it doubao-seedance-2.0. Up to 9 images, 3 videos and 3 audio clips.
  }),
  ...seedance({
    id: "doubao-seedance-2-0-fast-260128",
    name: "Seedance 2.0 Fast",
    resolutions: ["480p", "720p"],
    maxDuration: 15,
    maxReferences: 15,
    rates: { "480p": 37, "720p": 37 },
    videoInRates: { "480p": 22, "720p": 22 },
    taskTypes: false,
    // The price page calls it doubao-seedance-2.0-fast.
  }),
  ...seedance({
    id: "doubao-seedance-2-0-mini-260615",
    name: "Seedance 2.0 Mini",
    resolutions: ["480p", "720p"],
    maxDuration: 15,
    maxReferences: 15,
    rates: { "480p": 23, "720p": 23 },
    videoInRates: { "480p": 14, "720p": 14 },
    taskTypes: false,
    // The price page calls it doubao-seedance-2.0-mini.
  }),
]
