import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type BlobStore, LocalBlobStore } from "./blob.js";
import { detectTranscriptFormat, parseTranscript, shouldReplaceBySession } from "../transcripts.js";
import { parseOtelLogRecords, parseOtelMetricRecords, parseOtelTraceRecords, preferredIdentity, stableHash, warnIfCumulative } from "../otel.js";
import { parseOtelMetricPoints } from "../providers/claude.js";
import { otelTraceSessionDiagnostics, parseOtelTracePoints } from "../providers/copilot.js";
import { computeCostPoints, type PriceIndex } from "../pricing.js";
import type { SnapshotFetcher } from "../pricing-backfill.js";
import { SerialQueue } from "../queue.js";
import { GRANULARITY_MS } from "../db/fragments.js";
import { type DrizzleDb, connect, runMigrations } from "../db/client.js";
import * as auth from "../db/auth.js";
import * as usersDb from "../db/users.js";
import * as metrics from "../db/metrics.js";
import * as sessionsDb from "../db/sessions.js";
import * as people from "../db/people.js";
import * as ingest from "../db/ingest.js";
import * as pricingStore from "../db/pricing-store.js";
import type {
  AuthTokenRecord,
  AuthUser,
  FilterOptions,
  Granularity,
  ImportResult,
  LogEventSummary,
  MetricPointInput,
  ModelPrice,
  ModelSummary,
  ModelTimeseriesPoint,
  OAuthUserInput,
  OtelLogRecord,
  PersonSummary,
  SessionSummary,
  StorageAdapter,
  Summary,
  SummaryFilters,
  TelemetryIdentity,
  TranscriptFormat,
  TimeseriesPoint,
  TranscriptInfo
} from "../types.js";

type Database = InstanceType<typeof DatabaseSync>;

export type DrizzleStorageOptions = {
  // When false (FINIUS_RAW_PAYLOADS=off), raw_batches stores only the dedup hash, not the payload.
  // This disables replay/backfill of new metric kinds from history but keeps the DB lean.
  storeRawPayloads?: boolean;
  // Where imported transcript files are persisted. Defaults to a LocalBlobStore under the DB dir.
  blob?: BlobStore;
};

export class DrizzleStorageAdapter implements StorageAdapter {
  // The raw node:sqlite handle. Only used for close(); all query work goes through this.orm.
  private db: Database;
  // The Drizzle handle wrapping the same connection.
  private orm: DrizzleDb;
  private storeRawPayloads: boolean;
  private blob: BlobStore;
  // In-memory model→price lookup, loaded from model_prices at construction and refreshed on
  // importPricing. The cost-synthesis hot path reads this synchronously.
  private priceIndex: PriceIndex = new Map();
  // The earliest effective_date we hold any price for; usage before this day has no historical price
  // and triggers a backfill fetch. null = no pricing at all yet.
  private earliestPriceDate: number | null = null;
  // The single processing queue behind JSONL uploads (parse → metrics → cost → pricing backfill).
  private ingestQueue = new SerialQueue();
  // Content hashes whose processing is queued/in-flight — dedups repeat uploads before the persistent
  // source_files dedup row exists (which we only write on success, so a failed job can be retried).
  private inFlight = new Set<string>();
  // Day buckets (YYYY-MM-DD) we've already asked the historical fetcher for, so we fetch each once.
  private fetchedPriceDays = new Set<string>();
  // Fetches historical pricing for a day (injected by startServer; absent in tests = no network).
  private historicalFetcher?: SnapshotFetcher;
  // Notified when a queued import finishes, so the server can publish the SSE 'ingest' event.
  private processingListener?: (signal: string, result: ImportResult) => void;

