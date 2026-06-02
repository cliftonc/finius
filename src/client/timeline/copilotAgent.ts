import type { BaseMessage } from "./types";

// Adapter: raw GitHub Copilot **CLI / agent** transcript NDJSON -> BaseMessage[] for the timeline
// renderer (the same shape claudeJsonl.ts / codexRollout.ts produce, so processMessages() pairs tool
// calls identically). This is the `producer: "copilot-agent"` format; the VS Code Copilot Chat panel
// writes a different, JSON-patch shape handled by vscodeChat.ts.
//
// copilot-agent writes one JSON object per line as `{ type, data, id, timestamp, parentId }`. The lines
// we render:
//   - session.start         : session metadata — bookkeeping, skipped.
//   - user.message          : data.content is the prompt string.
//   - assistant.message      : data.content is the reply text, data.reasoningText the chain-of-thought,
//                             and data.toolRequests[] the tool calls (each {toolCallId, name,
//                             arguments}, where `arguments` is a JSON string).
//   - tool.execution_start   : duplicates a toolRequest (same toolCallId) — skipped; toolRequests is the
//                             canonical, complete source of calls.
//   - tool.execution_complete: data.{toolCallId, success} — the matching result, linked by toolCallId.
//                             The transcript carries no result body, so we surface the success status.
// assistant.turn_start / assistant.turn_end are turn bookkeeping and are skipped.

type Block = Record<string, unknown>;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// toolRequests[].arguments is a JSON string; tolerate an already-parsed object or non-JSON text.
function toolInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // not JSON — surface the raw text
    }
    return { input: raw };
  }
  return {};
}

export function parseCopilotAgent(ndjson: string): BaseMessage[] {
  const out: BaseMessage[] = [];

  for (const raw of ndjson.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = asString(obj.type);
    const id = asString(obj.id) || `line-${out.length}`;
    const ts = asString(obj.timestamp) || new Date(0).toISOString();
    const data = (obj.data as Block | undefined) ?? undefined;
    if (!data) continue;

    if (type === "user.message") {
      const text = asString(data.content);
      if (text) out.push({ id, timestamp: ts, type: "user", content: { text } });
      continue;
    }

    if (type === "assistant.message") {
      const text = asString(data.content);
      const reasoning = asString(data.reasoningText);
      if (text || reasoning) {
        out.push({ id: `${id}-text`, timestamp: ts, type: "assistant", content: { text, reasoning } });
      }
      const toolRequests = Array.isArray(data.toolRequests) ? (data.toolRequests as Block[]) : [];
      for (const req of toolRequests) {
        const callId = asString(req.toolCallId) || `${id}-${out.length}`;
        out.push({
          id: callId,
          timestamp: ts,
          type: "tool_use",
          content: { id: callId, name: asString(req.name) || "tool", input: toolInput(req.arguments) }
        });
      }
      continue;
    }

    if (type === "tool.execution_complete") {
      const callId = asString(data.toolCallId);
      if (!callId) continue;
      const success = data.success !== false;
      out.push({
        id: `${callId}-result`,
        timestamp: ts,
        type: "tool_result",
        content: { tool_use_id: callId, content: success ? "Completed" : "Failed", is_error: !success },
        linkedTo: callId
      });
      continue;
    }
  }

  return out;
}

// Sniff whether a transcript is a Copilot CLI/agent log, mirroring the server's detectTranscriptFormat
// so the right adapter renders it.
export function isCopilotAgent(ndjson: string): boolean {
  const COPILOT_TYPES = new Set([
    "session.start",
    "user.message",
    "assistant.message",
    "assistant.turn_start",
    "assistant.turn_end"
  ]);
  for (const raw of ndjson.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.type === "string" && COPILOT_TYPES.has(obj.type)) return true;
    if (obj.message || obj.requestId || obj.payload) return false;
  }
  return false;
}
