import type { BaseMessage } from "./types";

// Adapter: VS Code Copilot Chat panel transcript -> BaseMessage[] for the timeline renderer (the same
// shape claudeJsonl.ts / codexRollout.ts produce, so processMessages() pairs tool calls identically).
//
// Unlike the copilot-agent CLI (flat `type`-based events, see copilotAgent.ts), VS Code persists a chat
// session as a JSON-PATCH LOG — one operation per line, applied in order to rebuild the session object:
//   - { kind: 0, v }            : the initial full state (`v.requests`, `v.sessionId`, …).
//   - { kind: 1, k, v }         : SET the value at path `k` (array of keys/indices) to `v`.
//   - { kind: 2, k, v }         : APPEND `v` (an array of elements) to the array at path `k`.
// The conversation lives in `state.requests[]`. Each request has `message.text` (the user prompt) and a
// streamed `response[]` of content parts:
//   - { value, supportHtml }            : a markdown text fragment (assistant reply, streamed in pieces).
//   - { kind: "inlineReference", … }    : a file link embedded inline in the text.
//   - { kind: "thinking", value }       : a reasoning fragment (value may be empty).
//   - { kind: "toolInvocationSerialized"}: a tool call. VS Code re-appends the SAME call (by toolCallId)
//        multiple times as it streams updates, so we merge them per id and emit one tool_use + tool_result.
//        Terminal calls carry the command in toolSpecificData.commandLine and the output (with exit code)
//        in toolSpecificData.terminalCommandOutput.
//   - everything else (mcpServersStarting, codeblockUri, progressMessage, …) is bookkeeping, skipped.

type Block = Record<string, unknown>;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asObject(v: unknown): Block | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Block) : undefined;
}

// VS Code MarkdownString | string -> plain text.
function msgText(v: unknown): string {
  if (typeof v === "string") return v;
  const o = asObject(v);
  return o ? asString(o.value) : "";
}

// Epoch-ms timestamp -> ISO; fall back to the renderer's epoch-0 sentinel.
function isoFrom(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string" && v) return v;
  return new Date(0).toISOString();
}

// ---- patch-log replay -------------------------------------------------------

function navigate(root: unknown, path: unknown[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key as string | number];
  }
  return cur;
}

function setPath(root: Record<string | number, unknown>, path: unknown[], value: unknown): void {
  let cur: Record<string | number, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string | number;
    const next = cur[key];
    if (next == null || typeof next !== "object") {
      cur[key] = typeof path[i + 1] === "number" ? [] : {};
    }
    cur = cur[key] as Record<string | number, unknown>;
  }
  cur[path[path.length - 1] as string | number] = value;
}

function appendPath(root: Record<string | number, unknown>, path: unknown[], value: unknown): void {
  let target = navigate(root, path);
  if (!Array.isArray(target)) {
    setPath(root, path, []);
    target = navigate(root, path);
  }
  if (Array.isArray(target)) {
    if (Array.isArray(value)) target.push(...value);
    else target.push(value);
  }
}

function replayPatchLog(ndjson: string): Block | null {
  let state: unknown = null;
  for (const raw of ndjson.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Block;
    try {
      obj = JSON.parse(line) as Block;
    } catch {
      continue;
    }
    if (obj.kind === 0) {
      state = obj.v;
      continue;
    }
    if (state == null || typeof state !== "object") continue;
    const path = obj.k;
    if (!Array.isArray(path)) continue;
    if (obj.kind === 1) setPath(state as Record<string | number, unknown>, path, obj.v);
    else if (obj.kind === 2) appendPath(state as Record<string | number, unknown>, path, obj.v);
  }
  return asObject(state) ?? null;
}

// ---- tool-call extraction ---------------------------------------------------

// VS Code re-appends each tool invocation several times while it streams; merge per toolCallId so the
// final tool carries the command AND its output (kept on whichever update happened to include them).
function mergeInvocations(response: unknown[]): Map<string, Block> {
  const merged = new Map<string, Block>();
  const tsd = new Map<string, Block>();
  for (const item of response) {
    const o = asObject(item);
    if (!o || (o.kind !== "toolInvocationSerialized" && o.kind !== "toolInvocation")) continue;
    const id = asString(o.toolCallId);
    if (!id) continue;
    merged.set(id, { ...(merged.get(id) ?? {}), ...o });
    const specific = asObject(o.toolSpecificData);
    if (specific) tsd.set(id, { ...(tsd.get(id) ?? {}), ...specific });
  }
  for (const [id, m] of merged) {
    const t = tsd.get(id);
    if (t) m.toolSpecificData = t;
  }
  return merged;
}

function toolName(inv: Block): string {
  return asString(inv.toolId) || msgText(inv.invocationMessage) || "tool";
}

