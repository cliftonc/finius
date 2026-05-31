import type { BaseMessage } from "./types";

// Adapter: raw OpenAI Codex "rollout" NDJSON -> BaseMessage[] for the timeline renderer (the same
// shape claudeJsonl.ts produces, so processMessages() pairs tool calls identically).
//
// Codex writes one JSON object per line as `{ timestamp, type, payload }`. The model I/O lives on
// `response_item` lines (OpenAI Responses items):
//   - message            : payload.content is an array of {type:input_text|output_text|text, text}.
//                          role is user | assistant | developer (developer = the system preamble).
//   - reasoning          : payload.summary[] (often empty; the chain-of-thought is encrypted).
//   - function_call      : a shell/tool call; payload.arguments is a JSON string. call_id links it.
//   - custom_tool_call   : e.g. apply_patch; payload.input is a string. call_id links it.
//   - *_output           : the matching tool result, linked by call_id.
// `turn_context` lines carry the model. Everything else (session_meta, event_msg:*) is bookkeeping.

type Block = Record<string, unknown>;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Concatenate the text of an OpenAI content-block array (input_text / output_text / text).
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((b) => (b.type === "input_text" || b.type === "output_text" || b.type === "text" ? asString(b.text) : ""))
    .filter(Boolean)
    .join("\n\n");
}

// Codex tool results are a plain string (or occasionally an object); normalize to a string.
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as Block;
    if (typeof o.content === "string") return o.content;
    if (typeof o.output === "string") return o.output;
    return JSON.stringify(output);
  }
  return "";
}

// Tool-call arguments: function_call.arguments is a JSON string; custom_tool_call.input is raw text.
function toolInput(payload: Block): Record<string, unknown> {
  const raw = payload.arguments ?? payload.input;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // not JSON (e.g. an apply_patch body) — surface the raw text
    }
    return { input: raw };
  }
  return {};
}

export function parseCodexRollout(ndjson: string): BaseMessage[] {
  const out: BaseMessage[] = [];
  let model: string | undefined;

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
    const ts = asString(obj.timestamp) || new Date(0).toISOString();
    const payload = obj.payload as Block | undefined;
    if (!payload) continue;

    if (type === "turn_context") {
      const m = asString(payload.model);
      if (m) model = m;
      continue;
    }
    if (type !== "response_item") continue;

    const ptype = asString(payload.type);
    const id = asString(payload.call_id) || asString(payload.id) || `line-${out.length}`;

    if (ptype === "message") {
      const role = asString(payload.role);
      const text = contentText(payload.content);
      if (!text) continue;
      // developer = the system/permissions preamble; show it as a system note.
      const mapped = role === "assistant" ? "assistant" : role === "developer" ? "system" : "user";
      out.push({
        id: `${id}-msg`,
        timestamp: ts,
        type: mapped,
        content: { text },
        ...(mapped === "assistant" && model ? { metadata: { model } } : {})
      });
    } else if (ptype === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? (payload.summary as unknown[])
            .map((s) => (typeof s === "string" ? s : asString((s as Block).text)))
            .filter(Boolean)
            .join("\n\n")
        : "";
      if (summary) out.push({ id: `${id}-reasoning`, timestamp: ts, type: "assistant", content: { text: "", reasoning: summary } });
    } else if (ptype === "function_call" || ptype === "custom_tool_call") {
      out.push({
        id,
        timestamp: ts,
        type: "tool_use",
        content: { id, name: asString(payload.name) || "tool", input: toolInput(payload) }
      });
    } else if (ptype === "function_call_output" || ptype === "custom_tool_call_output") {
      const text = outputText(payload.output);
      out.push({
        id: `${id}-result`,
        timestamp: ts,
        type: "tool_result",
        content: { tool_use_id: id, content: text, is_error: false },
        linkedTo: id || undefined
      });
    }
  }

  return out;
}

// Sniff whether a transcript is a Codex rollout (vs a Claude transcript), mirroring the server's
// detectTranscriptFormat so the right adapter renders it.
export function isCodexRollout(ndjson: string): boolean {
  const CODEX_TYPES = new Set(["session_meta", "event_msg", "response_item", "turn_context"]);
  for (const raw of ndjson.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.payload && typeof obj.type === "string" && CODEX_TYPES.has(obj.type)) return true;
    if (obj.message || obj.requestId) return false;
  }
  return false;
}
