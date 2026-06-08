import { describe, expect, it } from "vitest";
import { parseCodexTranscript } from "../src/server/providers/codex.js";
import { detectTranscriptFormat, parseTranscript, shouldReplaceBySession } from "../src/server/transcripts.js";
import type { MetricPointInput } from "../src/server/types.js";

const SESSION = "019e7c75-430d-78c3-a9ff-0249cd838c43";

function jl(obj: unknown): string {
  return JSON.stringify(obj);
}

function tokenCount(total: Record<string, number>, last: Record<string, number>, ts: string): string {
  return jl({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } }
  });
}

// total_token_usage is CUMULATIVE; one duplicate emit (delta 0) plus two real turns.
const ROLLOUT = [
  jl({ timestamp: "2026-05-31T07:15:20.000Z", type: "session_meta", payload: { id: SESSION, cwd: "/x" } }),
  jl({ timestamp: "2026-05-31T07:15:21.000Z", type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.1-codex" } }),
  tokenCount(
    { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 },
    { input_tokens: 100, output_tokens: 10 },
    "2026-05-31T07:15:22.000Z"
  ),
  // exact duplicate emit — must contribute nothing
  tokenCount(
    { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 },
    { input_tokens: 100, output_tokens: 10 },
    "2026-05-31T07:15:23.000Z"
  ),
  tokenCount(
    { input_tokens: 250, cached_input_tokens: 160, output_tokens: 30, reasoning_output_tokens: 9, total_tokens: 280 },
    { input_tokens: 150, output_tokens: 20 },
    "2026-05-31T07:15:24.000Z"
  )
];

function sumByType(points: MetricPointInput[], tokenType: string): number {
  return points.filter((p) => p.tokenType === tokenType).reduce((n, p) => n + p.value, 0);
}

describe("parseCodexTranscript", () => {
  const { points, result } = parseCodexTranscript("codex-cli-jsonl", { sessionId: SESSION }, ROLLOUT);

  it("emits cumulative deltas (deduped) split into fresh input / cache read / output", () => {
    expect(sumByType(points, "input")).toBe(90); // (100-60) + (150-100)
    expect(sumByType(points, "cache_read")).toBe(160); // 60 + 100
    expect(sumByType(points, "output")).toBe(30); // 10 + 20
  });

  it("token totals reconcile with the final cumulative total_token_usage", () => {
    // fresh input + cache read == final input_tokens (250); output == final output_tokens (30)
    expect(sumByType(points, "input") + sumByType(points, "cache_read")).toBe(250);
    expect(sumByType(points, "output")).toBe(30);
  });

  it("carries session id, model, source and signal; emits no cost", () => {
    expect(points.every((p) => p.sessionId === SESSION)).toBe(true);
    expect(points.every((p) => p.model === "gpt-5.1-codex")).toBe(true);
    expect(points.every((p) => p.source === "codex-cli-jsonl" && p.signal === "jsonl")).toBe(true);
    expect(points.every((p) => p.metricName === "codex.token.usage")).toBe(true);
    expect(points.some((p) => p.kind === "cost")).toBe(false);
  });

  it("counts every non-empty line as imported", () => {
    expect(result.importedLines).toBe(ROLLOUT.length);
    expect(result.malformedLines).toBe(0);
  });
});

describe("transcript dispatch", () => {
  it("detects the Codex rollout format", () => {
    expect(detectTranscriptFormat(ROLLOUT)).toBe("codex");
  });

  it("detects Claude transcripts (message/usage shape)", () => {
    const claude = [jl({ type: "assistant", requestId: "req_1", message: { id: "msg_1", usage: { input_tokens: 5 } } })];
    expect(detectTranscriptFormat(claude)).toBe("claude");
  });

  it("routes parseTranscript to the Codex parser", () => {
    const out = parseTranscript("codex", "codex-cli-jsonl", { sessionId: SESSION }, ROLLOUT);
    expect(out.points.length).toBeGreaterThan(0);
    expect(out.points.every((p) => p.metricName === "codex.token.usage")).toBe(true);
  });

  it("only Codex transcripts replace prior session points", () => {
    expect(shouldReplaceBySession("codex")).toBe(true);
    expect(shouldReplaceBySession("claude")).toBe(false);
  });
});