function toolInput(inv: Block): Record<string, unknown> {
  const tsd = asObject(inv.toolSpecificData);
  if (tsd?.kind === "terminal") {
    const cmd = asObject(tsd.commandLine);
    const command = asString(cmd?.original) || asString(cmd?.forDisplay);
    const cwd = asString(asObject(tsd.cwd)?.fsPath);
    return { command, ...(cwd ? { cwd } : {}) };
  }
  if (tsd) return tsd;
  const label = msgText(inv.invocationMessage);
  return label ? { request: label } : {};
}

function toolResult(inv: Block): { content: unknown; isError: boolean } {
  const tsd = asObject(inv.toolSpecificData);
  if (tsd?.kind === "terminal") {
    const output = asObject(tsd.terminalCommandOutput);
    const text = typeof tsd.terminalCommandOutput === "string" ? tsd.terminalCommandOutput : asString(output?.text);
    const exit = asObject(tsd.terminalCommandState)?.exitCode;
    const isError = typeof exit === "number" && exit !== 0;
    if (text) return { content: text, isError };
  }
  const status = msgText(inv.pastTenseMessage) || msgText(inv.invocationMessage) || (inv.isComplete ? "Completed" : "Running…");
  return { content: status, isError: false };
}

// ---- main parse -------------------------------------------------------------

export function parseVscodeChat(ndjson: string): BaseMessage[] {
  const out: BaseMessage[] = [];
  const state = replayPatchLog(ndjson);
  if (!state) return out;
  const requests = Array.isArray(state.requests) ? state.requests : [];

  requests.forEach((reqRaw, reqIdx) => {
    const req = asObject(reqRaw);
    if (!req) return;
    const ts = isoFrom(req.timestamp);

    const userText = msgText(asObject(req.message)?.text ?? asObject(req.message));
    if (userText) out.push({ id: `req-${reqIdx}-user`, timestamp: ts, type: "user", content: { text: userText } });

    const response = Array.isArray(req.response) ? req.response : [];
    const invocations = mergeInvocations(response);
    const emitted = new Set<string>();
    let text = "";
    let reasoning = "";
    let part = 0;

    const flush = () => {
      if (text.trim() || reasoning.trim()) {
        out.push({
          id: `req-${reqIdx}-asst-${part++}`,
          timestamp: ts,
          type: "assistant",
          content: { text: text.trim(), reasoning: reasoning.trim() }
        });
      }
      text = "";
      reasoning = "";
    };

    for (const itemRaw of response) {
      const item = asObject(itemRaw);
      if (!item) continue;
      const kind = item.kind;

      if (kind === "thinking") {
        const v = msgText(item.value);
        if (v) reasoning += (reasoning ? "\n\n" : "") + v;
        continue;
      }
      if (kind === "inlineReference") {
        const ref = asObject(item.inlineReference);
        const path = asString(ref?.fsPath) || asString(ref?.path);
        if (path) text += `\`${path.split("/").pop() || path}\``;
        continue;
      }
      if (kind === "toolInvocationSerialized" || kind === "toolInvocation") {
        const id = asString(item.toolCallId) || `req-${reqIdx}-tool-${part}`;
        if (emitted.has(id)) continue;
        emitted.add(id);
        flush();
        const inv = invocations.get(id) ?? item;
        out.push({ id, timestamp: ts, type: "tool_use", content: { id, name: toolName(inv), input: toolInput(inv) } });
        const { content, isError } = toolResult(inv);
        out.push({
          id: `${id}-result`,
          timestamp: ts,
          type: "tool_result",
          content: { tool_use_id: id, content, is_error: isError },
          linkedTo: id
        });
        continue;
      }

      // Plain markdown text fragment ({ value, supportHtml }) or { kind: "markdownContent", content }.
      if (typeof item.value === "string") {
        text += item.value;
        continue;
      }
      const markdown = asObject(item.content);
      if (kind === "markdownContent" && markdown && typeof markdown.value === "string") {
        text += markdown.value;
      }
    }
    flush();
  });

  return out;
}

// Sniff whether a transcript is a VS Code Copilot Chat patch log (vs the copilot-agent CLI / Codex /
// Claude shapes). Mirrors the server's detectTranscriptFormat `kind: 0` branch.
export function isVscodeChat(ndjson: string): boolean {
  for (const raw of ndjson.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Block;
    try {
      obj = JSON.parse(line) as Block;
    } catch {
      continue;
    }
    if (obj.kind === 0) {
      const v = asObject(obj.v);
      if (v && (typeof v.sessionId === "string" || Array.isArray(v.requests))) return true;
    }
    if (typeof obj.kind === "number" && Array.isArray(obj.k)) return true;
    // Any defining marker of another format ends the sniff.
    if (typeof obj.type === "string" || obj.message || obj.payload || obj.requestId) return false;
  }
  return false;
}
