import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStorageAdapter } from "../src/server/storage/adapter";
import { copilotTraceBatch, copilotVsCodeTraceBatch, copilotVsCodeTranscript, jsonlTranscript, otlpLogBatch, otlpMetricBatch } from "./fixtures";

function tmpDbPath() {
  return join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite");
}

let storage: DrizzleStorageAdapter | null = null;

afterEach(() => {
  storage?.close();
  storage = null;
});

describe("SQLite storage adapter", () => {
  it("dedupes OTLP batches and aggregates metrics", async () => {
    storage = new DrizzleStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));

    expect(await storage.ingestOtelMetrics(otlpMetricBatch())).toEqual({ duplicate: false, points: 3 });
    expect(await storage.ingestOtelMetrics(otlpMetricBatch())).toEqual({ duplicate: true, points: 0 });

    const summary = await storage.getSummary({});
    expect(summary.totalCost).toBe(0.024);
    expect(summary.inputTokens).toBe(1200);
    expect(summary.outputTokens).toBe(350);
    expect(summary.sessionCount).toBe(1);
  });

  it("returns inserted row ids as JS numbers, not bigint (Drizzle builder guard)", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    // insertRawBatch + insertMetricPoint + upsertSession all run through the Drizzle builder on ingest.
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));
    const sessions = await storage.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(typeof sessions[0].id).toBe("number");
    expect(Number.isInteger(sessions[0].id)).toBe(true);

    // createAuthToken (builder insert) + findAuthToken (builder select) must round-trip a number id.
    storage.createAuthToken("hash-1", "label", Date.now());
    const token = storage.findAuthToken("hash-1");
    expect(token).not.toBeNull();
    expect(typeof token!.id).toBe("number");
  });

  it("dedupes identical JSONL imports instead of double-counting", async () => {
    storage = new DrizzleStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
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
    storage = new DrizzleStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
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
    storage = new DrizzleStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
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
    storage = new DrizzleStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));

    expect(await storage.ingestOtelLogs(otlpLogBatch())).toEqual({ duplicate: false, events: 1 });
    const summary = await storage.getSummary({});
    expect(summary.totalTokens).toBe(0);
    expect(summary.totalCost).toBe(0);
  });

  it("ingests Copilot OTLP traces as source-specific token metrics", async () => {
    storage = new DrizzleStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));

    expect(await storage.ingestOtelTraces(copilotTraceBatch())).toMatchObject({ duplicate: false, spans: 2 });
    expect(await storage.ingestOtelTraces(copilotTraceBatch())).toEqual({ duplicate: true, spans: 0, points: 0 });

    const summary = await storage.getSummary({ source: "github-copilot" });
    expect(summary.inputTokens).toBe(1000);
    expect(summary.outputTokens).toBe(250);
    expect(summary.cacheReadTokens).toBe(100);
    expect(summary.sessionCount).toBe(1);

    const sessions = await storage.listSessions({});
    expect(sessions[0]).toMatchObject({ source: "github-copilot", sessionId: "copilot-session-1", totalTokens: 1350 });
  });

  it("serves filtered summaries and breakdowns from the rollup", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
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
    storage = new DrizzleStorageAdapter(tmpDbPath());
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

  it("answers mid-hour `from`/`to` windows from metric_points, not the hourly rollup", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    // One point at 00:30; the hourly rollup buckets it under 00:00. A `from` later than the top of
    // the hour must still see it (regression: a raw `bucket >= from` compare dropped the bucket).
    const content = '{"session_id":"s1","timestamp":"2024-01-01T00:30:00Z","message":{"usage":{"input_tokens":42}}}';
    await storage.importJsonl("manual-jsonl", {}, content);

    const at0015 = Date.parse("2024-01-01T00:15:00Z"); // mid-hour, after the 00:00 bucket start
    const within = await storage.getSummary({ from: at0015 });
    expect(within.inputTokens).toBe(42); // point at 00:30 is inside the window

    const at0045 = Date.parse("2024-01-01T00:45:00Z"); // mid-hour, after the point
    const after = await storage.getSummary({ from: at0045 });
    expect(after.inputTokens).toBe(0); // point at 00:30 is genuinely excluded
  });

  it("returns a per-model token and session timeseries", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    // Two sessions on the same model in the same hour bucket...
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));
    await storage.ingestOtelMetrics(otlpMetricBatch("session-b"));
    // ...plus a third session on a different model, in the same bucket.
    const opusBatch = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "session.id", value: { stringValue: "session-c" } },
              { key: "user.email", value: { stringValue: "dev@example.com" } },
              { key: "model", value: { stringValue: "claude-opus-4-1" } }
            ]
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  unit: "tokens",
                  sum: { dataPoints: [{ timeUnixNano: "1760000000000000000", asInt: "500", attributes: [{ key: "type", value: { stringValue: "input" } }] }] }
                }
              ]
            }
          ]
        }
      ]
    };
    await storage.ingestOtelMetrics(opusBatch);

    const series = await storage.getModelTimeseries({ granularity: "hour" });
    const byModel = new Map(series.map((row) => [row.model, row]));
    expect(byModel.size).toBe(2);
    // Both sonnet sessions land in one (bucket, model) row: tokens summed, sessions distinct-counted.
    expect(byModel.get("claude-sonnet-4-5")).toMatchObject({ totalTokens: 3100, sessions: 2 });
    expect(byModel.get("claude-opus-4-1")).toMatchObject({ totalTokens: 500, sessions: 1 });

    // Filtering by model narrows to that model's line.
    const onlyOpus = await storage.getModelTimeseries({ granularity: "hour", model: "claude-opus-4-1" });
    expect(onlyOpus).toHaveLength(1);
    expect(onlyOpus[0]).toMatchObject({ model: "claude-opus-4-1", totalTokens: 500, sessions: 1 });
  });

  it("does not double-count a session that has both OTel and a transcript in the per-model timeseries", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a")); // OTel: 1200 in / 350 out
    // Shadowed transcript for the same session/model — must not add a second session or extra tokens.
    await storage.importJsonl("claude-code-jsonl", { sessionId: "session-a" }, jsonlTranscript("session-a", { input_tokens: 999, output_tokens: 111 }, 0.5));

    const series = await storage.getModelTimeseries({ granularity: "hour" });
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ model: "claude-sonnet-4-5", totalTokens: 1550, sessions: 1 });
  });

  it("aggregates pull_request and commit counts into the summary and timeseries", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
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
    storage = new DrizzleStorageAdapter(tmpDbPath());
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

  it("links an uploaded transcript to the OTel session without double-counting", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));

    // Same session UUID, but the transcript reports different numbers (and a cost). OTel is
    // authoritative, so importing it must NOT change the totals.
    const content = jsonlTranscript("session-a", { input_tokens: 999, output_tokens: 111 }, 0.5);
    await storage.importJsonl("claude-code-jsonl", { sessionId: "session-a" }, content);

    const summary = await storage.getSummary({});
    expect(summary.inputTokens).toBe(1200);
    expect(summary.outputTokens).toBe(350);
    expect(summary.totalCost).toBe(0.024);
    expect(summary.sessionCount).toBe(1);

    // The transcript attaches to the OTel session row (source 'claude-code'), and the shadowed
    // jsonl twin is hidden from the default list — one row for the UUID, with the transcript.
    const sessionA = (await storage.listSessions({})).filter((s) => s.sessionId === "session-a");
    expect(sessionA).toHaveLength(1);
    expect(sessionA[0].source).toBe("claude-code");
    expect(sessionA[0].hasTranscript).toBe(true);
    expect((await storage.getSessionTranscript(sessionA[0].id))?.content).toBe(content);

    // The transcript-derived numbers are still retained under their own source for comparison.
    const otelOnly = await storage.getSummary({ source: "claude-code" });
    expect(otelOnly.inputTokens).toBe(1200);
    const jsonlOnly = await storage.getSummary({ source: "claude-code-jsonl" });
    expect(jsonlOnly.inputTokens).toBe(999);
    expect(jsonlOnly.outputTokens).toBe(111);

    const options = await storage.getFilterOptions();
    expect(options.sources).toEqual(expect.arrayContaining(["claude-code", "claude-code-jsonl"]));
  });

  it("links a VS Code Copilot transcript to the stable OTLP session id", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    await storage.ingestOtelTraces(copilotVsCodeTraceBatch("stable-vscode-session"));

    const content = copilotVsCodeTranscript("1e41a2d2-f8eb-4905-8434-111858d19287");
    await storage.importJsonl("copilot-vscode-jsonl", { sessionId: "1e41a2d2-f8eb-4905-8434-111858d19287" }, content, "copilot");

    const sessions = await storage.listSessions({});
    const stable = sessions.find((s) => s.sessionId === "stable-vscode-session");
    expect(stable).toBeDefined();
    expect(stable).toMatchObject({ source: "github-copilot", hasTranscript: true });
    expect(sessions.find((s) => s.sessionId === "1e41a2d2-f8eb-4905-8434-111858d19287")).toBeUndefined();
    expect((await storage.getSessionTranscript(stable!.id))?.content).toBe(content);
  });

  it("falls back to transcript-derived metrics for sessions with no OTel", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    await storage.importJsonl("claude-code-jsonl", { sessionId: "solo" }, jsonlTranscript("solo", { input_tokens: 40, output_tokens: 7 }, 0.01));

    const summary = await storage.getSummary({});
    expect(summary.inputTokens).toBe(40);
    expect(summary.outputTokens).toBe(7);
    expect(summary.totalCost).toBe(0.01);
    expect(summary.sessionCount).toBe(1);
    expect((await storage.listSessions({})).find((s) => s.sessionId === "solo")).toBeDefined();
  });

  it("mixes OTel and transcript-only sessions with per-session precedence", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a")); // OTel: 1200 in / 350 out / 0.024
    await storage.importJsonl("claude-code-jsonl", { sessionId: "session-a" }, jsonlTranscript("session-a", { input_tokens: 999, output_tokens: 111 }, 0.5)); // shadowed by OTel
    await storage.importJsonl("claude-code-jsonl", { sessionId: "solo" }, jsonlTranscript("solo", { input_tokens: 40, output_tokens: 7 }, 0.01)); // fallback

    const summary = await storage.getSummary({});
    expect(summary.inputTokens).toBe(1200 + 40);
    expect(summary.outputTokens).toBe(350 + 7);
    expect(summary.totalCost).toBeCloseTo(0.024 + 0.01, 6);
    expect(summary.sessionCount).toBe(2);

    // Timeseries (rollup path) must match the summary total — no double count there either.
    const series = await storage.getTimeseries({ granularity: "day" });
    expect(series.reduce((sum, p) => sum + p.inputTokens, 0)).toBe(1240);
  });

  it("demotes a transcript-only session's fallback metrics when OTel arrives later (late-OTel transition)", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    // Transcript first, no OTel yet: the transcript is the fallback and counts (is_primary=1).
    await storage.importJsonl("claude-code-jsonl", { sessionId: "session-a" }, jsonlTranscript("session-a", { input_tokens: 999, output_tokens: 111 }, 0.5));

    const before = await storage.getSummary({});
    expect(before.inputTokens).toBe(999);
    expect(before.outputTokens).toBe(111);
    expect(before.sessionCount).toBe(1);

    // OTel arrives for the SAME session: the transcript is now shadowed and must be demoted, and the
    // rollup rebuilt so it reflects only the OTel numbers.
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a")); // OTel: 1200 in / 350 out / 0.024

    // (a) the transcript is demoted — default totals equal the OTel numbers only.
    const after = await storage.getSummary({});
    expect(after.inputTokens).toBe(1200);
    expect(after.outputTokens).toBe(350);
    expect(after.totalCost).toBeCloseTo(0.024, 6);
    expect(after.sessionCount).toBe(1);

    // (b) the rollup is consistent — the (rollup-served) day timeseries total equals the summary total.
    const series = await storage.getTimeseries({ granularity: "day" });
    expect(series.reduce((sum, p) => sum + p.inputTokens, 0)).toBe(1200);

    // (c) the comparison view still shows the raw transcript numbers (the demoted points are retained).
    const comparison = await storage.getSummary({ source: "claude-code-jsonl" });
    expect(comparison.inputTokens).toBe(999);
    expect(comparison.outputTokens).toBe(111);
  });

  it("records explicit per-session source state (otel / jsonl / both) on one session row", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    // OTel-only session, JSONL-only session, and a session that has both signals.
    await storage.ingestOtelMetrics(otlpMetricBatch("otel-only"));
    await storage.importJsonl("claude-code-jsonl", { sessionId: "jsonl-only" }, jsonlTranscript("jsonl-only", { input_tokens: 5 }, 0.001));
    await storage.ingestOtelMetrics(otlpMetricBatch("both"));
    await storage.importJsonl("claude-code-jsonl", { sessionId: "both" }, jsonlTranscript("both", { input_tokens: 999 }, 0.5));

    const byId = new Map((await storage.listSessions({})).map((s) => [s.sessionId, s]));

    // Each UUID is exactly one session row (no per-source twins).
    expect(byId.size).toBe(3);

    const otel = byId.get("otel-only")!;
    expect(otel).toMatchObject({ hasOtel: true, hasJsonl: false, metricSource: "otel", source: "claude-code" });

    const jsonl = byId.get("jsonl-only")!;
    expect(jsonl).toMatchObject({ hasOtel: false, hasJsonl: true, metricSource: "jsonl", source: "claude-code-jsonl" });

    // Both signals present -> OTel is authoritative, but has_jsonl is still recorded for the UI.
    const both = byId.get("both")!;
    expect(both).toMatchObject({ hasOtel: true, hasJsonl: true, metricSource: "otel", source: "claude-code" });
    // The authoritative (OTel) numbers are shown, not the shadowed transcript's 999.
    expect(both.inputTokens).toBe(1200);

    // getSession resolves by id directly (not capped to the recent-100 list).
    expect((await storage.getSession(both.id))?.sessionId).toBe("both");
  });
});
