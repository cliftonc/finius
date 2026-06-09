// PostgreSQL backend regression tests. SKIPPED unless FINIUS_TEST_DATABASE_URL points at a reachable
// Postgres (a throwaway database — these TRUNCATE every table between tests). Run with e.g.:
//   FINIUS_TEST_DATABASE_URL=postgres://postgres:finius@localhost:55432/finius npm test
//
// vitest isolates test files in separate forked processes, so setting FINIUS_DATABASE_URL here (which
// the schema barrel + dialect read at module load to select the Postgres backend) does NOT affect the
// other, sqlite-backed test files. These cover the six PG-specific risk areas from the design: dedup via
// SQLSTATE 23505, the is_primary rebuild correlated UPDATE, json_extract Copilot session resolution, the
// incremental-vs-rebuilt rollup bucket agreement, LEAST/GREATEST upserts, and string_agg model lists.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleStorageAdapter } from "../src/server/storage/adapter";
import { codexLogBatch, codexRollout, copilotVsCodeTraceBatch, copilotVsCodeTranscript, jsonlTranscript, modelPrices, otlpMetricBatch } from "./fixtures";

const PG_URL = process.env.FINIUS_TEST_DATABASE_URL;

// Set BEFORE any server/db module loads so schema-active.ts + dialect.ts resolve the Postgres backend.
if (PG_URL) {
  process.env.FINIUS_DATABASE_URL = PG_URL;
  process.env.FINIUS_DB_BACKEND = "postgres";
  process.env.FINIUS_PRICING_FETCH = "off";
}

const TABLES = "metric_points, metric_rollup, source_files, sessions, users, raw_batches, log_events, auth_tokens, oauth_accounts, model_prices";

describe.skipIf(!PG_URL)("postgres backend", () => {
  let open: (typeof import("../src/server/storage/adapter"))["DrizzleStorageAdapter"]["open"];
  let pool: import("pg").Pool;
  let storage: DrizzleStorageAdapter;

  const freshAdapter = async (): Promise<DrizzleStorageAdapter> =>
    open({ backend: "postgres", url: PG_URL! }, { blob: new (await import("../src/server/storage/blob")).LocalBlobStore(mkdtempSync(join(tmpdir(), "finius-pg-blob-"))) });

  beforeAll(async () => {
    const adapterMod = await import("../src/server/storage/adapter");
    open = adapterMod.DrizzleStorageAdapter.open;
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: PG_URL });
    // Run migrations once (a fresh adapter open applies them; no-op thereafter).
    await (await freshAdapter()).close();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    storage = await freshAdapter();
  });

  afterEach(async () => {
    await storage.close();
  });

  it("ingests OTLP metrics and dedupes a repeat batch (SQLSTATE 23505)", async () => {
    const first = await storage.ingestOtelMetrics(otlpMetricBatch("pg-a"));
    expect(first).toEqual({ duplicate: false, points: 3 });
    const dup = await storage.ingestOtelMetrics(otlpMetricBatch("pg-a"));
    expect(dup).toEqual({ duplicate: true, points: 0 });

    const summary = await storage.getSummary({});
    expect(summary.totalTokens).toBe(1550); // 1200 input + 350 output
    expect(summary.totalCost).toBeCloseTo(0.024, 6);
    expect(summary.sessionCount).toBe(1);
    expect(summary.activeSenders).toBe(1);
  });

  it("synthesizes cost for a JSONL transcript (LEAST/GREATEST upserts + string_agg models)", async () => {
    await storage.importPricing(modelPrices());
    const result = await storage.importJsonl("claude-code-jsonl", { sessionId: "pg-b", userEmail: "dev@example.com" }, jsonlTranscript("pg-b"));
    expect(result.metricPoints).toBeGreaterThan(0);

    const people = await storage.listPeople({});
    expect(people).toHaveLength(1);
    expect(people[0].models).toContain("claude-sonnet-4-5"); // string_agg DISTINCT split back to an array
    expect(people[0].totalTokens).toBe(1110); // 999 + 111
    expect(people[0].totalCost).toBeGreaterThan(0); // computed cost (transcript carries none)
  });

  it("demotes a transcript when OTel arrives, and rebuildIsPrimary is consistent", async () => {
    // JSONL first (counts as fallback), then OTel for the same session (preferred → transcript shadowed).
    await storage.importJsonl("claude-code-jsonl", { sessionId: "pg-c" }, jsonlTranscript("pg-c"));
    await storage.ingestOtelMetrics(otlpMetricBatch("pg-c"));

    const primary = await storage.getSummary({});
    expect(primary.totalTokens).toBe(1550); // OTel wins; transcript (1110) shadowed → not summed

    // The comparison view (explicit source) still sees the raw transcript numbers.
    const comparison = await storage.getSummary({ source: "claude-code-jsonl" });
    expect(comparison.totalTokens).toBe(1110);

    // Whole-table rematerialize + rollup rebuild must not change the primary totals (idempotent repair).
    await storage.rebuildIsPrimary();
    const after = await storage.getSummary({});
    expect(after.totalTokens).toBe(primary.totalTokens);
    expect(after.totalCost).toBeCloseTo(primary.totalCost, 6);
  });

  it("resolves a Copilot transcript to its OTel session via json_extract", async () => {
    await storage.ingestOtelTraces(copilotVsCodeTraceBatch());
    const result = await storage.importJsonl("copilot-vscode-jsonl", {}, copilotVsCodeTranscript(), "copilot");
    expect(result.importedLines).toBeGreaterThan(0);
    // The transcript's chat session id matched an OTel metric point's copilot_chat.* attribute, so a
    // session row exists and carries the OTel tokens (proves dialect.jsonExtract works on jsonb).
    const sessions = await storage.listSessions({ source: "github-copilot" });
    expect(sessions.length).toBeGreaterThan(0);
  });

  it("rebuilds the rollup to match incremental upserts (bucket math agreement) and day-bucketing", async () => {
    await storage.ingestOtelMetrics(otlpMetricBatch("pg-d"));
    const incremental = await storage.getSummary({}); // served from metric_rollup (incremental upserts)

    await storage.rebuildIsPrimary(); // wholesale rebuildRollup via the dialect bucket expression
    const rebuilt = await storage.getSummary({});
    expect(rebuilt.totalTokens).toBe(incremental.totalTokens);

    const daily = await storage.getTimeseries({ granularity: "day" });
    expect(daily.length).toBeGreaterThan(0);
    expect(daily.reduce((sum, p) => sum + p.totalTokens, 0)).toBe(incremental.totalTokens);
  });

  it("groups log events with the most-recent sample (window functions)", async () => {
    await storage.ingestOtelLogs(codexLogBatch());
    const events = await storage.getLogEventSummary();
    const byName = Object.fromEntries(events.map((e) => [e.eventName, e]));
    expect(byName["codex.sse_event"].count).toBe(2); // numeric, not a bigint string
    expect(byName["codex.sse_event"].sample).not.toBeNull();
  });

  it("imports a Codex rollout (replace-by-session) and counts it as primary", async () => {
    await storage.importPricing(modelPrices());
    await storage.importJsonl("codex-cli-jsonl", { sessionId: "pg-codex" }, codexRollout("pg-codex"), "codex");
    const summary = await storage.getSummary({});
    expect(summary.totalTokens).toBeGreaterThan(0);
    expect(summary.totalCost).toBeGreaterThan(0); // synthesized; Codex never reports cost
  });
});