  constructor(path: string, options: DrizzleStorageOptions = {}) {
    this.storeRawPayloads = options.storeRawPayloads ?? true;
    this.blob = options.blob ?? new LocalBlobStore(join(dirname(path), "transcripts"));
    // connect() opens the DB (creating the dir), applies the WAL + foreign_keys PRAGMAs, and wraps it
    // with Drizzle. Keep the raw DatabaseSync as this.db for close(); all query work goes through this.orm.
    const { db, sqlite } = connect(path);
    this.db = sqlite;
    this.orm = db;
    // Build the schema via the drizzle-kit migrations (the generated migrations are the single source
    // of truth; the migrator creates everything on a fresh DB and is a no-op once applied).
    runMigrations(db);
    this.loadPricing();
  }

  async ingestOtelMetrics(batch: unknown, identity?: TelemetryIdentity) {
    const hash = stableHash("otlp_metrics", batch);
    const rawBatchId = ingest.insertRawBatch(this.orm, "otlp_metrics", hash, batch, this.storeRawPayloads);
    if (rawBatchId === null) return { duplicate: true, points: 0 };

    const points = parseOtelMetricPoints(batch).map((point) => withTelemetryIdentity(point, identity));
    // Still parsed (not persisted) so we can warn once if a backend sends CUMULATIVE temporality.
    warnIfCumulative(parseOtelMetricRecords(batch));
    debugOtelSignal("metrics", () => metricDebugEvents(points));

    this.orm.transaction(() => ingest.ingestMetricPoints(this.orm, points, rawBatchId));

    return { duplicate: false, points: points.length };
  }

  async ingestOtelTraces(batch: unknown, identity?: TelemetryIdentity) {
    const hash = stableHash("otlp_traces", batch);
    const rawBatchId = ingest.insertRawBatch(this.orm, "otlp_traces", hash, batch, this.storeRawPayloads);
    if (rawBatchId === null) return { duplicate: true, spans: 0, points: 0 };

    const spans = parseOtelTraceRecords(batch);
    const tokenPoints = parseOtelTracePoints(batch).map((point) => withTelemetryIdentity(point, identity));
    debugOtelSignal("traces", () => traceDebugEvents(batch));
    const points = [...tokenPoints, ...computeCostPoints(tokenPoints, this.priceIndex)];

    this.orm.transaction(() => ingest.ingestMetricPoints(this.orm, points, rawBatchId));

    void this.backfillHistoricalPricing(tokenPoints).catch((err) =>
      console.warn(`[finius] historical pricing backfill for OTLP traces failed: ${(err as Error).message}`)
    );
    return { duplicate: false, spans: spans.length, points: points.length };
  }

  async ingestOtelLogs(batch: unknown) {
    const hash = stableHash("otlp_logs", batch);
    const rawBatchId = ingest.insertRawBatch(this.orm, "otlp_logs", hash, batch, this.storeRawPayloads);
    if (rawBatchId === null) return { duplicate: true, events: 0 };

    // Logs are indexed into log_events for inspection (GET /api/logs/events) but NOT aggregated into
    // metric_points. Claude's tokens/cost come from its metrics; Codex's come from the authoritative
    // rollout-JSONL path (`codex-cli-jsonl`). Codex's logs-only OTel (`codex.sse_event`) is a partial,
    // cost-less subset of the rollout, so counting it here would undercount and drop cost — we keep it
    // visible as log_events only. raw_batches still holds the verbatim payload for replay.
    const records = parseOtelLogRecords(batch);
    debugOtelSignal("logs", () => logDebugEvents(records));
    this.orm.transaction(() => ingest.insertLogEvents(this.orm, records, rawBatchId));
    return { duplicate: false, events: records.length };
  }

  async getLogEventSummary(): Promise<LogEventSummary[]> {
    return people.getLogEventSummary(this.orm);
  }

