import type { ImportResult, MetricPointInput } from "./types.js";
import type { ParsedTranscript } from "./transcripts.js";

// Parser for Claude Code transcripts (`~/.claude/projects/**/<session>.jsonl`). Pure / side-effect-free
// so it stays unit-testable; the Codex equivalent is codex.ts and both are dispatched from transcripts.ts.
export function parseClaudeTranscript(
  source: string,
  sessionHint: Partial<MetricPointInput>,
  lines: string[]
): ParsedTranscript {
  const result: ImportResult = { importedLines: 0, malformedLines: 0, metricPoints: 0, rawEvents: 0 };
  const points: MetricPointInput[] = [];
  const rawEvents: unknown[] = [];
  // Claude Code writes one API response across several transcript lines (one per content
  // block — text, tool_use, thinking) and stamps the SAME `usage` object on each. Summing
  // every usage-bearing line double-counts tokens ~2-3.6x. Dedupe by the request identity so
  // each API request contributes its tokens exactly once.
  const seenRequests = new Set<string>();

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

    const extracted = extractUsage(source, sessionHint, event, seenRequests);
    points.push(...extracted);
    result.metricPoints += extracted.length;
  }

  return { result, points, rawEvents };
}

function extractUsage(
  source: string,
  sessionHint: Partial<MetricPointInput>,
  event: unknown,
  seenRequests: Set<string>
): MetricPointInput[] {
  const obj = event as Record<string, unknown>;
  const usage = findUsageObject(obj);
  if (!usage) return [];

  // One token/cost record per API request. `requestId` (or the API `message.id`) is repeated
  // across the split lines of a single response; the first occurrence wins, the rest are skipped.
  // No stable id → fall back to never-deduping rather than risk merging distinct requests.
  const message = obj.message as Record<string, unknown> | undefined;
  const requestKey = stringValue(obj.requestId) ?? stringValue(message?.id);
  if (requestKey !== undefined) {
    if (seenRequests.has(requestKey)) return [];
    seenRequests.add(requestKey);
  }

  const timestamp = parseTimestamp(obj.timestamp) ?? parseTimestamp(obj.created_at) ?? Date.now();
  const sessionId = String(obj.session_id ?? obj.sessionId ?? sessionHint.sessionId ?? "unknown-session");
  const model = stringValue(obj.model) ?? stringValue((obj.message as Record<string, unknown> | undefined)?.model) ?? sessionHint.model ?? null;
  const base = {
    source,
    signal: "jsonl" as const,
    sessionId,
    userId: sessionHint.userId ?? null,
    userEmail: sessionHint.userEmail ?? null,
    userAccountId: sessionHint.userAccountId ?? null,
    githubLogin: sessionHint.githubLogin ?? null,
    displayName: sessionHint.displayName ?? null,
    model,
    timestamp,
    attributes: obj
  };
  const points: MetricPointInput[] = [];

  const tokenMap: Array<[string, string]> = [
    ["input_tokens", "input"],
    ["output_tokens", "output"],
    ["cache_creation_input_tokens", "cache_creation"],
    ["cache_read_input_tokens", "cache_read"]
  ];

  for (const [field, tokenType] of tokenMap) {
    const value = numberValue((usage as Record<string, unknown>)[field]);
    if (value === undefined) continue;
    points.push({
      ...base,
      metricName: "claude_code.token.usage",
      kind: "tokens",
      tokenType,
      value,
      unit: "tokens"
    });
  }

  const cost = numberValue(obj.cost_usd) ?? numberValue(obj.total_cost_usd) ?? numberValue((usage as Record<string, unknown>).cost_usd);
  if (cost !== undefined) {
    points.push({
      ...base,
      metricName: "claude_code.cost.usage",
      kind: "cost",
      tokenType: null,
      value: cost,
      unit: "USD"
    });
  }

  return points;
}

function findUsageObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.usage && typeof obj.usage === "object") return obj.usage as Record<string, unknown>;
  if (obj.message && typeof obj.message === "object") {
    const nested = findUsageObject(obj.message);
    if (nested) return nested;
  }
  return null;
}

function numberValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
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
