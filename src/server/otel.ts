import { createHash } from "node:crypto";
import { sourceFromServiceName } from "../shared/sources.js";
import type { MetricPointInput, OtelLogRecord } from "./types.js";

export type AttributeValue = {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AttributeValue[] };
  kvlistValue?: { values?: Array<{ key: string; value?: AttributeValue }> };
};

export type Attribute = { key: string; value?: AttributeValue };

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

export type OtelSpanRecord = {
  source: string;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  name: string;
  timestamp: number;
  durationMs: number | null;
  attributes: Record<string, unknown>;
};

export type OtelTraceSessionDiagnostic = {
  source: string;
  spanName: string;
  traceId: string | null;
  spanId: string | null;
  selectedSessionId: string;
  serviceName: string | null;
  serviceVersion: string | null;
  operationName: string | null;
  agentName: string | null;
  model: string | null;
  sessionId: string | null;
  sessionUnderscoreId: string | null;
  conversationId: string | null;
  genAiConversationId: string | null;
  copilotChatSessionId: string | null;
  copilotChatChatSessionId: string | null;
  tokenTypes: string[];
  tokenTotal: number;
  attributeKeys: string[];
};

export function parseOtelTraceRecords(batch: unknown): OtelSpanRecord[] {
  const records: OtelSpanRecord[] = [];
  const resourceSpans = asArray((batch as { resourceSpans?: unknown[] })?.resourceSpans);

  for (const resourceSpan of resourceSpans) {
    const resourceAttrs = attributesToObject((resourceSpan as { resource?: { attributes?: Attribute[] } }).resource?.attributes);
    const source = sourceFromAttributes(resourceAttrs);
    for (const scopeSpan of asArray((resourceSpan as { scopeSpans?: unknown[] }).scopeSpans)) {
      for (const span of asArray((scopeSpan as { spans?: unknown[] }).spans)) {
        const s = span as {
          traceId?: string;
          spanId?: string;
          parentSpanId?: string;
          name?: string;
          startTimeUnixNano?: string | number;
          endTimeUnixNano?: string | number;
          attributes?: Attribute[];
        };
        const start = unixNanoToMs(s.startTimeUnixNano);
        const end = unixNanoToMs(s.endTimeUnixNano);
        records.push({
          source,
          traceId: s.traceId ?? null,
          spanId: s.spanId ?? null,
          parentSpanId: s.parentSpanId ?? null,
          name: s.name ?? "",
          timestamp: Number(end ?? start ?? Date.now()),
          durationMs: start != null && end != null ? Math.max(0, end - start) : null,
          attributes: { ...resourceAttrs, ...attributesToObject(s.attributes) }
        });
      }
    }
  }

  return records;
}

// Flattens an OTLP/JSON logs batch into structured records, merging resource + record attributes and
// decoding the body. Codex's native telemetry is logs-only, so this is the seam through which we
// capture (and, later, parse) what it sends. Pure / side-effect-free.
//
// Codex's native telemetry is logs-only, so this is the visibility path for it: records are indexed
// into log_events for inspection (GET /api/logs/events), but token/cost for Codex come from the
// authoritative rollout-JSONL path (`codex-cli-jsonl`), not from these logs — the OTel `codex.sse_event`
// stream is a partial, cost-less subset of the rollout, so ingesting it as metrics would undercount.
export function parseOtelLogRecords(batch: unknown): OtelLogRecord[] {
  const records: OtelLogRecord[] = [];
  const resourceLogs = asArray((batch as { resourceLogs?: unknown[] })?.resourceLogs);

  for (const resourceLog of resourceLogs) {
    const resourceAttrs = attributesToObject((resourceLog as { resource?: { attributes?: Attribute[] } }).resource?.attributes);
    for (const scopeLog of asArray((resourceLog as { scopeLogs?: unknown[] }).scopeLogs)) {
      for (const logRecord of asArray((scopeLog as { logRecords?: unknown[] }).logRecords)) {
        const lr = logRecord as {
          eventName?: string;
          name?: string;
          severityText?: string;
          timeUnixNano?: string | number;
          observedTimeUnixNano?: string | number;
          attributes?: Attribute[];
          body?: AttributeValue;
        };
        const attributes = { ...resourceAttrs, ...attributesToObject(lr.attributes) };
        // Event name: the semantic `event.name` attribute FIRST (what both Claude Code and Codex
        // actually set to the real id), then the loose top-level `eventName`/`name`. Codex's tracing
        // appender pollutes the top-level `eventName` with a Rust source location (e.g.
        // "event otel/src/.../session_telemetry.rs:778") and carries the true id (`codex.sse_event`, …)
        // only in the attribute — so attribute-first is what keeps records from being mislabeled.
        const eventName =
          stringAttr(attributes, "event.name") ||
          (typeof lr.eventName === "string" && lr.eventName) ||
          (typeof lr.name === "string" && lr.name) ||
          null;
        records.push({
          eventName,
          severityText: typeof lr.severityText === "string" ? lr.severityText : null,
          timestamp: Number(unixNanoToMs(lr.timeUnixNano ?? lr.observedTimeUnixNano) ?? Date.now()),
          sessionId:
            stringAttr(attributes, "session.id") ??
            stringAttr(attributes, "session_id") ??
            stringAttr(attributes, "conversation.id") ??
            null,
          attributes,
          body: decodeAttributeValue(lr.body)
        });
      }
    }
  }

  return records;
}