  // Synchronous import: persist + fully process in one call. Used by tests, the CLI backfill (direct),
  // and anywhere a caller wants the ImportResult back. The HTTP upload path uses enqueueImport instead.
  async importJsonl(
    source: string,
    sessionHint: Partial<MetricPointInput>,
    content: string,
    format?: TranscriptFormat
  ): Promise<ImportResult> {
    const hash = createHash("sha256").update(content).digest("hex");
    if (this.isDuplicateUpload(hash)) return { duplicate: true, importedLines: 0, malformedLines: 0, metricPoints: 0, rawEvents: 0 };
    await this.blob.save(hash, content);
    return this.processImport(source, sessionHint, content, hash, format);
  }

  // Upload path: save the blob IMMEDIATELY (so the file is durable the moment we accept it) and hand
  // the parsing/metrics/cost work to the single background processing queue. Returns as soon as the
  // job is queued; the SSE 'ingest' event fires from the queue when the job completes.
  async enqueueImport(
    source: string,
    sessionHint: Partial<MetricPointInput>,
    content: string,
    format?: TranscriptFormat
  ): Promise<{ duplicate: boolean; queued: boolean }> {
    const hash = createHash("sha256").update(content).digest("hex");
    if (this.isDuplicateUpload(hash)) return { duplicate: true, queued: false };
    this.inFlight.add(hash);
    await this.blob.save(hash, content); // persisted immediately, before we return
    this.ingestQueue.enqueue(async () => {
      try {
        const result = await this.processImport(source, sessionHint, content, hash, format);
        this.processingListener?.("jsonl", result);
      } finally {
        this.inFlight.delete(hash);
      }
    });
    return { duplicate: false, queued: true };
  }

  // Drains the processing queue — for tests and graceful shutdown.
  async settleIngest(): Promise<void> {
    await this.ingestQueue.settle();
  }

  setProcessingListener(listener: (signal: string, result: ImportResult) => void): void {
    this.processingListener = listener;
  }

  // Injected by startServer: how to fetch the LiteLLM price file as it existed on a given day. Absent
  // (e.g. in tests, or FINIUS_PRICING_FETCH=off) means no historical backfill — cost uses what we have.
  setHistoricalPriceFetcher(fetcher: SnapshotFetcher): void {
    this.historicalFetcher = fetcher;
  }

  // Already-imported (persistent) or queued/in-flight (in-memory) — either way, don't re-process.
  private isDuplicateUpload(hash: string): boolean {
    if (this.inFlight.has(hash)) return true;
    return ingest.uploadExists(this.orm, hash);
  }

