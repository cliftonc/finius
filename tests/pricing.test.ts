import { describe, expect, it } from "vitest";
import { computeCostPoints, indexPrices, normalizeLiteLlm, priceFor, COMPUTED_COST_METRIC } from "../src/server/pricing.js";
import type { MetricPointInput, ModelPrice } from "../src/server/types.js";
import { litellmFeed } from "./fixtures.js";

function tokenPoint(model: string, tokenType: string, value: number, timestamp = 1000): MetricPointInput {
  return { source: "codex-cli-jsonl", signal: "jsonl", sessionId: "s", model, metricName: "codex.token.usage", kind: "tokens", tokenType, value, timestamp };
}

describe("normalizeLiteLlm", () => {
  const prices = normalizeLiteLlm(litellmFeed(), 1000);
  const byModel = new Map(prices.map((p) => [p.model, p]));

  it("drops the sample_spec sentinel and rate-less entries", () => {
    expect(byModel.has("sample_spec")).toBe(false);
    expect(byModel.has("whisper-1")).toBe(false); // no token rates
  });

  it("maps the four token rates and the provider", () => {
    const claude = byModel.get("claude-sonnet-4-5-20250929")!;
    expect(claude).toMatchObject({
      provider: "anthropic",
      inputPerToken: 0.000003,
      outputPerToken: 0.000015,
      cacheReadPerToken: 0.0000003,
      cacheCreationPerToken: 0.00000375,
      effectiveDate: 1000
    });
  });

  it("falls back to the input rate when a cache cost is missing", () => {
    const codex = byModel.get("gpt-5.1-codex")!;
    expect(codex.cacheReadPerToken).toBe(codex.inputPerToken); // feed had no cache-read cost
    expect(codex.cacheCreationPerToken).toBe(codex.inputPerToken);
  });
});

describe("priceFor", () => {
  const index = indexPrices(normalizeLiteLlm(litellmFeed(), 1000));

  it("matches a dated feed key from an undated reported model id", () => {
    expect(priceFor("claude-sonnet-4-5", 2000, index)?.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("matches a dated reported id by stripping the date suffix", () => {
    expect(priceFor("claude-sonnet-4-5-20991231", 2000, index)?.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("returns undefined for an unknown model (never throws)", () => {
    expect(priceFor("totally-unknown-model", 2000, index)).toBeUndefined();
    expect(priceFor(null, 2000, index)).toBeUndefined();
  });

  it("picks the newest rate whose effectiveDate is at or before the usage time", () => {
    const dated: ModelPrice[] = [
      { model: "m", provider: null, inputPerToken: 1, outputPerToken: 0, cacheReadPerToken: 0, cacheCreationPerToken: 0, effectiveDate: 100 },
      { model: "m", provider: null, inputPerToken: 2, outputPerToken: 0, cacheReadPerToken: 0, cacheCreationPerToken: 0, effectiveDate: 500 }
    ];
    const idx = indexPrices(dated);
    expect(priceFor("m", 300, idx)?.inputPerToken).toBe(1); // 500 not yet in effect at t=300
    expect(priceFor("m", 600, idx)?.inputPerToken).toBe(2);
    expect(priceFor("m", 50, idx)?.inputPerToken).toBe(1); // before any rate -> oldest known
  });
});

describe("computeCostPoints", () => {
  const index = indexPrices(normalizeLiteLlm(litellmFeed(), 0));

  it("prices each token type and emits a COMPUTED_COST_METRIC cost point", () => {
    const points = computeCostPoints([tokenPoint("gpt-5.1-codex", "input", 1000), tokenPoint("gpt-5.1-codex", "output", 300)], index);
    expect(points).toHaveLength(2);
    expect(points.every((p) => p.kind === "cost" && p.metricName === COMPUTED_COST_METRIC && p.unit === "USD")).toBe(true);
    const total = points.reduce((n, p) => n + p.value, 0);
    expect(total).toBeCloseTo(1000 * 0.00000125 + 300 * 0.00001, 12);
  });

  it("copies signal/source/session/model/timestamp from the token point", () => {
    const [cost] = computeCostPoints([tokenPoint("gpt-5.1-codex", "input", 1000, 4242)], index);
    expect(cost).toMatchObject({ source: "codex-cli-jsonl", signal: "jsonl", sessionId: "s", model: "gpt-5.1-codex", timestamp: 4242 });
  });

  it("skips the 'total' token type and unknown models (no double counting / no throw)", () => {
    expect(computeCostPoints([tokenPoint("gpt-5.1-codex", "total", 999)], index)).toHaveLength(0);
    expect(computeCostPoints([tokenPoint("unknown-model", "input", 999)], index)).toHaveLength(0);
  });
});
