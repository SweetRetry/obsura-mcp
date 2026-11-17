import { mediaOf, type Reference } from "./input"
import type { MediaModel } from "./model"
import { type ChoiceKey, defaultsOf, type Params } from "./params"

/*
 * What a run costs at the catalog's list prices. These are estimates from published prices, not the
 * provider's invoice: only token-priced models report what they billed.
 */

/** What a rate bills: one delivered file, one run (a request), one second of output, or a million tokens. */
export type PriceUnit = "output" | "call" | "second" | "million-tokens"

/** An amount in the currency the provider bills. Not converted when authored. */
export type Rate = { amount: number; currency: "CNY" | "USD" }

/** One rate, or one per value of the control that sets it. A value left out has no published rate. */
export type Rates = Rate | { by: ChoiceKey; rates: Readonly<Record<string, Rate>> }

/**
 * How a model bills. A token price also estimates the tokens one output bills from the params, for
 * the quote; a null estimate means the params do not fix it. When the provider reports what it
 * billed, that count sets the cost instead.
 */
export type Pricing = {
  rates: Rates
  /** The rates when a run sends video in, for a provider that bills those runs apart (Seedance). */
  videoIn?: Rates
  /** What each reference image a run sends costs, on top (Seedream 5.5). */
  referenceImage?: Rate
} & (
  | { per: "output" | "call" | "second" }
  | { per: "million-tokens"; tokensOf: (params: Partial<Params>) => number | null }
)

/** A rate resolved for one run's params, as a task records it. */
export type Price = Rate & { per: PriceUnit }

/** CNY to USD rate the price list pins. Revisit when it moves 3%. */
export const CNY_PER_USD = 7.2

/** US dollars for `units` of what a rate bills. */
export const usdOf = (rate: Rate, units = 1) =>
  (rate.currency === "CNY" ? rate.amount / CNY_PER_USD : rate.amount) * units

/** What a run sends in that changes its price: reference images billed apiece, and any video. */
export type Inputs = { images: number; videoIn: boolean }

const NO_INPUTS: Inputs = { images: 0, videoIn: false }

/** The priced inputs of a run's references. */
export function inputsOf(references: readonly Reference[]): Inputs {
  const media = references.map(mediaOf)
  return {
    images: media.filter((kind) => kind === "image").length,
    videoIn: media.includes("video"),
  }
}

/** The rate a table gives at these params, or null when that value has no published rate. */
function rateOf(rates: Rates, model: MediaModel, params: Partial<Params>): Rate | null {
  if (!("by" in rates)) return rates
  const value = params[rates.by] ?? model.params[rates.by]?.default
  return value === undefined ? null : (rates.rates[value] ?? null)
}

/** The rate one run bills at these params. A run that sends video in reads the video-in rates when the model has them. */
export function priceOf(
  model: MediaModel,
  params: Partial<Params> = {},
  inputs = NO_INPUTS
): Price | null {
  const pricing = model.price
  if (!pricing) return null
  const rate = rateOf((inputs.videoIn && pricing.videoIn) || pricing.rates, model, params)
  return rate && { ...rate, per: pricing.per }
}

/**
 * Files a run is quoted for: a fixed count (Midjourney's four), the count asked for, or the layers
 * asked for (an upper bound, since Ark may find fewer). Seedream's image group delivers an unknown
 * count, so it is quoted for one.
 */
export const outputsOf = (model: MediaModel, params: Partial<Params>) =>
  model.outputsPerRun ?? params.count ?? params.layers ?? 1

/** US dollars for the tokens one output is estimated to bill. Null when the price is not by tokens or the params do not fix the count. */
function tokensUsd(model: MediaModel, params: Partial<Params>, price: Price): number | null {
  if (model.price?.per !== "million-tokens") return null
  const tokens = model.price.tokensOf({ ...defaultsOf(model.params), ...params })
  return tokens === null ? null : usdOf(price, tokens / 1_000_000)
}

/** One run's list price in US dollars. Null when the catalog cannot tell. */
function runUsd(model: MediaModel, params: Partial<Params>, inputs: Inputs): number | null {
  const price = priceOf(model, params, inputs)
  if (!price) return null
  const references = model.price?.referenceImage
    ? usdOf(model.price.referenceImage, inputs.images)
    : 0
  const outputs = outputsOf(model, params)
  switch (price.per) {
    case "output":
      return usdOf(price, outputs) + references
    case "call":
      return usdOf(price) + references
    case "second":
      return params.duration === undefined ? null : usdOf(price, params.duration) + references
    case "million-tokens": {
      // The input video's seconds are billed too, and the catalog cannot know them.
      if (inputs.videoIn) return null
      const each = tokensUsd(model, params, price)
      return each === null ? null : each * outputs + references
    }
  }
}

export type Quote = { usd: number | null; price: Price | null }

/** Every run costs the same, so a quote is the run price times the runs. */
export function quoteOf(
  model: MediaModel,
  params: Partial<Params>,
  runs: number,
  inputs = NO_INPUTS
): Quote {
  const run = runUsd(model, params, inputs)
  return { usd: run === null ? null : run * runs, price: priceOf(model, params, inputs) }
}

/**
 * What the delivered runs cost: the tokens the provider reported, each delivered file for a price by
 * the file (or by tokens estimated per file), or else the run price for each. Undelivered runs cost
 * nothing here; lost runs are counted apart.
 */
export function costOf(
  model: MediaModel,
  params: Partial<Params>,
  delivered: { runs: number; outputs: number; tokens?: number },
  inputs = NO_INPUTS
): number | null {
  if (delivered.runs === 0) return 0
  const price = priceOf(model, params, inputs)
  if (!price) return null
  const references = model.price?.referenceImage
    ? usdOf(model.price.referenceImage, inputs.images) * delivered.runs
    : 0
  if (price.per === "million-tokens" && delivered.tokens !== undefined)
    return usdOf(price, delivered.tokens / 1_000_000) + references
  if (price.per === "million-tokens") {
    const each = tokensUsd(model, params, price)
    return each === null ? null : each * delivered.outputs + references
  }
  if (price.per === "output") return usdOf(price, delivered.outputs) + references
  const run = runUsd(model, params, inputs)
  return run === null ? null : run * delivered.runs
}
