import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStorageAdapter } from "../src/server/storage/adapter";
import { codexLogBatch, codexRollout, jsonlTranscript, modelPrices, otlpMetricBatch } from "./fixtures";

function tmpDbPath() {
  return join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite");
}

let storage: DrizzleStorageAdapter | null = null;

afterEach(() => {
  storage?.close();
  storage = null;
});

// gpt-5.1-codex rates: input 1.25e-6, cache_read 1.25e-7, output 1e-5.
// codexRollout: 1000 input (200 cached) / 300 output -> 800 fresh input, 200 cache_read, 300 output.
const CODEX_COST = 800 * 0.00000125 + 200 * 0.000000125 + 300 * 0.00001; // 0.004025

describe("computed cost (pricing synthesis)", () => {
  it("synthesizes cost for a Codex transcript that reports none", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());

    // Without pricing loaded, Codex usage has no cost (default, pre-feature behavior).
    await storage.importJsonl("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout(), "codex");
    expect((await storage.getSummary({})).totalCost).toBe(0);

    // Load pricing and recompute -> cost appears, derived from the existing token points.
    await storage.importPricing(modelPrices());
    const { costPoints } = await storage.recomputeComputedCost();
    expect(costPoints).toBe(3); // input, cache_read, output

    const summary = await storage.getSummary({});
    expect(summary.totalCost).toBeCloseTo(CODEX_COST, 9);
    expect(summary.inputTokens).toBe(800);
  });

  it("computes cost on import once pricing is already loaded", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());
    await storage.importPricing(modelPrices());
    await storage.importJsonl("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout(), "codex");

    expect((await storage.getSummary({})).totalCost).toBeCloseTo(CODEX_COST, 9);
  });

  it("does not stack computed cost on a session that already has authoritative OTel cost", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());
    await storage.importPricing(modelPrices());

    // OTel session-a reports a real cost (0.024). Its transcript reports NO cost -> we'd synthesize,
    // but jsonlWins must shadow that synthesized JSONL cost. Total stays the OTel cost, not the sum.
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));
    await storage.importJsonl("claude-code-jsonl", { sessionId: "session-a" }, jsonlTranscript("session-a", { input_tokens: 999, output_tokens: 111 }));

    const summary = await storage.getSummary({});
    expect(summary.totalCost).toBe(0.024);

    // The shadowed JSONL source still carries its own computed cost for the comparison view.
    const jsonlOnly = await storage.getSummary({ source: "claude-code-jsonl" });
    expect(jsonlOnly.totalCost).toBeGreaterThan(0);
  });

  it("recomputeComputedCost is idempotent", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());
    await storage.importPricing(modelPrices());
    await storage.importJsonl("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout(), "codex");

    const first = (await storage.getSummary({})).totalCost;
    await storage.recomputeComputedCost();
    await storage.recomputeComputedCost();
    expect((await storage.getSummary({})).totalCost).toBeCloseTo(first, 9);
  });

  it("survives a restart: pricing persists and reloads from the DB", async () => {
    const path = tmpDbPath();
    storage = await DrizzleStorageAdapter.open(path);
    await storage.importPricing(modelPrices());
    storage.close();

    // Reopen the same DB; pricing is loaded from model_prices in the constructor.
    storage = await DrizzleStorageAdapter.open(path);
    expect((await storage.getPricing()).length).toBe(modelPrices().length);
    await storage.importJsonl("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout(), "codex");
    expect((await storage.getSummary({})).totalCost).toBeCloseTo(CODEX_COST, 9);
  });
});

describe("queued JSONL processing", () => {
  it("enqueues uploads, processes them on the queue, and surfaces data after settle", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());
    await storage.importPricing(modelPrices());

    const queued = await storage.enqueueImport("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout(), "codex");
    expect(queued).toEqual({ duplicate: false, queued: true });

    await storage.settleIngest();
    expect((await storage.getSummary({})).totalCost).toBeCloseTo(CODEX_COST, 9);
  });

  it("dedupes a re-upload (in-flight and once persisted)", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());
    await storage.enqueueImport("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout(), "codex");
    await storage.settleIngest();
    // Same content again -> deduped on the persisted source_files hash.
    expect(await storage.enqueueImport("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout(), "codex")).toEqual({
      duplicate: true,
      queued: false
    });
  });
});

