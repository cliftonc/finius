import { describe, expect, it } from "vitest";
import { parseJsonl } from "../src/server/jsonl";

describe("JSONL parser", () => {
  it("handles valid lines, malformed lines, and missing usage", () => {
    const parsed = parseJsonl("manual", { sessionId: "session-jsonl" }, [
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
});
