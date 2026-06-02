import { describe, it, expect } from "vitest";
import { parseTranscriptToMessages } from "../src/client/timeline/adapters";
import { processMessages } from "../src/client/timeline/processor";
import { isToolPair } from "../src/client/timeline/types";

// The timeline renderer reads one shared BaseMessage model regardless of which agent wrote the
// transcript. These tests pin the adapter registry's format sniffing + parsing so a Copilot transcript
// can never silently render as "Transcript is empty" again (the bug both formats below regressed on).

function timeline(ndjson: string) {
  return processMessages(parseTranscriptToMessages(ndjson));
}

describe("timeline adapters — Copilot CLI / agent", () => {
  // The flat, `type`-based shape written by `producer: "copilot-agent"`.
  const transcript = [
    { type: "session.start", data: { sessionId: "s1", startTime: "2026-06-02T04:13:18.237Z" }, id: "start", timestamp: "2026-06-02T04:13:18.237Z" },
    { type: "user.message", data: { content: "Can you run the tests?" }, id: "u1", timestamp: "2026-06-02T04:17:08.318Z" },
    {
      type: "assistant.message",
      data: {
        content: "Checking the test scripts.",
        reasoningText: "I should inspect package.json first.",
        toolRequests: [{ toolCallId: "call_1", name: "run_in_terminal", arguments: '{"command":"npm test"}', type: "function" }]
      },
      id: "a1",
      timestamp: "2026-06-02T04:17:12.303Z"
    },
    { type: "tool.execution_complete", data: { toolCallId: "call_1", success: true }, id: "c1", timestamp: "2026-06-02T04:17:39.385Z" }
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");

  it("renders user, assistant (with reasoning), and a paired tool call", () => {
    const items = timeline(transcript);
    expect(items.length).toBeGreaterThan(0);

    const user = items.find((i) => !isToolPair(i) && i.message.type === "user");
    expect((user as any).message.content.text).toBe("Can you run the tests?");

    const asst = items.find((i) => !isToolPair(i) && i.message.type === "assistant");
    expect((asst as any).message.content.reasoning).toContain("package.json");

    const tool = items.find(isToolPair);
    expect(tool?.toolName).toBe("run_in_terminal");
    expect((tool?.use.content as any).input.command).toBe("npm test");
    expect(tool?.result).not.toBeNull();
  });
});

describe("timeline adapters — VS Code Copilot Chat", () => {
  // The JSON-patch log VS Code persists: a kind:0 base, then kind:2 appends to `requests`, with each
  // tool invocation re-appended (streamed) several times under the same toolCallId.
  const toolInvocation = (extra: Record<string, unknown>) => ({
    kind: "toolInvocationSerialized",
    toolCallId: "call_term",
    toolId: "run_in_terminal",
    invocationMessage: { value: "Running `npm run build`" },
    isComplete: true,
    ...extra
  });
  const transcript = [
    { kind: 0, v: { sessionId: "vsc-1", requests: [] } },
    {
      kind: 2,
      k: ["requests"],
      v: [
        {
          requestId: "r1",
          timestamp: 1780369575239,
          message: { text: "can you run the build" },
          response: [
            { kind: "mcpServersStarting", didStartServerIds: [] },
            { kind: "thinking", value: "Preparing to run the build." },
            { value: "Running the build now.", supportHtml: false },
            toolInvocation({}),
            // streamed update of the SAME call that carries the command + output:
            toolInvocation({
              toolSpecificData: {
                kind: "terminal",
                commandLine: { original: "cd /repo && npm run build", forDisplay: "npm run build" },
                terminalCommandState: { exitCode: 0 },
                terminalCommandOutput: { text: "Build succeeded\nWrote dist/" }
              }
            }),
            { value: "✅ Build succeeded.", supportHtml: false }
          ]
        }
      ]
    }
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");

  it("replays the patch log and renders user, assistant, and a merged terminal tool call", () => {
    const items = timeline(transcript);
    expect(items.length).toBeGreaterThan(0);

    const user = items.find((i) => !isToolPair(i) && i.message.type === "user");
    expect((user as any).message.content.text).toBe("can you run the build");

    const tool = items.find(isToolPair);
    expect(tool?.toolName).toBe("run_in_terminal");
    // The command + output are merged from the streamed updates, not lost on the minimal first append.
    expect((tool?.use.content as any).input.command).toBe("cd /repo && npm run build");
    expect((tool?.result?.content as any).content).toContain("Build succeeded");
    expect((tool?.result?.content as any).is_error).toBe(false);

    // Assistant text + reasoning both surface.
    const reasoning = items.some((i) => !isToolPair(i) && (i.message.content as any)?.reasoning?.includes("Preparing"));
    expect(reasoning).toBe(true);
  });

  it("is detected as VS Code chat, not Claude (which would render empty)", () => {
    // A single tool call is merged to exactly one tool_pair (the streamed duplicate is not double-counted).
    const pairs = timeline(transcript).filter(isToolPair);
    expect(pairs).toHaveLength(1);
  });
});