  // The actual processing step (queued, or run inline by importJsonl): parse → backfill any missing
  // historical pricing → synthesize cost → insert points + record the source file. The blob is already
  // saved by the caller; this never touches raw_batches.
  private async processImport(
    source: string,
    sessionHint: Partial<MetricPointInput>,
    content: string,
    hash: string,
    format?: TranscriptFormat
  ): Promise<ImportResult> {
    const lines = content.split(/\r?\n/);
    // Pluggable per-agent parser: explicit format wins, else sniff (Claude vs Codex).
    const resolvedFormat = format ?? detectTranscriptFormat(lines);
    const effectiveSessionHint =
      resolvedFormat === "copilot"
        ? { ...sessionHint, sessionId: ingest.resolveCopilotTranscriptSession(this.orm, sessionHint.sessionId) ?? sessionHint.sessionId }
        : sessionHint;
    const parsed = parseTranscript(resolvedFormat, source, effectiveSessionHint, lines);

    // If this transcript has usage on days we hold no price for, fetch the historical pricing now
    // (serial, deduped) so the cost we synthesize below uses the rate in effect at the time.
    await this.backfillHistoricalPricing(parsed.points);

    this.orm.transaction(() => {
      // Some agents (Codex) write ONE append-only file per session and re-upload it as it grows; for
      // those, replace the session's prior points for this source so a longer re-upload doesn't
      // double-count. (Identical re-uploads already short-circuited on the content hash.) A replaced
      // source whose signal is its provider's preferred one (e.g. Codex JSONL) had its old points in the
      // rollup, so we rebuild it below to restore the invariant.
      const replacedPrimary = shouldReplaceBySession(resolvedFormat)
        ? ingest.replaceSessionPoints(this.orm, source, [...new Set(parsed.points.map((p) => p.sessionId))])
        : false;
      // Synthesize cost when the transcript didn't carry it (Codex never does; Claude JSONL rarely
      // does). The computed points copy their token point's source, so a primary-source transcript
      // (Codex/manual) gets its computed cost into the rollup too, while a comparison-only transcript
      // (claude-code-jsonl / copilot-vscode-jsonl) stays out of dashboards. When the transcript DID
      // report a real cost point, we leave it as-is and synthesize nothing.
      const hasReportedCost = parsed.points.some((p) => p.kind === "cost");
      const pointsToInsert = hasReportedCost
        ? parsed.points
        : [...parsed.points, ...computeCostPoints(parsed.points, this.priceIndex)];
      for (const point of pointsToInsert) {
        const { isPrimary } = ingest.insertMetricPoint(this.orm, point, null);
        // Feed the rollup from the point's DYNAMIC primacy. A transcript import never triggers a
        // transition: for Claude/Copilot the transcript is the non-preferred signal (so it's primary
        // only when the session has no OTel — fallback — and never demotes anything); for Codex/manual
        // it IS the preferred signal and there's no other signal to demote. When a replace-by-session
        // delete made the rollup stale, we skip incremental upserts and rebuild wholesale below.
        if (isPrimary && !replacedPrimary) ingest.upsertRollup(this.orm, point);
      }
      // The replace-by-session delete left the rollup holding the now-deleted points; rebuild it from
      // the surviving primary points so the rollup invariant (== aggregate of is_primary=1 points) holds.
      if (replacedPrimary) ingest.rebuildRollup(this.orm);
      // Link the file to the single session row for its UUID (inserting the points above already
      // upserted it, recording has_jsonl). "View transcript" then surfaces on that one session.
      const sessionId = effectiveSessionHint.sessionId ?? parsed.points[0]?.sessionId ?? null;
      ingest.recordSourceFile(this.orm, {
        source,
        sessionId,
        hash,
        byteSize: Buffer.byteLength(content),
        lineCount: parsed.result.importedLines
      });
    });

    return parsed.result;
  }

  // For each token-usage day earlier than the earliest price we hold, fetch that day's historical
  // pricing (once per day, ever) and import it; then recompute prior computed cost so older imports get
  // re-priced too. No-op when no fetcher is wired or the days are already covered.
  private async backfillHistoricalPricing(points: MetricPointInput[]): Promise<void> {
    if (!this.historicalFetcher) return;
    const DAY = GRANULARITY_MS.day;
    const earliestDay = this.earliestPriceDate == null ? Infinity : Math.floor(this.earliestPriceDate / DAY) * DAY;
    const days = new Set<number>();
    for (const p of points) {
      if (p.kind !== "tokens") continue;
      const day = Math.floor(p.timestamp / DAY) * DAY;
      if (day < earliestDay) days.add(day);
    }
    let imported = false;
    for (const dayMs of days) {
      const dayIso = new Date(dayMs).toISOString().slice(0, 10);
      if (this.fetchedPriceDays.has(dayIso)) continue;
      this.fetchedPriceDays.add(dayIso);
      try {
        const prices = await this.historicalFetcher(dayIso);
        if (prices && prices.length) {
          await this.importPricing(prices);
          imported = true;
        }
      } catch (err) {
        console.warn(`[finius] historical pricing fetch for ${dayIso} failed: ${(err as Error).message}`);
      }
    }
    // Re-price previously-imported transcripts now that we have older rates (idempotent).
    if (imported) await this.recomputeComputedCost();
  }

  async getSessionTranscript(sessionRowId: number): Promise<{ content: string; source: string; importedAt: number } | null> {
    const row = ingest.getSourceFileForSession(this.orm, sessionRowId);
    if (!row) return null;
    const bytes = await this.blob.read(row.blobKey);
    if (!bytes) return null;
    return { content: bytes.toString("utf8"), source: row.source, importedAt: row.importedAt };
  }

