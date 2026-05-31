import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "../src/server/claude.js";

describe("parseClaudeTranscript", () => {
  it("handles valid lines, malformed lines, and missing usage", () => {
    const parsed = parseClaudeTranscript("manual", { sessionId: "session-jsonl" }, [
      JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } }, cost_usd: 0.001 }),
      "{broken",
      JSON.stringify({ type: "metadata" })
    ]);

    expect(parsed.result.importedLines).toBe(2);
    expect(parsed.result.malformedLines).toBe(1);
    expect(parsed.result.rawEvents).toBe(2);
    expect(parsed.result.metricPoints).toBe(4);
    expect(parsed.points.map((point) => point.tokenType)).toEqual(["input", "output", "cache_read", null]);
  });

  it("counts each API request once even when its usage is repeated across lines", () => {
    // Claude Code stamps the same usage on every transcript line of one response.
    const usage = { input_tokens: 100, output_tokens: 20 };
    const parsed = parseClaudeTranscript("manual", { sessionId: "s" }, [
      JSON.stringify({ type: "assistant", requestId: "req_A", message: { id: "msg_A", usage } }),
      JSON.stringify({ type: "assistant", requestId: "req_A", message: { id: "msg_A", usage } }),
      JSON.stringify({ type: "assistant", requestId: "req_A", message: { id: "msg_A", usage } }),
      JSON.stringify({ type: "assistant", requestId: "req_B", message: { id: "msg_B", usage } })
    ]);

    // 4 lines imported, but only 2 distinct requests → 2 input + 2 output points.
    expect(parsed.result.importedLines).toBe(4);
    const input = parsed.points.filter((p) => p.tokenType === "input");
    expect(input).toHaveLength(2);
    expect(input.reduce((sum, p) => sum + p.value, 0)).toBe(200);
  });

  it("falls back to message.id when requestId is absent", () => {
    const usage = { input_tokens: 7 };
    const parsed = parseClaudeTranscript("manual", { sessionId: "s" }, [
      JSON.stringify({ type: "assistant", message: { id: "msg_X", usage } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_X", usage } })
    ]);
    expect(parsed.points.filter((p) => p.tokenType === "input")).toHaveLength(1);
  });
});
