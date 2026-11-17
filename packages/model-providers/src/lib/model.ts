import type { ParamSpec } from "./params"
import type { Pricing } from "./price"
import type { ProviderId } from "./provider"

export type MediaModality = "image" | "video" | "audio"

/** A working method an image model supports, in the product's terms. */
export type ImageCapability =
  | "text-to-image"
  | "image-edit"
  | "multi-reference"
  | "mask-edit"
  | "sequential-images"
  | "layer-decomposition"
  | "web-search"

/** A working method a video model supports. */
export type VideoCapability =
  | "text-to-video"
  | "first-frame"
  | "first-last-frame"
  | "reference-to-video"
  | "video-edit"
  | "video-extend"
  | "web-search"

/** A working method an audio model supports. */
export type AudioCapability = "text-to-audio"

export type Capability = ImageCapability | VideoCapability | AudioCapability

/** Each modality with the capabilities a model of it can declare, so an image model cannot claim video editing. */
type Modal =
  | { modality: "image"; capabilities: ImageCapability[] }
  | { modality: "video"; capabilities: VideoCapability[] }
  | { modality: "audio"; capabilities: AudioCapability[] }

/** The call shape a generation model is reached through. Each names one adapter in `src/apis/`. */
export type ApiId =
  | "ark-images"
  | "ark-video"
  | "openai-images"
  | "gemini-image"
  | "midjourney"
  | "minimax-video"
  | "suno-music"

/**
 * A way to call a model whose controls cannot be those of plain generation, listed as its own
 * catalog entry. Each works on a reference: `layers` splits an image (Seedream), `edit` changes a
 * video and keeps its length (Seedance). Its capabilities say which media that reference is.
 */
export type Mode = "layers" | "edit"

type Entry = {
  /** The catalog id clients pass as `model` and tasks record. Plain entries use the API model string. */
  id: string
  /** The API model string sent as `model`, when it differs from `id` because the entry is a mode of it. */
  apiModel?: string
  provider: ProviderId
  /** Shown in the product. Unique across the catalog, since prices and records key on it. */
  name: string
}

/** A model the composer can run. Its controls use the product's vocabulary. */
export type MediaModel = Entry &
  Modal & {
    api: ApiId
    params: ParamSpec
    /** How a run is billed. Null when unpublished. */
    price: Pricing | null
    /** Reference media per request, when the provider publishes a limit. */
    maxReferences?: number
    /** Files one run always delivers, when not one. Midjourney makes four. */
    outputsPerRun?: number
    /**
     * Markdown an MCP client reads before writing the prompt, for a model whose syntax lives in the prompt
     * instead of in controls. Clients otherwise fill it in from training data, which lags the provider.
     */
    guide?: string
    /** The provider refuses a first or last frame together with reference media, as MiniMax does. */
    framesAlone?: true
    /** The way of calling the API model this entry stands for. Absent for plain generation. */
    mode?: Mode
  }

/** Whether a model declares a capability. Widens the per-modality list, since a reference's needs span modalities. */
export const hasCapability = (model: MediaModel, capability: Capability) =>
  (model.capabilities as readonly Capability[]).includes(capability)

/** The model string the provider receives. */
export const apiModelOf = (model: MediaModel) => model.apiModel ?? model.id