  // Metadata only (no blob read) so the UI can decide whether to show a "view transcript" link.
  async getSessionTranscriptInfo(sessionRowId: number): Promise<TranscriptInfo | null> {
    return ingest.getSessionTranscriptInfo(this.orm, sessionRowId);
  }

  async getSummary(filters: SummaryFilters): Promise<Summary> {
    return metrics.getSummary(this.orm, filters);
  }

  async getTimeseries(filters: SummaryFilters & { granularity?: Granularity }): Promise<TimeseriesPoint[]> {
    return metrics.getTimeseries(this.orm, filters);
  }

  async getModelTimeseries(filters: SummaryFilters & { granularity?: Granularity }): Promise<ModelTimeseriesPoint[]> {
    return metrics.getModelTimeseries(this.orm, filters);
  }

  async listSessions(filters: SummaryFilters): Promise<SessionSummary[]> {
    return sessionsDb.listSessions(this.orm, filters);
  }

  async getSession(id: number): Promise<SessionSummary | null> {
    return sessionsDb.getSession(this.orm, id);
  }

  async listPeople(filters: SummaryFilters): Promise<PersonSummary[]> {
    return people.listPeople(this.orm, filters);
  }

  async listModels(filters: SummaryFilters): Promise<ModelSummary[]> {
    return people.listModels(this.orm, filters);
  }

  async getFilterOptions(): Promise<FilterOptions> {
    return people.getFilterOptions(this.orm);
  }

  close() {
    this.db.close();
  }

  async pruneRawBatches(beforeTimestampMs: number): Promise<{ deleted: number }> {
    return ingest.pruneRawBatches(this.orm, beforeTimestampMs);
  }

  createAuthToken(tokenHash: string, label: string, now: number, userRowId: number | null = null): void {
    auth.createAuthToken(this.orm, tokenHash, label, now, userRowId);
  }

  findAuthToken(tokenHash: string): { id: number; revoked: number; userRowId: number | null } | null {
    return auth.findAuthToken(this.orm, tokenHash);
  }

  listAuthTokens(): AuthTokenRecord[] {
    return auth.listAuthTokens(this.orm);
  }

  revokeAuthToken(id: number): void {
    auth.revokeAuthToken(this.orm, id);
  }

  getUserById(id: number): AuthUser | null {
    return usersDb.getUserById(this.orm, id);
  }

  upsertOAuthUser(input: OAuthUserInput, now: number): AuthUser {
    return usersDb.upsertOAuthUser(this.orm, input, now);
  }

  // Load model_prices into the in-memory index that cost synthesis reads. Called at construction and
  // after every importPricing so the hot path never touches the DB.
  private loadPricing() {
    const { index, earliest } = pricingStore.loadPriceIndex(this.orm);
    this.priceIndex = index;
    this.earliestPriceDate = earliest;
  }

  async getPricing(): Promise<ModelPrice[]> {
    return pricingStore.getPricing(this.orm);
  }

  // Upsert dated price rows (newer effective_date wins for a given model) and reload the index.
  async importPricing(prices: ModelPrice[]): Promise<{ imported: number }> {
    const result = pricingStore.importPricing(this.orm, prices);
    this.loadPricing();
    return result;
  }

  async recomputeComputedCost(): Promise<{ costPoints: number }> {
    return pricingStore.recomputeComputedCost(this.orm, this.priceIndex);
  }

  // Re-materialize metric_points.is_primary for the whole table from first principles (the registry's
  // preferred-signal precedence) and rebuild the rollup to match. Idempotent repair for any drift in
  // the stored flag (e.g. a bad historical backfill, a precedence-rule change). Exposed via the
  // cron-token-guarded /api/maintenance/rebuild-primary endpoint.
  async rebuildIsPrimary(): Promise<void> {
    this.orm.transaction(() => {
      ingest.rebuildIsPrimary(this.orm);
      ingest.rebuildRollup(this.orm);
    });
  }

}

