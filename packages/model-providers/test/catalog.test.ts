import { describe, expect, it } from "vite-plus/test"

import { controlsOf, costOf, models, priceOf, quoteOf, usdOf } from "../src/index.ts"

describe("usd", () => {
  it("converts a CNY rate at the pinned rate and multiplies by units", () => {
    expect(usdOf({ amount: 7.2, currency: "CNY" })).toBe(1)
    expect(usdOf({ amount: 0.1, currency: "USD" }, 5)).toBeCloseTo(0.5)
  })
})

describe("catalog", () => {
  it("names every model once, because prices and records key on the name", () => {
    const names = models.map((model) => model.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("identifies every model once by its API id per provider", () => {
    const ids = models.map((model) => `${model.provider}/${model.id}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("keeps every default inside the values its control offers", () => {
    for (const model of models) {
      for (const control of controlsOf(model.params)) {
        const where = `${model.name} › ${control.key}`
        if ("options" in control)
          expect(control.options as unknown[], where).toContain(control.default)
        if ("min" in control) {
          expect(control.default, where).toBeGreaterThanOrEqual(control.min)
          expect(control.default, where).toBeLessThanOrEqual(control.max)
        }
      }
    }
  })

  it("keys every rate table on a control the model has, and every rate on one of its values", () => {
    for (const model of models) {
      for (const rates of [model.price?.rates, model.price?.videoIn]) {
        if (!rates || !("by" in rates)) continue
        const spec = model.params[rates.by]
        expect(spec, model.name).toBeDefined()
        for (const value of Object.keys(rates.rates)) {
          expect(spec!.options as readonly string[], model.name).toContain(value)
        }
      }
    }
  })
})

const named = (name: string) => models.find((model) => model.name === name)!
const cny = (amount: number) => amount / 7.2

describe("price", () => {
  it("quotes every image a request asks for", () => {
    const quote = quoteOf(named("GPT Image 2"), { quality: "medium", count: 3 }, 1)
    expect(quote.usd).toBeCloseTo(0.159)
  })

  it("quotes a decomposition for the layers asked for, and costs the layers delivered", () => {
    const layers = named("Seedream 5.5 Layers")
    const params = { resolution: "2K", layers: 10 } as const
    const source = { images: 1, videoIn: false }
    expect(quoteOf(layers, params, 1, source).usd).toBeCloseTo(cny(10 * 0.23 + 0.05))
    expect(costOf(layers, params, { runs: 1, outputs: 4 }, source)).toBeCloseTo(
      cny(4 * 0.23 + 0.05)
    )
  })

  it("bills Midjourney per task, whatever it delivers", () => {
    expect(costOf(named("Midjourney"), {}, { runs: 1, outputs: 4 })).toBeCloseTo(cny(0.15))
  })

  it("quotes a Seedance clip by its estimated tokens, and costs what Ark reports", () => {
    const seedance = named("Seedance 2.5")
    const params = { resolution: "480p", duration: 5 } as const
    expect(quoteOf(seedance, params, 1).usd).toBeCloseTo(cny((50_639 * 70) / 1_000_000))
    expect(costOf(seedance, params, { runs: 1, outputs: 1, tokens: 60_000 })).toBeCloseTo(
      cny((60_000 * 70) / 1_000_000)
    )
  })

  it("leaves a run that sends video in unquoted, and costs it at the video-in rate", () => {
    const seedance = named("Seedance 2.5")
    const params = { resolution: "1080p", duration: 5 } as const
    const clip = { images: 0, videoIn: true }
    expect(quoteOf(seedance, params, 1, clip)).toEqual({
      usd: null,
      price: { amount: 46, currency: "CNY", per: "million-tokens" },
    })
    expect(costOf(seedance, params, { runs: 1, outputs: 1, tokens: 100_000 }, clip)).toBeCloseTo(
      cny((100_000 * 46) / 1_000_000)
    )
  })

  it("keeps Seedance 2.0 Fast and Mini at their own published rates", () => {
    const rate = (name: string) => priceOf(named(name), { resolution: "720p" })?.amount
    expect([rate("Seedance 2.0 Fast"), rate("Seedance 2.0 Mini")]).toEqual([37, 23])
  })
})
