import { createHash } from "node:crypto";
import type { MetricKind, MetricPointInput } from "./types.js";

type AttributeValue = {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AttributeValue[] };
  kvlistValue?: { values?: Array<{ key: string; value?: AttributeValue }> };
};

type Attribute = { key: string; value?: AttributeValue };

const TOKEN_METRIC = "claude_code.token.usage";
const COST_METRIC = "claude_code.cost.usage";
const LINES_METRIC = "claude_code.lines_of_code.count";
const DECISION_METRIC = "claude_code.code_edit_tool.decision";
const ACTIVE_TIME_METRIC = "claude_code.active_time.total";
const SESSION_METRIC = "claude_code.session.count";
const PR_METRIC = "claude_code.pull_request.count";
const COMMIT_METRIC = "claude_code.commit.count";

// Maps an OTLP metric to our (kind, sub-type) for the metric_points table. Returns null for
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

export function stableHash(signal: string, batch: unknown) {
  return createHash("sha256").update(signal).update(JSON.stringify(batch)).digest("hex");
}

export function attributesToObject(attributes?: Attribute[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attr of attributes ?? []) {
    out[attr.key] = decodeAttributeValue(attr.value);
  }
  return out;
}

export function decodeAttributeValue(value?: AttributeValue): unknown {
  if (!value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if ("arrayValue" in value) return value.arrayValue?.values?.map(decodeAttributeValue) ?? [];
  if ("kvlistValue" in value) {
    return attributesToObject(value.kvlistValue?.values as Attribute[] | undefined);
  }
  return null;
}

export function parseOtelMetricPoints(batch: unknown, source = "claude-code"): MetricPointInput[] {
  const points: MetricPointInput[] = [];
  const resourceMetrics = asArray((batch as { resourceMetrics?: unknown[] })?.resourceMetrics);

  for (const resourceMetric of resourceMetrics) {
    const resourceAttrs = attributesToObject((resourceMetric as { resource?: { attributes?: Attribute[] } }).resource?.attributes);
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
            source,
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

export type OtelMetricRecord = {
  source: string;
  metricName: string;
  unit: string | null;
  kind: "sum" | "gauge" | "histogram" | "unknown";
  temporality: number | null;
  isMonotonic: boolean | null;
  value: number | null;
  startTimeUnixNano: string | number | null;
  timeUnixNano: string | number | null;
  timestamp: number;
  attributes: Record<string, unknown>;
};

/**
 * Decodes EVERY metric data point in a batch (all metric names, not just token/cost) into a flat
 * list of records, so the raw-events log captures the full telemetry surface. Pure/side-effect-free.
 */
export function parseOtelMetricRecords(batch: unknown, source = "claude-code"): OtelMetricRecord[] {
  const records: OtelMetricRecord[] = [];
  const resourceMetrics = asArray((batch as { resourceMetrics?: unknown[] })?.resourceMetrics);

  for (const resourceMetric of resourceMetrics) {
    const resourceAttrs = attributesToObject((resourceMetric as { resource?: { attributes?: Attribute[] } }).resource?.attributes);
    for (const scopeMetric of asArray((resourceMetric as { scopeMetrics?: unknown[] }).scopeMetrics)) {
      for (const metric of asArray((scopeMetric as { metrics?: unknown[] }).metrics)) {
        const m = metric as {
          name?: string;
          unit?: string;
          sum?: { dataPoints?: unknown[]; aggregationTemporality?: number; isMonotonic?: boolean };
          gauge?: { dataPoints?: unknown[] };
          histogram?: { dataPoints?: unknown[] };
        };
        const kind = m.sum ? "sum" : m.gauge ? "gauge" : m.histogram ? "histogram" : "unknown";
        const dataPoints = asArray(m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints);

        for (const dataPoint of dataPoints) {
          const dp = dataPoint as {
            attributes?: Attribute[];
            asDouble?: number;
            asInt?: number | string;
            count?: number | string;
            startTimeUnixNano?: string | number;
            timeUnixNano?: string | number;
          };
          const rawValue = dp.asDouble ?? (dp.asInt !== undefined ? Number(dp.asInt) : dp.count !== undefined ? Number(dp.count) : null);
          records.push({
            source,
            metricName: String(m.name ?? ""),
            unit: m.unit ?? null,
            kind,
            temporality: m.sum?.aggregationTemporality ?? null,
            isMonotonic: m.sum?.isMonotonic ?? null,
            value: rawValue !== null && Number.isFinite(rawValue) ? rawValue : null,
            startTimeUnixNano: dp.startTimeUnixNano ?? null,
            timeUnixNano: dp.timeUnixNano ?? null,
            timestamp: Number(unixNanoToMs(dp.timeUnixNano ?? dp.startTimeUnixNano) ?? Date.now()),
            attributes: { ...resourceAttrs, ...attributesToObject(dp.attributes) }
          });
        }
      }
    }
  }

  return records;
}

export function parseOtelLogRecords(batch: unknown): unknown[] {
  const records: unknown[] = [];
  const resourceLogs = asArray((batch as { resourceLogs?: unknown[] })?.resourceLogs);

  for (const resourceLog of resourceLogs) {
    const scopeLogs = asArray((resourceLog as { scopeLogs?: unknown[] }).scopeLogs);
    for (const scopeLog of scopeLogs) {
      records.push(...asArray((scopeLog as { logRecords?: unknown[] }).logRecords));
    }
  }

  return records;
}

export function preferredIdentity(point: Pick<MetricPointInput, "userEmail" | "userAccountId" | "userId">) {
  return point.userEmail ?? point.userAccountId ?? point.userId ?? "unknown";
}

function getMetricDataPoints(metric: unknown): unknown[] {
  const m = metric as {
    sum?: { dataPoints?: unknown[] };
    gauge?: { dataPoints?: unknown[] };
    histogram?: { dataPoints?: unknown[] };
  };
  return asArray(m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints);
}

function numericValue(dataPoint: unknown): number {
  const point = dataPoint as { asDouble?: number; asInt?: number | string; value?: number };
  if (point.asDouble !== undefined) return Number(point.asDouble);
  if (point.asInt !== undefined) return Number(point.asInt);
  if (point.value !== undefined) return Number(point.value);
  return NaN;
}

function stringAttr(attributes: Record<string, unknown>, name: string) {
  const value = attributes[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unixNanoToMs(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return numeric > 10_000_000_000_000 ? Math.floor(numeric / 1_000_000) : numeric;
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

function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}
