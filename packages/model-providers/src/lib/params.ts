/** The product's vocabulary for generation controls. Adapters in `src/apis/` translate it to each provider's spelling. */

/** Every ratio the product names, in picker order. Media models take no `auto`, since its size cannot be priced in advance (docs/rules/generation-params.md). */
export const ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
  "16:9",
  "9:16",
  "21:9",
] as const

export type AspectRatio = (typeof ASPECT_RATIOS)[number]

/**
 * `adaptive` takes the shape of the input (a first frame, a video to extend), or lets the model pick.
 * Only video offers it: Seedance bills by pixels, and the quote already counts the most a resolution
 * has, so the shape need not be known ahead.
 */
export type Shape = AspectRatio | "adaptive"

/** The ratio a shape names, for code that sizes an image. No image model offers `adaptive`, so it reads as unset. */
export const ratioOf = (shape: Shape | undefined): AspectRatio | undefined =>
  shape === "adaptive" ? undefined : shape

/** Image resolutions name a square's side in K. Video names its short edge. */
export type Resolution = "1K" | "1.5K" | "2K" | "3K" | "4K" | "480p" | "720p" | "768p" | "1080p"

export type Quality = "low" | "medium" | "high" | "xhigh" | "max"

/** How much a model plans before rendering, separate from quality. Higher helps dense text, at more latency. */
export type Complexity = "low" | "medium" | "high"

/** Every control a generation model may take, by product name. */
export type Params = {
  aspectRatio: Shape
  resolution: Resolution
  quality: Quality
  complexity: Complexity
  /** Outputs per request. A model without it returns what it always returns. */
  count: number
  /** Seconds of video. */
  duration: number
  audio: boolean
  /** Also returns the video's last frame as an image, to start the next clip from. */
  lastFrame: boolean
  watermark: boolean
  /** Seedream's image group, where one prompt yields a related series. */
  sequential: boolean
  /** An image with an alpha channel instead of a background. */
  transparent: boolean
  /** The most images a layer decomposition returns, the base image included. */
  layers: number
  /** Recognizes the text on text layers, with its position and style. */
  textRecognition: boolean
}

export type ParamKey = keyof Params

/** Controls that take a closed list of values. Only these can key a rate table. */
export type ChoiceKey = { [K in ParamKey]: Params[K] extends string ? K : never }[ParamKey]

export type Choice<T extends string> = { options: readonly T[]; default: T }
export type Range = { min: number; max: number; step: number; default: number }
export type Toggle = { default: boolean }

/** The constraint for a value type: a list for strings, a range for numbers, a default for flags. */
type SpecOf<V> = [V] extends [boolean]
  ? Toggle
  : [V] extends [number]
    ? Range
    : [V] extends [string]
      ? Choice<V>
      : never

/** What one model accepts. A key it leaves out is a control it does not have, and a request sending it is refused. */
export type ParamSpec = { [K in ParamKey]?: SpecOf<Params[K]> }

type Widget = "choice" | "slider" | "number" | "toggle"

/** How each control is shown. Order here is panel order. Label, widget and unit live once, not per model. */
export const PARAMS: { [K in ParamKey]: { label: string; widget: Widget; unit?: string } } = {
  aspectRatio: { label: "Aspect ratio", widget: "choice" },
  resolution: { label: "Resolution", widget: "choice" },
  quality: { label: "Quality", widget: "choice" },
  complexity: { label: "Complexity", widget: "choice" },
  duration: { label: "Duration", widget: "slider", unit: "s" },
  count: { label: "Count", widget: "number" },
  sequential: { label: "Sequential images", widget: "toggle" },
  layers: { label: "Layers", widget: "slider" },
  textRecognition: { label: "Text recognition", widget: "toggle" },
  transparent: { label: "Transparent", widget: "toggle" },
  audio: { label: "Audio", widget: "toggle" },
  lastFrame: { label: "Last frame image", widget: "toggle" },
  watermark: { label: "Watermark", widget: "toggle" },
}

/** One control a settings panel renders, with the model's constraint. */
export type Control = {
  [K in ParamKey]: { key: K; label: string; widget: Widget; unit?: string } & SpecOf<Params[K]>
}[ParamKey]

/** The controls a spec offers, in panel order. */
export function controlsOf(spec: ParamSpec): Control[] {
  return (Object.keys(PARAMS) as ParamKey[]).flatMap((key) => {
    const constraint = spec[key]
    return constraint ? [{ key, ...PARAMS[key], ...constraint } as Control] : []
  })
}

/** Every default a spec declares. A request starts from these before the caller's choices. */
export function defaultsOf(spec: ParamSpec): Partial<Params> {
  return Object.fromEntries(
    (Object.keys(spec) as ParamKey[]).map((key) => [key, spec[key]!.default])
  ) as Partial<Params>
}
