import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorageAdapter } from "../src/server/storage/sqlite";
import { otlpLogBatch, otlpMetricBatch } from "./fixtures";

function tmpDbPath() {
  return join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite");
}

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
    const content = '{"session_id":"s1","message":{"usage":{"input_tokens":100,"output_tokens":20}}}';

    const first = await storage.importJsonl("manual-jsonl", {}, content);
    expect(first.duplicate).toBeFalsy();
    expect(first.metricPoints).toBe(2);

    const second = await storage.importJsonl("manual-jsonl", {}, content);
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

  it("serves filtered summaries and breakdowns from the rollup", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));
    await storage.ingestOtelMetrics(otlpMetricBatch("session-b"));

    // user/model/source filters all map onto the rollup's WHERE.
    const byUser = await storage.getSummary({ user: "dev@example.com" });
    expect(byUser.inputTokens).toBe(2400);
    expect(byUser.totalCost).toBeCloseTo(0.048, 6);
    expect(byUser.sessionCount).toBe(2);

    const byModel = await storage.getSummary({ model: "claude-sonnet-4-5" });
    expect(byModel.outputTokens).toBe(700);

    // A non-matching filter yields zeros, not the unfiltered totals.
    const miss = await storage.getSummary({ user: "nobody@example.com" });
    expect(miss.totalTokens).toBe(0);
    expect(miss.sessionCount).toBe(0);

    // Breakdown cost/tokens come from the rollup; per-group session counts from metric_points.
    expect(byUser.models[0]).toMatchObject({ model: "claude-sonnet-4-5", sessions: 2 });
    expect(byUser.sources[0]).toMatchObject({ source: "claude-code", sessions: 2 });
  });

  it("sums across hourly buckets but counts distinct sessions correctly", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    // Same session, two timestamps five hours apart -> two hourly rollup buckets, one session.
    const content = [
      '{"session_id":"s1","timestamp":"2024-01-01T00:30:00Z","message":{"usage":{"input_tokens":10}}}',
      '{"session_id":"s1","timestamp":"2024-01-01T05:30:00Z","message":{"usage":{"input_tokens":20}}}'
    ].join("\n");
    await storage.importJsonl("manual-jsonl", {}, content);

    const summary = await storage.getSummary({});
    expect(summary.inputTokens).toBe(30); // summed across buckets from the rollup
    expect(summary.sessionCount).toBe(1); // distinct count from metric_points, not summed

    const hourly = await storage.getTimeseries({ granularity: "hour" });
    expect(hourly).toHaveLength(2);
    expect(hourly.map((b) => b.inputTokens)).toEqual([10, 20]);

    // Sub-hour granularity falls back to metric_points but yields the same totals.
    const fine = await storage.getTimeseries({ granularity: "minute" });
    expect(fine.reduce((sum, b) => sum + b.inputTokens, 0)).toBe(30);
  });

  it("aggregates pull_request and commit counts into the summary and timeseries", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    const batch = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "session.id", value: { stringValue: "sc" } }] },
          scopeMetrics: [
            {
              metrics: [
                { name: "claude_code.pull_request.count", sum: { dataPoints: [{ timeUnixNano: "1760000000000000000", asInt: "2", attributes: [] }] } },
                { name: "claude_code.commit.count", sum: { dataPoints: [{ timeUnixNano: "1760000000000000000", asInt: "5", attributes: [] }] } }
              ]
            }
          ]
        }
      ]
    };
    await storage.ingestOtelMetrics(batch);

    const summary = await storage.getSummary({});
    expect(summary.pullRequests).toBe(2);
    expect(summary.commits).toBe(5);

    const hourly = await storage.getTimeseries({ granularity: "hour" });
    const bucket = hourly.find((b) => b.pullRequests > 0 || b.commits > 0);
    expect(bucket).toMatchObject({ pullRequests: 2, commits: 5 });
  });

  it("stores an imported transcript as a file linked to its session", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    const content =
      '{"session_id":"s1","message":{"usage":{"input_tokens":100,"output_tokens":20}}}\n' +
      '{"session_id":"s1","message":{"usage":{"input_tokens":5}}}';

    const result = await storage.importJsonl("manual-jsonl", { sessionId: "s1" }, content);
    expect(result.duplicate).toBeFalsy();

    const sessions = await storage.listSessions({});
    const session = sessions.find((s) => s.sessionId === "s1");
    expect(session).toBeDefined();

    const transcript = await storage.getSessionTranscript(session!.id);
    expect(transcript?.content).toBe(content);
    expect(transcript?.source).toBe("manual-jsonl");

    // Re-importing the identical file dedupes via the content hash.
    const again = await storage.importJsonl("manual-jsonl", { sessionId: "s1" }, content);
    expect(again.duplicate).toBe(true);

    // Sessions with no stored transcript return null.
    expect(await storage.getSessionTranscript(999_999)).toBeNull();
  });

  it("migrates a legacy database: drops raw_events and backfills the rollup", async () => {
    const path = tmpDbPath();
    // Hand-build a pre-rollup database (schema version 1, with a raw_events table and points).
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE raw_events (id INTEGER PRIMARY KEY, event_json TEXT);
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, session_id TEXT NOT NULL,
        user_id TEXT, user_email TEXT, user_account_id TEXT,
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, UNIQUE(source, session_id)
      );
      CREATE TABLE metric_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, signal TEXT NOT NULL,
        session_row_id INTEGER NOT NULL, session_id TEXT NOT NULL, user_id TEXT, user_email TEXT,
        user_account_id TEXT, model TEXT, metric_name TEXT NOT NULL, kind TEXT NOT NULL,
        token_type TEXT, value REAL NOT NULL, unit TEXT, timestamp INTEGER NOT NULL,
        attributes_json TEXT, raw_batch_id INTEGER, raw_event_id INTEGER
      );
      INSERT INTO sessions (source, session_id, user_email, first_seen_at, last_seen_at)
        VALUES ('claude-code', 's1', 'dev@example.com', 1700000000000, 1700000000000);
      INSERT INTO metric_points (source, signal, session_row_id, session_id, user_email, model, metric_name, kind, token_type, value, timestamp)
        VALUES ('claude-code', 'otlp_metrics', 1, 's1', 'dev@example.com', 'claude-sonnet-4-5', 'claude_code.token.usage', 'tokens', 'input', 500, 1700000000000);
      INSERT INTO raw_events (event_json) VALUES ('{"legacy":true}');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    storage = new SqliteStorageAdapter(path);
    const summary = await storage.getSummary({}); // served from the freshly-backfilled rollup
    expect(summary.inputTokens).toBe(500);

    const probe = new DatabaseSync(path);
    const { user_version } = probe.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(user_version).toBe(2);
    const tables = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("metric_rollup");
    expect(tables).not.toContain("raw_events");
    const { n } = probe.prepare("SELECT COUNT(*) AS n FROM metric_rollup").get() as { n: number };
    expect(n).toBeGreaterThan(0);
    probe.close();
  });
});