function withTelemetryIdentity(point: MetricPointInput, identity?: TelemetryIdentity): MetricPointInput {
  if (!identity) return point;
  return {
    ...point,
    userEmail: point.userEmail ?? identity.userEmail,
    userId: point.userId ?? identity.userId,
    userAccountId: point.userAccountId ?? identity.userAccountId,
    githubLogin: point.githubLogin ?? identity.githubLogin,
    displayName: point.displayName ?? identity.displayName
  };
}

// FINIUS_DEBUG_OTEL_SESSIONS — when set, surface every OTLP event we ingest across ALL three signals
// (metrics, logs, traces) so you can see which session each one lands on. "1"/"true"/"stderr" prints a
// readable, indented summary to stderr; any other value is treated as a file path that receives one
// structured NDJSON line per batch (machine-readable, for grepping). The `build` thunk is only invoked
// when the var is set, so parsing/formatting is free when debugging is off.
type OtelDebugEvent = { line: string; data: Record<string, unknown> };

function debugOtelSignal(signal: "metrics" | "logs" | "traces", build: () => OtelDebugEvent[]): void {
  const target = process.env.FINIUS_DEBUG_OTEL_SESSIONS;
  if (!target) return;

  const events = build();
  if (events.length === 0) return;

  const toStderr = target === "1" || target.toLowerCase() === "true" || target.toLowerCase() === "stderr";
  if (!toStderr) {
    const line = JSON.stringify({ at: Date.now(), signal, count: events.length, events: events.map((e) => e.data) });
    try {
      appendFileSync(target, `${line}\n`, "utf8");
    } catch (error) {
      console.error(`[finius] OTLP ${signal} session diagnostics failed: ${(error as Error).message}`);
    }
    return;
  }

  const noun = events.length === 1 ? "event" : "events";
  const header = `[finius] OTLP ${signal} ▸ ${events.length} ${noun}`;
  const body = events.map((e) => `    · ${e.line}`).join("\n");
  console.error(`${header}\n${body}`);
}

// Compact a long session/conversation UUID so it stays scannable in the console (otherwise the id
// dominates every line).
function debugShortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function debugCompactNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function metricDebugEvents(points: MetricPointInput[]): OtelDebugEvent[] {
  return points.map((p) => {
    const label = p.kind === "cost" ? `cost=$${p.value}` : `${p.kind}${p.tokenType ? `/${p.tokenType}` : ""}=${debugCompactNum(p.value)}`;
    const identity = preferredIdentity(p);
    return {
      line: `${debugShortId(p.sessionId)}  ${label}  model=${p.model ?? "—"}  by=${identity}  src=${p.source}`,
      data: {
        source: p.source,
        sessionId: p.sessionId,
        model: p.model ?? null,
        kind: p.kind,
        tokenType: p.tokenType ?? null,
        value: p.value,
        unit: p.unit ?? null,
        identity
      }
    };
  });
}

function logDebugEvents(records: OtelLogRecord[]): OtelDebugEvent[] {
  return records.map((r) => ({
    line: `${debugShortId(r.sessionId)}  ${r.eventName ?? "(unnamed)"}${r.severityText ? `  [${r.severityText}]` : ""}`,
    data: { eventName: r.eventName, severity: r.severityText, sessionId: r.sessionId, timestamp: r.timestamp }
  }));
}

function traceDebugEvents(batch: unknown): OtelDebugEvent[] {
  return otelTraceSessionDiagnostics(batch).map((d) => ({
    line: `${debugShortId(d.selectedSessionId)}  ${d.spanName}  model=${d.model ?? "—"}  tokens=${debugCompactNum(d.tokenTotal)}  src=${d.source}`,
    data: d as unknown as Record<string, unknown>
  }));
}
