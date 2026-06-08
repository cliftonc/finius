import type { ImportResult, MetricPointInput, TranscriptFormat } from "./types.js";
import { parseClaudeTranscript } from "./providers/claude.js";
import { parseCodexTranscript } from "./providers/codex.js";
import { parseCopilotTranscript } from "./providers/copilot.js";

// Shared result shape for every transcript parser (Claude `claude.ts`, Codex `codex.ts`, ...).
export type ParsedTranscript = {
  result: ImportResult;
  points: MetricPointInput[];
  rawEvents: unknown[];
};

// Pluggable dispatch: given a (possibly detected) format, route to the matching pure parser. Add a
// new coding agent by writing its parser module and extending TranscriptFormat + these two switches.
export function parseTranscript(
  format: TranscriptFormat,
  source: string,
  sessionHint: Partial<MetricPointInput>,
  lines: string[]
): ParsedTranscript {
  switch (format) {
    case "copilot":
      return parseCopilotTranscript(source, sessionHint, lines);
    case "codex":
      return parseCodexTranscript(source, sessionHint, lines);
    case "claude":
    default:
      return parseClaudeTranscript(source, sessionHint, lines);
  }
}

// Best-effort sniff of which agent wrote a transcript, used when the caller doesn't pass an explicit
// format. Codex "rollout" lines are uniquely shaped: `{ type, payload }` with a small set of envelope
// types. Anything else falls back to Claude (the original transcript format).
export function detectTranscriptFormat(lines: string[]): TranscriptFormat {
  const CODEX_TYPES = new Set(["session_meta", "event_msg", "response_item", "turn_context"]);
  const COPILOT_TYPES = new Set(["session.start", "user.message", "assistant.message", "assistant.turn_start", "assistant.turn_end"]);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const obj = event as Record<string, unknown>;
    if (typeof obj.type === "string" && COPILOT_TYPES.has(obj.type)) return "copilot";
    if (obj.kind === 0 && obj.v && typeof obj.v === "object" && typeof (obj.v as Record<string, unknown>).sessionId === "string") return "copilot";
    if (typeof obj.type === "string" && obj.payload && typeof obj.payload === "object" && CODEX_TYPES.has(obj.type)) {
      return "codex";
    }
    if (obj.message || obj.requestId || obj.sessionId || obj.session_id) return "claude";
  }
  return "claude";
}

// Codex writes ONE append-only rollout file per session that grows as the session runs; the upload
// hook fires per-turn, so re-importing the (now longer) file must REPLACE the session's prior points,
// not add to them. Claude uploads are point-in-time snapshots and stay append-only.
export function shouldReplaceBySession(format: TranscriptFormat): boolean {
  return format === "codex" || format === "copilot";
}
