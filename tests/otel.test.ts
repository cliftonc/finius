import { describe, expect, it } from "vitest";
import {
  otelTraceSessionDiagnostics,
  parseOtelLogRecords,
  parseOtelMetricPoints,
  parseOtelMetricRecords,
  parseOtelTracePoints,
  parseOtelTraceRecords,
  preferredIdentity
} from "../src/server/otel";
import { parseTranscript, detectTranscriptFormat } from "../src/server/transcripts";
import { copilotTraceBatch, copilotVsCodeTraceBatch, copilotVsCodeTranscript, codexLogBatch, otlpMetricBatch } from "./fixtures";

describe("OTLP parser", () => {
  it("extracts Claude Code token and cost metrics", () => {
    const points = parseOtelMetricPoints(otlpMetricBatch());

    expect(points).toHaveLength(3);
    expect(points.map((point) => point.kind)).toEqual(["tokens", "tokens", "cost"]);
    expect(points[0]).toMatchObject({
      sessionId: "session-a",
      userEmail: "dev@example.com",
      model: "claude-sonnet-4-5",
      tokenType: "input",
      value: 1200
    });
  });

  it("captures every metric data point (not just token/cost) for the raw log", () => {
    const records = parseOtelMetricRecords(otlpMetricBatch());
    // token.usage (2 points) + cost.usage (1) + ignored.metric (1) = 4 raw records
    expect(records).toHaveLength(4);
    expect(records.map((record) => record.metricName)).toContain("ignored.metric");
    const input = records.find((record) => record.attributes.type === "input");
    expect(input).toMatchObject({ metricName: "claude_code.token.usage", value: 1200, kind: "sum" });
  });

  it("normalizes camelCase cache token types", () => {
    const batch = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "session.id", value: { stringValue: "s1" } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: {
                    dataPoints: [
                      { asInt: "5", attributes: [{ key: "type", value: { stringValue: "cacheCreation" } }] },
                      { asInt: "7", attributes: [{ key: "type", value: { stringValue: "cacheRead" } }] }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    };

    const points = parseOtelMetricPoints(batch);
    expect(points.map((point) => point.tokenType)).toEqual(["cache_creation", "cache_read"]);
  });

  it("classifies session/pull_request/commit counts", () => {
    const batch = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "session.id", value: { stringValue: "s1" } }] },
          scopeMetrics: [
            {
              metrics: [
                { name: "claude_code.session.count", sum: { dataPoints: [{ asInt: "1", attributes: [{ key: "start_type", value: { stringValue: "fresh" } }] }] } },
                { name: "claude_code.pull_request.count", sum: { dataPoints: [{ asInt: "2", attributes: [] }] } },
                { name: "claude_code.commit.count", sum: { dataPoints: [{ asInt: "3", attributes: [] }] } }
              ]
            }
          ]
        }
      ]
    };

    const points = parseOtelMetricPoints(batch);
    expect(points.map((p) => [p.kind, p.tokenType, p.value])).toEqual([
      ["session", "fresh", 1],
      ["pull_request", null, 2],
      ["commit", null, 3]
    ]);
  });

  it("resolves a log record's event name from the event.name attribute over Codex's source-location eventName", () => {
    // Codex's tracing appender pollutes the top-level eventName with a Rust source location and carries
    // the real id in the event.name attribute, so the attribute must win.
    const records = parseOtelLogRecords(codexLogBatch());
    expect(records.map((r) => r.eventName)).toEqual(["codex.sse_event", "codex.api_request", "codex.sse_event"]);
    expect(records[0].sessionId).toBe("codex-session-1");
  });

  it("extracts Copilot token usage from invoke_agent trace spans without double-counting child chat spans", () => {
    const records = parseOtelTraceRecords(copilotTraceBatch());
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ source: "github-copilot", name: "invoke_agent copilotcli" });

    const points = parseOtelTracePoints(copilotTraceBatch());
    expect(points.map((p) => [p.source, p.sessionId, p.model, p.tokenType, p.value])).toEqual([
      ["github-copilot", "copilot-session-1", "gpt-5-mini", "input", 1000],
      ["github-copilot", "copilot-session-1", "gpt-5-mini", "output", 250],
      ["github-copilot", "copilot-session-1", "gpt-5-mini", "cache_read", 100]
    ]);
  });

  it("groups VS Code Copilot spans by the stable resource session id", () => {
    const points = parseOtelTracePoints(copilotVsCodeTraceBatch());

    expect(new Set(points.map((p) => p.sessionId))).toEqual(new Set(["vscode-window-session"]));
    expect(points.map((p) => [p.model, p.tokenType, p.value])).toEqual([
      ["oswe-vscode-prime", "input", 30000],
      ["oswe-vscode-prime", "output", 4800],
      ["gpt-4o-mini-2024-07-18", "input", 260],
      ["gpt-4o-mini-2024-07-18", "output", 66]
    ]);

    expect(otelTraceSessionDiagnostics(copilotVsCodeTraceBatch()).map((span) => [span.selectedSessionId, span.sessionId, span.genAiConversationId])).toEqual([
      ["vscode-window-session", "vscode-window-session", "1e41a2d2-f8eb-4905-8434-111858d19287"],
      ["vscode-window-session", "vscode-window-session", "10ec3be6-89f1-4bb1-90ff-01234591ed3c"]
    ]);
  });

  it("parses VS Code Copilot transcripts as a session marker without token metrics", () => {
    const lines = copilotVsCodeTranscript("copilot-chat-session").split(/\n/);
    expect(detectTranscriptFormat(lines)).toBe("copilot");

    const parsed = parseTranscript("copilot", "copilot-vscode-jsonl", { sessionId: "stable-vscode-session" }, lines);
    expect(parsed.result).toMatchObject({ importedLines: 3, malformedLines: 0, metricPoints: 1, rawEvents: 3 });
    expect(parsed.points).toEqual([
      expect.objectContaining({
        source: "copilot-vscode-jsonl",
        sessionId: "stable-vscode-session",
        metricName: "copilot.chat.session",
        kind: "session",
        tokenType: "transcript",
        value: 1
      })
    ]);
  });

  it("prefers email, account id, then user id for identity", () => {
    expect(preferredIdentity({ userEmail: "a@example.com", userAccountId: "acct", userId: "user" })).toBe("a@example.com");
    expect(preferredIdentity({ userEmail: null, userAccountId: "acct", userId: "user" })).toBe("acct");
    expect(preferredIdentity({ userEmail: null, userAccountId: null, userId: "user" })).toBe("user");
  });
});