describe("historical pricing backfill", () => {
  it("fetches the price in effect on a past usage date and prices it with that rate", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());
    // Current pricing is effective 2026-06-15; the Codex usage is on 2026-05-31 (before it).
    await storage.importPricing([
      { model: "gpt-5.1-codex", provider: "openai", inputPerToken: 0.00000125, outputPerToken: 0.00001, cacheReadPerToken: 0.000000125, cacheCreationPerToken: 0.00000125, effectiveDate: Date.parse("2026-06-15") }
    ]);

    const requested: string[] = [];
    // Historical rate (double the current one) so we can prove the historical price was used.
    storage.setHistoricalPriceFetcher(async (dayIso) => {
      requested.push(dayIso);
      return [
        { model: "gpt-5.1-codex", provider: "openai", inputPerToken: 0.0000025, outputPerToken: 0.00002, cacheReadPerToken: 0.00000025, cacheCreationPerToken: 0.0000025, effectiveDate: Date.parse(dayIso) }
      ];
    });

    await storage.importJsonl("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout(), "codex");

    expect(requested).toEqual(["2026-05-31"]);
    const expected = 800 * 0.0000025 + 200 * 0.00000025 + 300 * 0.00002; // 0.00805
    expect((await storage.getSummary({})).totalCost).toBeCloseTo(expected, 9);
  });

  it("fetches each missing day at most once across imports", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());
    await storage.importPricing([
      { model: "gpt-5.1-codex", provider: "openai", inputPerToken: 0.00000125, outputPerToken: 0.00001, cacheReadPerToken: 0.000000125, cacheCreationPerToken: 0.00000125, effectiveDate: Date.parse("2026-06-15") }
    ]);
    let calls = 0;
    storage.setHistoricalPriceFetcher(async (dayIso) => {
      calls++;
      return [{ model: "gpt-5.1-codex", provider: "openai", inputPerToken: 0.0000025, outputPerToken: 0.00002, cacheReadPerToken: 0.00000025, cacheCreationPerToken: 0.0000025, effectiveDate: Date.parse(dayIso) }];
    });

    // Two different sessions, same usage date -> the day is fetched only once.
    await storage.importJsonl("codex-cli-jsonl", { sessionId: "codex-session-1" }, codexRollout("codex-session-1"), "codex");
    await storage.importJsonl("codex-cli-jsonl", { sessionId: "codex-session-2" }, codexRollout("codex-session-2"), "codex");
    expect(calls).toBe(1);
  });
});

describe("OTLP log capture", () => {
  it("indexes log records by the event.name attribute (not Codex's source-location eventName), without creating metric points", async () => {
    storage = await DrizzleStorageAdapter.open(tmpDbPath());

    expect(await storage.ingestOtelLogs(codexLogBatch())).toEqual({ duplicate: false, events: 3 });
    // Re-ingesting the identical batch dedupes on the raw_batches hash.
    expect(await storage.ingestOtelLogs(codexLogBatch())).toEqual({ duplicate: true, events: 0 });

    const events = await storage.getLogEventSummary();
    const byName = new Map(events.map((e) => [e.eventName, e]));
    // Resolved from the `event.name` attribute even though the top-level eventName is a source location.
    expect(byName.get("codex.sse_event")?.count).toBe(2);
    expect(byName.get("codex.api_request")?.count).toBe(1);
    expect(byName.has("event otel/src/events/session_telemetry.rs:778")).toBe(false);
    expect(byName.get("codex.sse_event")?.sample?.attributes["session.id"]).toBe("codex-session-1");

    // Codex tokens/cost come from the rollout-JSONL path; the logs-only OTel is inspection-only.
    expect((await storage.getSummary({})).totalTokens).toBe(0);
  });
});
