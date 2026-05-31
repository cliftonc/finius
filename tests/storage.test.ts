import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorageAdapter } from "../src/server/storage/sqlite";
import { otlpLogBatch, otlpMetricBatch } from "./fixtures";

let storage: SqliteStorageAdapter | null = null;

afterEach(() => {
  storage?.close();
  storage = null;
});

describe("SQLite storage adapter", () => {
  it("dedupes OTLP batches and aggregates metrics", async () => {
    storage = new SqliteStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));

    expect(await storage.ingestOtelMetrics(otlpMetricBatch())).toEqual({ duplicate: false, points: 3 });
    expect(await storage.ingestOtelMetrics(otlpMetricBatch())).toEqual({ duplicate: true, points: 0 });

    const summary = await storage.getSummary({});
    expect(summary.totalCost).toBe(0.024);
    expect(summary.inputTokens).toBe(1200);
    expect(summary.outputTokens).toBe(350);
    expect(summary.sessionCount).toBe(1);
  });

  it("dedupes identical JSONL imports instead of double-counting", async () => {
    storage = new SqliteStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    const lines = ['{"session_id":"s1","message":{"usage":{"input_tokens":100,"output_tokens":20}}}'];

    const first = await storage.importJsonl("manual-jsonl", {}, lines);
    expect(first.duplicate).toBeFalsy();
    expect(first.metricPoints).toBe(2);

    const second = await storage.importJsonl("manual-jsonl", {}, lines);
    expect(second.duplicate).toBe(true);
    expect(second.metricPoints).toBe(0);

    const summary = await storage.getSummary({});
    expect(summary.inputTokens).toBe(100);
    expect(summary.outputTokens).toBe(20);
  });

  it("aggregates people and exposes filter options", async () => {
    storage = new SqliteStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));

    const people = await storage.listPeople({});
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ user: "dev@example.com", sessions: 1, inputTokens: 1200, outputTokens: 350, totalCost: 0.024 });
    expect(people[0].models).toEqual(["claude-sonnet-4-5"]);

    const options = await storage.getFilterOptions();
    expect(options.sources).toEqual(["claude-code"]);
    expect(options.users).toEqual(["dev@example.com"]);
    expect(options.models).toEqual(["claude-sonnet-4-5"]);
  });

  it("aggregates models and filters summaries by session", async () => {
    storage = new SqliteStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));
    await storage.ingestOtelMetrics(otlpMetricBatch("session-b"));

    const models = await storage.listModels({});
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model: "claude-sonnet-4-5", sessions: 2, users: 1, inputTokens: 2400, totalCost: 0.048 });

    const sessions = await storage.listSessions({});
    const one = sessions[0];
    const scoped = await storage.getSummary({ session: one.id });
    expect(scoped.sessionCount).toBe(1);
    expect(scoped.inputTokens).toBe(1200);
    expect(scoped.totalCost).toBe(0.024);
  });

  it("stores OTLP logs without creating metric points", async () => {
    storage = new SqliteStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));

    expect(await storage.ingestOtelLogs(otlpLogBatch())).toEqual({ duplicate: false, events: 1 });
    const summary = await storage.getSummary({});
    expect(summary.totalTokens).toBe(0);
    expect(summary.totalCost).toBe(0);
  });
});