export function preferredIdentity(point: Pick<MetricPointInput, "userEmail" | "userAccountId" | "userId">) {
  return point.userEmail ?? point.userAccountId ?? point.userId ?? "unknown";
}

let warnedCumulative = false;

// Our token/cost aggregation sums data points, which is only correct for DELTA temporality (Claude
// Code's default). Warn once if a backend ever sends CUMULATIVE, which would overcount.
export function warnIfCumulative(records: OtelMetricRecord[]) {
  if (warnedCumulative) return;
  const cumulative = records.some(
    (record) => record.temporality === 2 && (record.metricName === "claude_code.token.usage" || record.metricName === "claude_code.cost.usage")
  );
  if (cumulative) {
    warnedCumulative = true;
    console.warn(
      "[finius] OTLP metrics arrived with CUMULATIVE temporality; token/cost totals assume DELTA and will overcount. Set OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta."
    );
  }
}

export function getMetricDataPoints(metric: unknown): unknown[] {
  const m = metric as {
    sum?: { dataPoints?: unknown[] };
    gauge?: { dataPoints?: unknown[] };
    histogram?: { dataPoints?: unknown[] };
  };
  return asArray(m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints);
}

export function numericValue(dataPoint: unknown): number {
  const point = dataPoint as { asDouble?: number; asInt?: number | string; value?: number; sum?: number };
  if (point.asDouble !== undefined) return Number(point.asDouble);
  if (point.asInt !== undefined) return Number(point.asInt);
  if (point.value !== undefined) return Number(point.value);
  if (point.sum !== undefined) return Number(point.sum);
  return NaN;
}

export function stringAttr(attributes: Record<string, unknown>, name: string) {
  const value = attributes[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function unixNanoToMs(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return numeric > 10_000_000_000_000 ? Math.floor(numeric / 1_000_000) : numeric;
}

export function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

export function sourceFromAttributes(attributes: Record<string, unknown>): string {
  return sourceFromServiceName(stringAttr(attributes, "service.name"));
}

// Selects the spans that carry gen_ai token usage, preferring the agent-root spans when present so we
// don't double-count child LLM spans. Vendor-neutral (gen_ai semantic conventions); shared by provider
// trace parsers.
export function selectedTokenSpans(spans: OtelSpanRecord[]): OtelSpanRecord[] {
  const withTokens = spans.filter((span) => tokenEntries(span.attributes).length > 0);
  const roots = withTokens.filter((span) => stringAttr(span.attributes, "gen_ai.operation.name") === "invoke_agent" || span.name.startsWith("invoke_agent"));
  return roots.length ? roots : withTokens;
}

// Decodes the gen_ai.usage.* token attributes on a span. Vendor-neutral; shared by provider trace parsers.
export function tokenEntries(attributes: Record<string, unknown>): Array<[string, number]> {
  const pairs: Array<[string, number]> = [];
  for (const [attr, tokenType] of [
    ["gen_ai.usage.input_tokens", "input"],
    ["gen_ai.usage.output_tokens", "output"],
    ["gen_ai.usage.cache_read.input_tokens", "cache_read"],
    ["gen_ai.usage.cache_creation.input_tokens", "cache_creation"]
  ] as const) {
    const value = Number(attributes[attr]);
    if (Number.isFinite(value) && value > 0) pairs.push([tokenType, value]);
  }
  return pairs;
}
