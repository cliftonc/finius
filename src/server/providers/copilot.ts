import type { ImportResult, MetricPointInput } from "../types.js";
import type { ParsedTranscript } from "../transcripts.js";
import { objectValue, parseTimestamp, stringValue } from "../jsonl.js";
import { COPILOT_CHAT_SOURCE, COPILOT_CLI_SOURCE } from "../../shared/sources.js";
import {
  type OtelSpanRecord,
  type OtelTraceSessionDiagnostic,
  parseOtelTraceRecords,
  selectedTokenSpans,
  stringAttr,
  tokenEntries
} from "../otel.js";

// Parses a Copilot OTLP traces batch (gen_ai spans, CLI + VS Code Chat) into token metric_points.
// Copilot is the only agent that ships OTLP traces today; Claude's trace signal is not ingested.
export function parseOtelTracePoints(batch: unknown): MetricPointInput[] {
  const selected = selectedTokenSpans(parseOtelTraceRecords(batch));
  const points: MetricPointInput[] = [];

  for (const span of selected) {
    const attrs = span.attributes;
    const sessionId = traceSessionId(span);
    const model =
      stringAttr(attrs, "gen_ai.response.model") ??
      stringAttr(attrs, "gen_ai.request.model") ??
      stringAttr(attrs, "model");
    const base = {
      source: span.source,
      signal: "otlp_metrics" as const,
      sessionId,
      userId:
        stringAttr(attrs, "user.id") ??
        stringAttr(attrs, "enduser.id") ??
        stringAttr(attrs, "github.copilot.user") ??
        stringAttr(attrs, "github.user"),
      userEmail: stringAttr(attrs, "user.email"),
      userAccountId: stringAttr(attrs, "user.account_id") ?? stringAttr(attrs, "user.account_uuid"),
      model,
      timestamp: span.timestamp,
      attributes: attrs
    };
    for (const [tokenType, value] of tokenEntries(attrs)) {
      points.push({
        ...base,
        metricName: "gen_ai.span.token.usage",
        kind: "tokens",
        tokenType,
        value,
        unit: "tokens"
      });
    }
  }

  return points;
}

// Diagnostic view of the selected token spans (the session-id candidates + chosen id), powering the
// trace-session introspection endpoint.
export function otelTraceSessionDiagnostics(batch: unknown): OtelTraceSessionDiagnostic[] {
  return selectedTokenSpans(parseOtelTraceRecords(batch)).map((span) => {
    const attrs = span.attributes;
    const tokens = tokenEntries(attrs);
    return {
      source: span.source,
      spanName: span.name,
      traceId: span.traceId,
      spanId: span.spanId,
      selectedSessionId: traceSessionId(span),
      serviceName: stringAttr(attrs, "service.name") ?? null,
      serviceVersion: stringAttr(attrs, "service.version") ?? null,
      operationName: stringAttr(attrs, "gen_ai.operation.name") ?? null,
      agentName: stringAttr(attrs, "gen_ai.agent.name") ?? null,
      model: stringAttr(attrs, "gen_ai.response.model") ?? stringAttr(attrs, "gen_ai.request.model") ?? stringAttr(attrs, "model") ?? null,
      sessionId: stringAttr(attrs, "session.id") ?? null,
      sessionUnderscoreId: stringAttr(attrs, "session_id") ?? null,
      conversationId: stringAttr(attrs, "conversation.id") ?? null,
      genAiConversationId: stringAttr(attrs, "gen_ai.conversation.id") ?? null,
      copilotChatSessionId: stringAttr(attrs, "copilot_chat.session_id") ?? null,
      copilotChatChatSessionId: stringAttr(attrs, "copilot_chat.chat_session_id") ?? null,
      tokenTypes: tokens.map(([tokenType]) => tokenType),
      tokenTotal: tokens.reduce((sum, [, value]) => sum + value, 0),
      attributeKeys: Object.keys(attrs).sort()
    };
  });
}

// Resolves the session id for a trace span. VS Code Copilot Chat prefers its own `session.id` /
// `copilot_chat.*` ids; everything else uses the gen_ai conversation/session precedence.
function traceSessionId(span: OtelSpanRecord): string {
  const attrs = span.attributes;
  if (isVsCodeCopilotSpan(span)) {
    return (
      stringAttr(attrs, "session.id") ??
      stringAttr(attrs, "copilot_chat.chat_session_id") ??
      stringAttr(attrs, "copilot_chat.session_id") ??
      stringAttr(attrs, "gen_ai.conversation.id") ??
      span.traceId ??
      "unknown-session"
    );
  }
  return (
    stringAttr(attrs, "gen_ai.conversation.id") ??
    stringAttr(attrs, "session.id") ??
    stringAttr(attrs, "conversation.id") ??
    span.traceId ??
    "unknown-session"
  );
}

function isVsCodeCopilotSpan(span: OtelSpanRecord): boolean {
  if (span.source !== COPILOT_CLI_SOURCE && span.source !== COPILOT_CHAT_SOURCE) return false;
  const attrs = span.attributes;
  return (
    stringAttr(attrs, "gen_ai.agent.name") === "GitHub Copilot Chat" ||
    stringAttr(attrs, "copilot_chat.session_id") !== undefined ||
    stringAttr(attrs, "copilot_chat.chat_session_id") !== undefined
  );
}

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
