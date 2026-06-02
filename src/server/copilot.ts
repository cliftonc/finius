import type { ImportResult, MetricPointInput } from "./types.js";
import type { ParsedTranscript } from "./transcripts.js";

// Parser for VS Code Copilot Chat JSONL transcripts:
// - workspaceStorage/**/GitHub.copilot-chat/transcripts/<chat-session>.jsonl
// - workspaceStorage/**/chatSessions/<chat-session>.jsonl
// - globalStorage/emptyWindowChatSessions/<chat-session>.jsonl
//
// These files are transcript/history only; token usage comes from Copilot's OTLP traces. We emit one
// lightweight session marker so the uploaded transcript links to a session row without adding tokens.
export function parseCopilotTranscript(
  source: string,
  sessionHint: Partial<MetricPointInput>,
  lines: string[]
): ParsedTranscript {
  const result: ImportResult = { importedLines: 0, malformedLines: 0, metricPoints: 0, rawEvents: 0 };
  const rawEvents: unknown[] = [];
  let transcriptSessionId: string | undefined;
  let timestamp: number | undefined;
  let model: string | null = sessionHint.model ?? null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      result.malformedLines += 1;
      continue;
    }

    result.importedLines += 1;
    result.rawEvents += 1;
    rawEvents.push(event);

    const obj = event as Record<string, unknown>;
    const data = objectValue(obj.data);
    const value = objectValue(obj.v);
    if (stringValue(obj.type) === "session.start" && data) {
      transcriptSessionId = stringValue(data.sessionId) ?? transcriptSessionId;
      timestamp = parseTimestamp(obj.timestamp) ?? parseTimestamp(data.startTime) ?? timestamp;
    }
    transcriptSessionId = stringValue(value?.sessionId) ?? stringValue(data?.sessionId) ?? transcriptSessionId;
    timestamp = parseTimestamp(obj.timestamp) ?? parseTimestamp(value?.creationDate) ?? timestamp;

    const selectedModel = objectValue(value?.inputState)?.selectedModel as Record<string, unknown> | undefined;
    model =
      stringValue(selectedModel?.identifier) ??
      stringValue(objectValue(selectedModel?.metadata)?.version) ??
      stringValue(objectValue(selectedModel?.metadata)?.family) ??
      model;
  }

  const sessionId = sessionHint.sessionId ?? transcriptSessionId;
  const points: MetricPointInput[] = [];
  if (sessionId) {
    points.push({
      source,
      signal: "jsonl",
      sessionId,
      userId: sessionHint.userId ?? null,
      userEmail: sessionHint.userEmail ?? null,
      userAccountId: sessionHint.userAccountId ?? null,
      githubLogin: sessionHint.githubLogin ?? null,
      displayName: sessionHint.displayName ?? null,
      model,
      metricName: "copilot.chat.session",
      kind: "session",
      tokenType: "transcript",
      value: 1,
      unit: "session",
      timestamp: timestamp ?? Date.now(),
      attributes: {
        transcriptSessionId: transcriptSessionId ?? null,
        sourceSessionId: sessionHint.sessionId ?? null
      }
    });
    result.metricPoints = 1;
  }

  return { result, points, rawEvents };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
