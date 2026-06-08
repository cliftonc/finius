import type { ImportResult, MetricKind, MetricPointInput } from "../types.js";
import type { ParsedTranscript } from "../transcripts.js";
import { numberValue, parseTimestamp, stringValue } from "../jsonl.js";
import {
  type Attribute,
  asArray,
  attributesToObject,
  getMetricDataPoints,
  numericValue,
  sourceFromAttributes,
  stringAttr,
  unixNanoToMs
} from "../otel.js";

const TOKEN_METRIC = "claude_code.token.usage";
const COST_METRIC = "claude_code.cost.usage";
const LINES_METRIC = "claude_code.lines_of_code.count";
const DECISION_METRIC = "claude_code.code_edit_tool.decision";
const ACTIVE_TIME_METRIC = "claude_code.active_time.total";
const SESSION_METRIC = "claude_code.session.count";
const PR_METRIC = "claude_code.pull_request.count";
const COMMIT_METRIC = "claude_code.commit.count";

// Maps a Claude Code OTLP metric to our (kind, sub-type) for the metric_points table. Returns null for
// metrics we don't aggregate (those data points are dropped).
function classifyMetric(metricName: string, attributes: Record<string, unknown>): { kind: MetricKind; tokenType: string | null } | null {
  switch (metricName) {
    case TOKEN_METRIC:
      return { kind: "tokens", tokenType: normalizeTokenType(stringAttr(attributes, "type")) };
    case COST_METRIC:
      return { kind: "cost", tokenType: null };
    case LINES_METRIC:
      return { kind: "lines", tokenType: stringAttr(attributes, "type") ?? null };
    case DECISION_METRIC:
      return { kind: "decision", tokenType: stringAttr(attributes, "decision") ?? null };
    case ACTIVE_TIME_METRIC:
      return { kind: "active_time", tokenType: stringAttr(attributes, "type") ?? null };
    case SESSION_METRIC:
      return { kind: "session", tokenType: stringAttr(attributes, "start_type") ?? null };
    case PR_METRIC:
      return { kind: "pull_request", tokenType: null };
    case COMMIT_METRIC:
      return { kind: "commit", tokenType: null };
    default:
      return null;
  }
}

function normalizeTokenType(type?: string | null) {
  if (!type) return "total";
  // Claude Code emits camelCase types (cacheCreation, cacheRead) as well as snake/kebab variants.
  const normalized = type.replace(/-/g, "_").toLowerCase();
  if (normalized.includes("cache") && normalized.includes("creation")) return "cache_creation";
  if (normalized.includes("cache") && normalized.includes("read")) return "cache_read";
  if (normalized.includes("output")) return "output";
  if (normalized.includes("input")) return "input";
  return normalized;
}

// Parses a Claude Code OTLP metrics batch (the `claude_code.*` aggregated counters) into metric_points.
export function parseOtelMetricPoints(batch: unknown, source?: string): MetricPointInput[] {
  const points: MetricPointInput[] = [];
  const resourceMetrics = asArray((batch as { resourceMetrics?: unknown[] })?.resourceMetrics);

  for (const resourceMetric of resourceMetrics) {
    const resourceAttrs = attributesToObject((resourceMetric as { resource?: { attributes?: Attribute[] } }).resource?.attributes);
    const pointSource = source ?? sourceFromAttributes(resourceAttrs);
    const scopeMetrics = asArray((resourceMetric as { scopeMetrics?: unknown[] }).scopeMetrics);

    for (const scopeMetric of scopeMetrics) {
      const metrics = asArray((scopeMetric as { metrics?: unknown[] }).metrics);
      for (const metric of metrics) {
        const metricName = String((metric as { name?: string }).name ?? "");

        const dataPoints = getMetricDataPoints(metric);
        for (const dataPoint of dataPoints) {
          const dataPointAttrs = attributesToObject((dataPoint as { attributes?: Attribute[] }).attributes);
          const attributes = { ...resourceAttrs, ...dataPointAttrs };
          const classified = classifyMetric(metricName, attributes);
          if (!classified) continue;

          const sessionId = stringAttr(attributes, "session.id") ?? stringAttr(attributes, "session_id") ?? "unknown-session";
          const timestamp = Number(
            unixNanoToMs(
              (dataPoint as { timeUnixNano?: string | number; startTimeUnixNano?: string | number }).timeUnixNano ??
                (dataPoint as { startTimeUnixNano?: string | number }).startTimeUnixNano
            ) ?? Date.now()
          );
          const value = numericValue(dataPoint);
          if (!Number.isFinite(value)) continue;

          points.push({
            source: pointSource,
            signal: "otlp_metrics",
            sessionId,
            userId: stringAttr(attributes, "user.id") ?? stringAttr(attributes, "enduser.id"),
            userEmail: stringAttr(attributes, "user.email"),
            userAccountId: stringAttr(attributes, "user.account_id") ?? stringAttr(attributes, "user.account_uuid"),
            model: stringAttr(attributes, "model"),
            metricName,
            kind: classified.kind,
            tokenType: classified.tokenType,
            value,
            unit: (metric as { unit?: string }).unit ?? null,
            timestamp,
            attributes
          });
        }
      }
    }
  }

  return points;
}

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
