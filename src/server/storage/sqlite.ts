import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type BlobStore, LocalBlobStore } from "./blob.js";
import { detectTranscriptFormat, parseTranscript, shouldReplaceBySession } from "../transcripts.js";
import { parseOtelLogRecords, parseOtelMetricPoints, parseOtelMetricRecords, preferredIdentity, stableHash } from "../otel.js";
import type { OtelMetricRecord } from "../otel.js";
import { COMPUTED_COST_METRIC, computeCostPoints, indexPrices, type PriceIndex } from "../pricing.js";
import type { SnapshotFetcher } from "../pricing-backfill.js";
import { SerialQueue } from "../queue.js";
import { EFFECTIVE_ROLLUP, GRANULARITY_MS, OTEL_SOURCE, canUseRollup, jsonlWins, pointWhere, rollupWhere } from "./query-helpers.js";
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
  PersonSummary,
  SessionSummary,
  StorageAdapter,
  Summary,
  SummaryFilters,
  TranscriptFormat,
  TimeseriesPoint,
  TranscriptInfo
} from "../types.js";

// Friendly identity fields resolved from the `users` registry and attached to display rows (People,
// the summary Users breakdown, sessions) so lists can prefer a GitHub login / display name over email.
type UserIdentityFields = { email: string | null; displayName: string | null; githubLogin: string | null };

type Database = InstanceType<typeof DatabaseSync>;

export type SqliteStorageOptions = {
  // When false (FINIUS_RAW_PAYLOADS=off), raw_batches stores only the dedup hash, not the payload.
  // This disables replay/backfill of new metric kinds from history but keeps the DB lean.
  storeRawPayloads?: boolean;
  // Where imported transcript files are persisted. Defaults to a LocalBlobStore under the DB dir.
  blob?: BlobStore;
};

export class SqliteStorageAdapter implements StorageAdapter {
  private db: Database;
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

  constructor(path: string, options: SqliteStorageOptions = {}) {
    this.storeRawPayloads = options.storeRawPayloads ?? true;
    this.blob = options.blob ?? new LocalBlobStore(join(dirname(path), "transcripts"));
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.loadPricing();
  }

  async ingestOtelMetrics(batch: unknown) {
    const hash = stableHash("otlp_metrics", batch);
    const rawBatchId = this.insertRawBatch("otlp_metrics", hash, batch);
    if (rawBatchId === null) return { duplicate: true, points: 0 };

    const points = parseOtelMetricPoints(batch);
    // Still parsed (not persisted) so we can warn once if a backend sends CUMULATIVE temporality.
    warnIfCumulative(parseOtelMetricRecords(batch));

    this.db.exec("BEGIN");
    try {
      for (const point of points) {
        this.insertMetricPoint(point, rawBatchId);
        this.upsertRollup(point);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { duplicate: false, points: points.length };
  }

  async ingestOtelLogs(batch: unknown) {
    const hash = stableHash("otlp_logs", batch);
    const rawBatchId = this.insertRawBatch("otlp_logs", hash, batch);
    if (rawBatchId === null) return { duplicate: true, events: 0 };

    // Logs are indexed into log_events for inspection (GET /api/logs/events) but NOT aggregated into
    // metric_points. Claude's tokens/cost come from its metrics; Codex's come from the authoritative
    // rollout-JSONL path (`codex-cli-jsonl`). Codex's logs-only OTel (`codex.sse_event`) is a partial,
    // cost-less subset of the rollout, so counting it here would undercount and drop cost — we keep it
    // visible as log_events only. raw_batches still holds the verbatim payload for replay.
    const records = parseOtelLogRecords(batch);
    const insert = this.db.prepare(
      `INSERT INTO log_events (event_name, severity, session_id, timestamp, attributes_json, body_json, raw_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.exec("BEGIN");
    try {
      for (const record of records) {
        insert.run(
          record.eventName,
          record.severityText,
          record.sessionId,
          record.timestamp,
          JSON.stringify(record.attributes ?? {}),
          record.body === undefined ? null : JSON.stringify(record.body ?? null),
          rawBatchId
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { duplicate: false, events: records.length };
  }

  // Grouped inspection view of captured log records: one row per distinct event name with a count,
  // the latest timestamp, and a single sample (most recent) so we can see what Codex actually emits.
  async getLogEventSummary(): Promise<LogEventSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT
          COALESCE(event_name, '(unnamed)') AS eventName,
          COUNT(*) AS count,
          MAX(timestamp) AS lastSeenAt,
          (SELECT attributes_json FROM log_events e2
             WHERE COALESCE(e2.event_name, '(unnamed)') = COALESCE(e1.event_name, '(unnamed)')
             ORDER BY e2.timestamp DESC LIMIT 1) AS sampleAttributes,
          (SELECT body_json FROM log_events e2
             WHERE COALESCE(e2.event_name, '(unnamed)') = COALESCE(e1.event_name, '(unnamed)')
             ORDER BY e2.timestamp DESC LIMIT 1) AS sampleBody
        FROM log_events e1
        GROUP BY COALESCE(event_name, '(unnamed)')
        ORDER BY count DESC`
      )
      .all() as Array<{ eventName: string; count: number; lastSeenAt: number; sampleAttributes: string | null; sampleBody: string | null }>;
    return rows.map((row) => ({
      eventName: row.eventName,
      count: row.count,
      lastSeenAt: row.lastSeenAt,
      sample: row.sampleAttributes
        ? { attributes: safeParse(row.sampleAttributes) as Record<string, unknown>, body: safeParse(row.sampleBody) }
        : null
    }));
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
    return !!this.db.prepare("SELECT 1 FROM source_files WHERE hash = ?").get(hash);
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
    const parsed = parseTranscript(resolvedFormat, source, sessionHint, lines);

    // If this transcript has usage on days we hold no price for, fetch the historical pricing now
    // (serial, deduped) so the cost we synthesize below uses the rate in effect at the time.
    await this.backfillHistoricalPricing(parsed.points);

    this.db.exec("BEGIN");
    try {
      // Some agents (Codex) write ONE append-only file per session and re-upload it as it grows; for
      // those, replace the session's prior points for this source so a longer re-upload doesn't
      // double-count. (Identical re-uploads already short-circuited on the content hash.)
      if (shouldReplaceBySession(resolvedFormat)) {
        const sessionIds = [...new Set(parsed.points.map((p) => p.sessionId))];
        const del = this.db.prepare(
          "DELETE FROM metric_points WHERE source = ? AND signal = 'jsonl' AND session_row_id IN (SELECT id FROM sessions WHERE session_id = ?)"
        );
        for (const sid of sessionIds) del.run(source, sid);
      }
      // Synthesize cost when the transcript didn't carry it (Codex never does; Claude JSONL rarely
      // does). The computed points share signal:'jsonl' so jsonlWins/EFFECTIVE_ROLLUP shadow them for
      // any session that also has authoritative OTel cost — no double counting. When the transcript
      // DID report a real cost point, we leave it as-is and synthesize nothing.
      const hasReportedCost = parsed.points.some((p) => p.kind === "cost");
      const pointsToInsert = hasReportedCost
        ? parsed.points
        : [...parsed.points, ...computeCostPoints(parsed.points, this.priceIndex)];
      for (const point of pointsToInsert) {
        // JSONL metrics deliberately do NOT feed the rollup: OTel is authoritative, so the rollup
        // stays OTel-only and the JSONL fallback is folded in at read time (see EFFECTIVE_ROLLUP /
        // jsonlWins). This keeps a session that has both signals from being double-counted.
        this.insertMetricPoint(point, null);
      }
      // Link the file to the single session row for its UUID (inserting the points above already
      // upserted it, recording has_jsonl). "View transcript" then surfaces on that one session.
      const sessionId = sessionHint.sessionId ?? parsed.points[0]?.sessionId ?? null;
      const sessionRow = sessionId
        ? (this.db.prepare("SELECT id FROM sessions WHERE session_id = ?").get(sessionId) as { id: number } | undefined)
        : undefined;
      this.db
        .prepare(
          `INSERT INTO source_files (source, session_row_id, session_id, hash, blob_key, byte_size, line_count, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(source, sessionRow?.id ?? null, sessionId, hash, hash, Buffer.byteLength(content), parsed.result.importedLines, Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

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
    const row = this.db
      .prepare("SELECT blob_key AS blobKey, source, imported_at AS importedAt FROM source_files WHERE session_row_id = ? ORDER BY imported_at DESC LIMIT 1")
      .get(sessionRowId) as { blobKey: string; source: string; importedAt: number } | undefined;
    if (!row) return null;
    const bytes = await this.blob.read(row.blobKey);
    if (!bytes) return null;
    return { content: bytes.toString("utf8"), source: row.source, importedAt: row.importedAt };
  }

  // Metadata only (no blob read) so the UI can decide whether to show a "view transcript" link.
  async getSessionTranscriptInfo(sessionRowId: number): Promise<TranscriptInfo | null> {
    const row = this.db
      .prepare(
        "SELECT source, imported_at AS importedAt, byte_size AS byteSize, line_count AS lineCount FROM source_files WHERE session_row_id = ? ORDER BY imported_at DESC LIMIT 1"
      )
      .get(sessionRowId) as TranscriptInfo | undefined;
    return row ?? null;
  }

  async getSummary(filters: SummaryFilters): Promise<Summary> {
    // The rollup has no session dimension, so a session-filtered summary falls back to metric_points.
    return canUseRollup(filters) ? this.summaryFromRollup(filters) : this.summaryFromPoints(filters);
  }

  // Served from the pre-aggregated rollup. Scalar totals + activeSenders sum cleanly from rollup
  // rows; sessionCount is a distinct count that cannot be summed across buckets, so it stays on
  // metric_points (see upsertRollup note).
  private summaryFromRollup(filters: SummaryFilters): Summary {
    const { where, params } = rollupWhere(filters);
    const totals = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN kind = 'cost' THEN sum_value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'input' THEN sum_value ELSE 0 END), 0) AS inputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'output' THEN sum_value ELSE 0 END), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'cache_creation' THEN sum_value ELSE 0 END), 0) AS cacheCreationTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'cache_read' THEN sum_value ELSE 0 END), 0) AS cacheReadTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN sum_value ELSE 0 END), 0) AS totalTokens,
          COALESCE(SUM(CASE WHEN kind = 'lines' AND token_type = 'added' THEN sum_value ELSE 0 END), 0) AS linesAdded,
          COALESCE(SUM(CASE WHEN kind = 'lines' AND token_type = 'removed' THEN sum_value ELSE 0 END), 0) AS linesRemoved,
          COALESCE(SUM(CASE WHEN kind = 'decision' AND token_type = 'accept' THEN sum_value ELSE 0 END), 0) AS editsAccepted,
          COALESCE(SUM(CASE WHEN kind = 'decision' AND token_type = 'reject' THEN sum_value ELSE 0 END), 0) AS editsRejected,
          COALESCE(SUM(CASE WHEN kind = 'pull_request' THEN sum_value ELSE 0 END), 0) AS pullRequests,
          COALESCE(SUM(CASE WHEN kind = 'commit' THEN sum_value ELSE 0 END), 0) AS commits,
          COUNT(DISTINCT user_identity) AS activeSenders
        FROM ${EFFECTIVE_ROLLUP} AS r ${where}`
      )
      .get(...params) as Record<string, number>;

    const point = pointWhere(filters, { dedupe: true });
    const { sessionCount } = this.db
      .prepare(`SELECT COUNT(DISTINCT session_row_id) AS sessionCount FROM metric_points ${point.where}`)
      .get(...point.params) as { sessionCount: number };

    return {
      totalCost: totals.totalCost,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cacheReadTokens: totals.cacheReadTokens,
      totalTokens: totals.totalTokens,
      sessionCount,
      activeSenders: totals.activeSenders,
      linesAdded: totals.linesAdded,
      linesRemoved: totals.linesRemoved,
      editsAccepted: totals.editsAccepted,
      editsRejected: totals.editsRejected,
      pullRequests: totals.pullRequests,
      commits: totals.commits,
      models: this.rollupBreakdown("model", "model", filters),
      users: this.enrichUsers(
        this.rollupBreakdown("user_identity", "COALESCE(user_email, user_account_id, user_id, 'unknown')", filters, "user")
      ),
      sources: this.rollupBreakdown("source", "source", filters)
    };
  }

  // Fallback path: aggregate directly over metric_points (used when a session filter is present,
  // which the rollup can't express). Identical results to summaryFromRollup.
  private summaryFromPoints(filters: SummaryFilters): Summary {
    const { where, params } = pointWhere(filters, { dedupe: true });
    const totals = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN kind = 'cost' THEN value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'input' THEN value ELSE 0 END), 0) AS inputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'output' THEN value ELSE 0 END), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'cache_creation' THEN value ELSE 0 END), 0) AS cacheCreationTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'cache_read' THEN value ELSE 0 END), 0) AS cacheReadTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
          COALESCE(SUM(CASE WHEN kind = 'lines' AND token_type = 'added' THEN value ELSE 0 END), 0) AS linesAdded,
          COALESCE(SUM(CASE WHEN kind = 'lines' AND token_type = 'removed' THEN value ELSE 0 END), 0) AS linesRemoved,
          COALESCE(SUM(CASE WHEN kind = 'decision' AND token_type = 'accept' THEN value ELSE 0 END), 0) AS editsAccepted,
          COALESCE(SUM(CASE WHEN kind = 'decision' AND token_type = 'reject' THEN value ELSE 0 END), 0) AS editsRejected,
          COALESCE(SUM(CASE WHEN kind = 'pull_request' THEN value ELSE 0 END), 0) AS pullRequests,
          COALESCE(SUM(CASE WHEN kind = 'commit' THEN value ELSE 0 END), 0) AS commits,
          COUNT(DISTINCT session_row_id) AS sessionCount,
          COUNT(DISTINCT COALESCE(user_email, user_account_id, user_id, 'unknown')) AS activeSenders
        FROM metric_points ${where}`
      )
      .get(...params) as Record<string, number>;

    return {
      totalCost: totals.totalCost,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cacheReadTokens: totals.cacheReadTokens,
      totalTokens: totals.totalTokens,
      sessionCount: totals.sessionCount,
      activeSenders: totals.activeSenders,
      linesAdded: totals.linesAdded,
      linesRemoved: totals.linesRemoved,
      editsAccepted: totals.editsAccepted,
      editsRejected: totals.editsRejected,
      pullRequests: totals.pullRequests,
      commits: totals.commits,
      models: this.breakdown("model", where, params),
      users: this.enrichUsers(
        this.breakdown("COALESCE(user_email, user_account_id, user_id, 'unknown')", where, params, "user")
      ),
      sources: this.breakdown("source", where, params)
    };
  }

  async getTimeseries(filters: SummaryFilters & { granularity?: Granularity }): Promise<TimeseriesPoint[]> {
    const granularity = filters.granularity ?? "hour";
    const bucketMs = GRANULARITY_MS[granularity];
    // Hour/day/week (>= the hourly rollup grain) re-bucket from the rollup; sub-hour grains and
    // session-filtered reads (the live view) fall back to metric_points for exact resolution.
    if (canUseRollup(filters, granularity)) {
      const { where, params } = rollupWhere(filters);
      return this.db
        .prepare(
          `SELECT
            CAST(bucket / ? AS INTEGER) * ? AS bucket,
            COALESCE(SUM(CASE WHEN kind = 'cost' THEN sum_value ELSE 0 END), 0) AS totalCost,
            COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'input' THEN sum_value ELSE 0 END), 0) AS inputTokens,
            COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'output' THEN sum_value ELSE 0 END), 0) AS outputTokens,
            COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'cache_creation' THEN sum_value ELSE 0 END), 0) AS cacheCreationTokens,
            COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'cache_read' THEN sum_value ELSE 0 END), 0) AS cacheReadTokens,
            COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type IN ('cache_creation', 'cache_read') THEN sum_value ELSE 0 END), 0) AS cacheTokens,
            COALESCE(SUM(CASE WHEN kind = 'tokens' THEN sum_value ELSE 0 END), 0) AS totalTokens,
            COALESCE(SUM(CASE WHEN kind = 'lines' AND token_type = 'added' THEN sum_value ELSE 0 END), 0) AS linesAdded,
            COALESCE(SUM(CASE WHEN kind = 'lines' AND token_type = 'removed' THEN sum_value ELSE 0 END), 0) AS linesRemoved,
            COALESCE(SUM(CASE WHEN kind = 'decision' AND token_type = 'accept' THEN sum_value ELSE 0 END), 0) AS editsAccepted,
            COALESCE(SUM(CASE WHEN kind = 'decision' AND token_type = 'reject' THEN sum_value ELSE 0 END), 0) AS editsRejected,
            COALESCE(SUM(CASE WHEN kind = 'pull_request' THEN sum_value ELSE 0 END), 0) AS pullRequests,
            COALESCE(SUM(CASE WHEN kind = 'commit' THEN sum_value ELSE 0 END), 0) AS commits
          FROM ${EFFECTIVE_ROLLUP} AS r ${where}
          GROUP BY bucket
          ORDER BY bucket ASC`
        )
        .all(bucketMs, bucketMs, ...params) as TimeseriesPoint[];
    }

    const { where, params } = pointWhere(filters, { dedupe: true });
    const rows = this.db
      .prepare(
        `SELECT
          CAST(timestamp / ? AS INTEGER) * ? AS bucket,
          COALESCE(SUM(CASE WHEN kind = 'cost' THEN value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'input' THEN value ELSE 0 END), 0) AS inputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'output' THEN value ELSE 0 END), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'cache_creation' THEN value ELSE 0 END), 0) AS cacheCreationTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'cache_read' THEN value ELSE 0 END), 0) AS cacheReadTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type IN ('cache_creation', 'cache_read') THEN value ELSE 0 END), 0) AS cacheTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
          COALESCE(SUM(CASE WHEN kind = 'lines' AND token_type = 'added' THEN value ELSE 0 END), 0) AS linesAdded,
          COALESCE(SUM(CASE WHEN kind = 'lines' AND token_type = 'removed' THEN value ELSE 0 END), 0) AS linesRemoved,
          COALESCE(SUM(CASE WHEN kind = 'decision' AND token_type = 'accept' THEN value ELSE 0 END), 0) AS editsAccepted,
          COALESCE(SUM(CASE WHEN kind = 'decision' AND token_type = 'reject' THEN value ELSE 0 END), 0) AS editsRejected,
          COALESCE(SUM(CASE WHEN kind = 'pull_request' THEN value ELSE 0 END), 0) AS pullRequests,
          COALESCE(SUM(CASE WHEN kind = 'commit' THEN value ELSE 0 END), 0) AS commits
        FROM metric_points ${where}
        GROUP BY bucket
        ORDER BY bucket ASC`
      )
      .all(bucketMs, bucketMs, ...params) as TimeseriesPoint[];
    return rows;
  }

  // Per-model timeseries: one row per (bucket, model) with summed tokens and a distinct session
  // count. Always reads metric_points (the distinct session count can't be summed across rollup
  // buckets, and only token/cost points carry a model), applying the same jsonlWins precedence so a
  // session with both OTel and a transcript isn't double-counted. The client pivots these flat rows
  // into one line per model for the "tokens / sessions by model" charts.
  async getModelTimeseries(filters: SummaryFilters & { granularity?: Granularity }): Promise<ModelTimeseriesPoint[]> {
    const granularity = filters.granularity ?? "hour";
    const bucketMs = GRANULARITY_MS[granularity];
    const { where, params } = pointWhere(filters, { dedupe: true });
    const scoped = where ? `${where} AND model IS NOT NULL AND kind IN ('tokens', 'cost')` : "WHERE model IS NOT NULL AND kind IN ('tokens', 'cost')";
    return this.db
      .prepare(
        `SELECT
          CAST(timestamp / ? AS INTEGER) * ? AS bucket,
          model,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
          COUNT(DISTINCT session_row_id) AS sessions
        FROM metric_points ${scoped}
        GROUP BY bucket, model
        ORDER BY bucket ASC`
      )
      .all(bucketMs, bucketMs, ...params) as ModelTimeseriesPoint[];
  }

  async listSessions(filters: SummaryFilters): Promise<SessionSummary[]> {
    return this.buildSessions(filters, "ORDER BY s.last_seen_at DESC LIMIT 100");
  }

  // Direct id lookup (no LIMIT) so drilling into any session — not just the 100 most recent — works.
  async getSession(id: number): Promise<SessionSummary | null> {
    const rows = await this.buildSessions({ session: id }, "");
    return rows[0] ?? null;
  }

  // Shared session-row builder. One row per session UUID. By default the joined metric_points are
  // restricted to the session's authoritative signal (so totals never mix OTel with a shadowed
  // transcript); an explicit `source` filter switches to that source's raw points for the OTel-vs-
  // JSONL comparison view, and limits the list to sessions that actually carry that source.
  private buildSessions(filters: SummaryFilters, tail: string): Promise<SessionSummary[]> {
    const joinParams: SQLInputValue[] = [];
    let joinCondition: string;
    if (filters.source) {
      joinCondition = "p.session_row_id = s.id AND p.source = ?";
      joinParams.push(filters.source);
    } else {
      joinCondition = `p.session_row_id = s.id AND ${jsonlWins("p.")}`;
    }

    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filters.from) {
      clauses.push("s.last_seen_at >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push("s.first_seen_at <= ?");
      params.push(filters.to);
    }
    if (filters.user) {
      clauses.push("COALESCE(s.user_email, s.user_account_id, s.user_id, 'unknown') = ?");
      params.push(filters.user);
    }
    if (filters.userRowId != null) {
      const ors = ["s.user_row_id = ?"];
      params.push(filters.userRowId);
      if (filters.userRowIdEmail) {
        ors.push("COALESCE(s.user_email, s.user_account_id, s.user_id, 'unknown') = ?");
        params.push(filters.userRowIdEmail);
      }
      clauses.push(`(${ors.join(" OR ")})`);
    }
    if (filters.model) {
      clauses.push("p.model = ?");
      params.push(filters.model);
    }
    if (filters.session) {
      clauses.push("s.id = ?");
      params.push(filters.session);
    }
    if (filters.source) {
      clauses.push("EXISTS(SELECT 1 FROM metric_points mp WHERE mp.session_row_id = s.id AND mp.source = ?)");
      params.push(filters.source);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT
          s.id, s.session_id AS sessionId, s.user_id AS userId, s.user_email AS userEmail, s.user_row_id AS userRowId,
          s.user_account_id AS userAccountId, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt,
          s.metric_source AS metricSource, s.has_otel AS hasOtel, s.has_jsonl AS hasJsonl,
          COALESCE(SUM(CASE WHEN p.kind = 'cost' THEN p.value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' AND p.token_type = 'input' THEN p.value ELSE 0 END), 0) AS inputTokens,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' AND p.token_type = 'output' THEN p.value ELSE 0 END), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' AND p.token_type = 'cache_creation' THEN p.value ELSE 0 END), 0) AS cacheCreationTokens,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' AND p.token_type = 'cache_read' THEN p.value ELSE 0 END), 0) AS cacheReadTokens,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' THEN p.value ELSE 0 END), 0) AS totalTokens,
          -- Per-signal token totals for the whole session (independent of the authoritative join and
          -- of the model/source filters) so the UI can show how far the two ingest paths disagree when
          -- a session carries both. OTel often misses requests the transcript captured (or vice versa).
          (SELECT COALESCE(SUM(mp.value), 0) FROM metric_points mp
             WHERE mp.session_row_id = s.id AND mp.signal = 'otlp_metrics' AND mp.kind = 'tokens') AS otelTotalTokens,
          (SELECT COALESCE(SUM(mp.value), 0) FROM metric_points mp
             WHERE mp.session_row_id = s.id AND mp.signal = 'jsonl' AND mp.kind = 'tokens') AS jsonlTotalTokens,
          -- Per-signal cost too: OTel-reported vs synthesized JSONL cost, so the UI can show the delta.
          (SELECT COALESCE(SUM(mp.value), 0) FROM metric_points mp
             WHERE mp.session_row_id = s.id AND mp.signal = 'otlp_metrics' AND mp.kind = 'cost') AS otelTotalCost,
          (SELECT COALESCE(SUM(mp.value), 0) FROM metric_points mp
             WHERE mp.session_row_id = s.id AND mp.signal = 'jsonl' AND mp.kind = 'cost') AS jsonlTotalCost,
          -- Same per-signal split for cost. OTel cost is Claude's reported figure; JSONL cost is the
          -- synthesized finius.cost.computed point (kind=cost, signal=jsonl). Independent of the
          -- authoritative join so the UI can show the delta when a session carries both.
          (SELECT COALESCE(SUM(mp.value), 0) FROM metric_points mp
             WHERE mp.session_row_id = s.id AND mp.signal = 'otlp_metrics' AND mp.kind = 'cost') AS otelTotalCost,
          (SELECT COALESCE(SUM(mp.value), 0) FROM metric_points mp
             WHERE mp.session_row_id = s.id AND mp.signal = 'jsonl' AND mp.kind = 'cost') AS jsonlTotalCost,
          -- The actual transcript source for this session (e.g. 'claude-code-jsonl' vs 'codex-cli-jsonl'),
          -- so the UI can tell which agent produced it. Independent of the authoritative join/filters.
          (SELECT mp.source FROM metric_points mp
             WHERE mp.session_row_id = s.id AND mp.signal = 'jsonl' LIMIT 1) AS jsonlSource,
          GROUP_CONCAT(DISTINCT p.model) AS models,
          EXISTS(SELECT 1 FROM source_files sf WHERE sf.session_row_id = s.id) AS hasTranscript
        FROM sessions s
        LEFT JOIN metric_points p ON ${joinCondition}
        ${where}
        GROUP BY s.id
        ${tail}`
      )
      .all(...joinParams, ...params) as Array<
        Omit<SessionSummary, "models" | "hasTranscript" | "source" | "hasOtel" | "hasJsonl" | "githubLogin" | "displayName"> & {
          userRowId: number | null;
          metricSource: "otel" | "jsonl";
          models: string | null;
          hasTranscript: number;
          hasOtel: number;
          hasJsonl: number;
          jsonlSource: string | null;
        }
      >;

    // Resolve each session's friendly identity (GitHub login / display name) the same way People does,
    // keyed by the session's canonical identity string, so the sessions list can prefer it over email.
    const directory = this.userDirectory();
    return Promise.resolve(
      rows.map(({ jsonlSource, ...row }) => {
        const u = (row.userRowId ? this.getUserById(row.userRowId) : null) ?? directory.get(row.userEmail ?? row.userAccountId ?? row.userId ?? "unknown");
        return {
          ...row,
          // The authoritative source string. OTel only comes from Claude today; for a transcript we
          // surface its real source (e.g. 'codex-cli-jsonl') so the UI can identify the agent.
          source: row.metricSource === "otel" ? OTEL_SOURCE : jsonlSource ?? "claude-code-jsonl",
          metricSource: row.metricSource,
          hasOtel: row.hasOtel === 1,
          hasJsonl: row.hasJsonl === 1,
          githubLogin: u?.githubLogin ?? null,
          displayName: u?.displayName ?? null,
          models: row.models?.split(",").filter(Boolean) ?? [],
          hasTranscript: row.hasTranscript === 1
        };
      })
    );
  }

  async listPeople(filters: SummaryFilters): Promise<PersonSummary[]> {
    const identity = "COALESCE(user_email, user_account_id, user_id, 'unknown')";
    const { where, params } = pointWhere(filters, { dedupe: true });
    const rows = this.db
      .prepare(
        `SELECT
          ${identity} AS user,
          COUNT(DISTINCT session_row_id) AS sessions,
          COALESCE(SUM(CASE WHEN kind = 'cost' THEN value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'input' THEN value ELSE 0 END), 0) AS inputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'output' THEN value ELSE 0 END), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type IN ('cache_creation', 'cache_read') THEN value ELSE 0 END), 0) AS cacheTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
          MAX(timestamp) AS lastSeenAt,
          GROUP_CONCAT(DISTINCT model) AS models
        FROM metric_points ${where}
        GROUP BY ${identity}
        ORDER BY totalCost DESC, totalTokens DESC`
      )
      .all(...params) as Array<Omit<PersonSummary, "models" | "email" | "displayName" | "githubLogin"> & { models: string | null }>;

    // Enrich each identity-string group with friendly fields from the users registry. JS-side join (the
    // table is tiny — one row per person) keeps the aggregate SQL and the `user` filter untouched.
    return this.enrichUsers(rows).map((row) => ({
      ...row,
      models: row.models?.split(",").filter(Boolean) ?? []
    }));
  }

  // Attach friendly identity fields (email / display name / GitHub login) from the `users` registry to
  // rows keyed by their canonical identity string (`user`), so every list can prefer a GitHub login or
  // display name over the raw email. Shared by People, the summary Users breakdown, and sessions.
  private enrichUsers<T extends { user: string }>(rows: T[]): Array<T & UserIdentityFields> {
    const directory = this.userDirectory();
    return rows.map((row) => {
      const u = directory.get(row.user);
      return {
        ...row,
        email: u?.email ?? null,
        displayName: u?.displayName ?? null,
        githubLogin: u?.githubLogin ?? null
      };
    });
  }

  // Map every identity value (email / account_id / user_id) to its users-registry row, so a People
  // group keyed by any of those strings can be resolved to one canonical person for display.
  private userDirectory(): Map<string, UserIdentityFields> {
    const users = this.db
      .prepare("SELECT email, account_id AS accountId, user_id AS userId, display_name AS displayName, github_login AS githubLogin FROM users")
      .all() as Array<{ email: string | null; accountId: string | null; userId: string | null; displayName: string | null; githubLogin: string | null }>;
    const map = new Map<string, UserIdentityFields>();
    for (const u of users) {
      const value = { email: u.email, displayName: u.displayName, githubLogin: u.githubLogin };
      for (const key of [u.email, u.accountId, u.userId, u.githubLogin]) if (key) map.set(key, value);
    }
    return map;
  }

  async listModels(filters: SummaryFilters): Promise<ModelSummary[]> {
    const identity = "COALESCE(user_email, user_account_id, user_id, 'unknown')";
    const { where, params } = pointWhere(filters, { dedupe: true });
    // Only token/cost points carry a model; other kinds (lines/decision) have NULL model.
    const scoped = where ? `${where} AND model IS NOT NULL` : "WHERE model IS NOT NULL";
    const rows = this.db
      .prepare(
        `SELECT
          model,
          COUNT(DISTINCT session_row_id) AS sessions,
          COUNT(DISTINCT ${identity}) AS users,
          COALESCE(SUM(CASE WHEN kind = 'cost' THEN value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'input' THEN value ELSE 0 END), 0) AS inputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'output' THEN value ELSE 0 END), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type IN ('cache_creation', 'cache_read') THEN value ELSE 0 END), 0) AS cacheTokens,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
          MAX(timestamp) AS lastSeenAt
        FROM metric_points ${scoped}
        GROUP BY model
        ORDER BY totalCost DESC, totalTokens DESC`
      )
      .all(...params) as ModelSummary[];
    return rows;
  }

  async getFilterOptions(): Promise<FilterOptions> {
    // The rollup is OTel-only, so union its distinct dimensions with metric_points (all signals) to
    // keep the transcript-derived source ('claude-code-jsonl') and any jsonl-only users/models
    // selectable — the comparison view filters on the JSONL source even when every JSONL session is
    // also covered by OTel (and therefore absent from the OTel rollup).
    const sources = this.db
      .prepare(
        `SELECT source FROM metric_rollup UNION SELECT source FROM metric_points ORDER BY source`
      )
      .all() as Array<{ source: string }>;
    const users = this.db
      .prepare(
        `SELECT user_identity AS user FROM metric_rollup
         UNION SELECT COALESCE(user_email, user_account_id, user_id, 'unknown') AS user FROM metric_points
         ORDER BY user`
      )
      .all() as Array<{ user: string }>;
    const models = this.db
      .prepare(
        `SELECT model FROM metric_rollup WHERE model <> ''
         UNION SELECT model FROM metric_points WHERE model IS NOT NULL AND model <> ''
         ORDER BY model`
      )
      .all() as Array<{ model: string }>;
    return { sources: sources.map((r) => r.source), users: users.map((r) => r.user), models: models.map((r) => r.model) };
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );

      -- One row per logical session (keyed by the Claude Code session UUID), NOT one per source.
      -- A session can carry OTel metrics, a JSONL transcript, or both; has_otel/has_jsonl record
      -- which signals have arrived and metric_source is the authoritative one we present by default
      -- ('otel' whenever OTel is present, else 'jsonl'). Maintained on ingest by upsertSession, so
      -- reads consult stored state instead of recomputing which sessions have OTel.
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        user_id TEXT,
        user_email TEXT,
        user_account_id TEXT,
        -- Canonical user this session belongs to (FK into users). Set on ingest by upsertSession via
        -- upsertUser; lets /api/people group by a deduped person and show a friendly name/handle.
        user_row_id INTEGER REFERENCES users(id),
        has_otel INTEGER NOT NULL DEFAULT 0,
        has_jsonl INTEGER NOT NULL DEFAULT 0,
        metric_source TEXT NOT NULL DEFAULT 'jsonl',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      -- One row per distinct person, populated from any identity we see (OTel or JSONL/rollout) and
      -- DEDUPED BY EMAIL (same email ⇒ same user), with account_id/user_id/github_login as secondary
      -- link keys. Maintained incrementally by upsertUser; back-filled once from sessions on first run.
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT UNIQUE,
        account_id    TEXT,
        user_id       TEXT,
        github_login  TEXT,
        display_name  TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metric_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        signal TEXT NOT NULL,
        session_row_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT,
        user_email TEXT,
        user_account_id TEXT,
        model TEXT,
        metric_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        token_type TEXT,
        value REAL NOT NULL,
        unit TEXT,
        timestamp INTEGER NOT NULL,
        attributes_json TEXT,
        raw_batch_id INTEGER,
        FOREIGN KEY (session_row_id) REFERENCES sessions(id),
        FOREIGN KEY (raw_batch_id) REFERENCES raw_batches(id)
      );

      CREATE TABLE IF NOT EXISTS metric_rollup (
        bucket        INTEGER NOT NULL,
        source        TEXT    NOT NULL,
        user_identity TEXT    NOT NULL,
        model         TEXT    NOT NULL,
        kind          TEXT    NOT NULL,
        token_type    TEXT    NOT NULL,
        sum_value     REAL    NOT NULL DEFAULT 0,
        cnt           INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, source, user_identity, model, kind, token_type)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS source_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        session_row_id INTEGER,
        session_id TEXT,
        hash TEXT NOT NULL UNIQUE,
        blob_key TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        FOREIGN KEY (session_row_id) REFERENCES sessions(id)
      );

      -- Client auth session tokens minted by POST /api/auth/login (Secure Mode). We store only the
      -- sha256 of the token so the DB never holds a usable credential; a future admin GUI lists/revokes
      -- these. The master password itself is NOT stored here — it lives in the server config.
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash   TEXT NOT NULL UNIQUE,
        label        TEXT,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked      INTEGER NOT NULL DEFAULT 0,
        user_row_id  INTEGER
      );

      CREATE TABLE IF NOT EXISTS oauth_accounts (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        provider         TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        user_row_id      INTEGER NOT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        UNIQUE(provider, provider_user_id),
        FOREIGN KEY (user_row_id) REFERENCES users(id)
      );

      -- One row per captured OTLP log record (Codex telemetry is logs-only). Not aggregated into
      -- metric_points yet — this is the inspection surface (GET /api/logs/events) we use to learn the
      -- real event shapes before writing a parser. raw_batch_id back-references the verbatim payload.
      CREATE TABLE IF NOT EXISTS log_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name      TEXT,
        severity        TEXT,
        session_id      TEXT,
        timestamp       INTEGER NOT NULL,
        attributes_json TEXT,
        body_json       TEXT,
        raw_batch_id    INTEGER,
        FOREIGN KEY (raw_batch_id) REFERENCES raw_batches(id)
      );

      -- Per-model token pricing, used to compute cost ourselves for agents that don't report it.
      -- Keyed (model, effective_date) so dated rows accrete and historical usage is priced by the
      -- rate in effect at the time (LiteLLM publishes only current pricing). Loaded into an in-memory
      -- index at startup / on importPricing.
      CREATE TABLE IF NOT EXISTS model_prices (
        model                    TEXT NOT NULL,
        provider                 TEXT,
        input_per_token          REAL NOT NULL DEFAULT 0,
        output_per_token         REAL NOT NULL DEFAULT 0,
        cache_read_per_token     REAL NOT NULL DEFAULT 0,
        cache_creation_per_token REAL NOT NULL DEFAULT 0,
        effective_date           INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model, effective_date)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_metric_points_timestamp ON metric_points(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metric_points_session ON metric_points(session_row_id);
      CREATE INDEX IF NOT EXISTS idx_metric_points_model ON metric_points(model);
      CREATE INDEX IF NOT EXISTS idx_metric_points_signal_session ON metric_points(signal, session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_rollup_bucket ON metric_rollup(bucket);
      CREATE INDEX IF NOT EXISTS idx_raw_batches_received_at ON raw_batches(received_at);
      CREATE INDEX IF NOT EXISTS idx_source_files_session ON source_files(session_row_id);
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_row ON oauth_accounts(user_row_id);
      CREATE INDEX IF NOT EXISTS idx_log_events_name ON log_events(event_name);
      CREATE INDEX IF NOT EXISTS idx_log_events_batch ON log_events(raw_batch_id);
      CREATE INDEX IF NOT EXISTS idx_metric_points_metric_name ON metric_points(metric_name);
      CREATE INDEX IF NOT EXISTS idx_users_account_id ON users(account_id);
      CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_github_login ON users(github_login);
    `);

    // Existing databases predate sessions.user_row_id (CREATE TABLE IF NOT EXISTS won't add it). Ensure
    // the column exists BEFORE indexing it — the index must not be in the exec block above, or it would
    // fail on an old DB whose sessions table hasn't been ALTERed yet.
    this.ensureColumn("sessions", "user_row_id", "INTEGER");
    this.ensureColumn("auth_tokens", "user_row_id", "INTEGER");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_row ON sessions(user_row_id);
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_row ON auth_tokens(user_row_id);
    `);
    // Back-fill the users registry from any identities already on disk (runs once, when users is empty).
    this.migrateUsers();
  }

  // Add a column to a table if it isn't already present (idempotent ALTER for pre-existing DBs).
  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  private insertRawBatch(signal: string, hash: string, batch: unknown) {
    // payload_json is NOT NULL in the schema; store '' (treated as "no payload") when payload
    // storage is disabled, so we avoid a table rebuild while still keeping the dedup hash.
    const payload = this.storeRawPayloads ? JSON.stringify(batch) : "";
    try {
      const result = this.db
        .prepare("INSERT INTO raw_batches (signal, hash, payload_json, received_at) VALUES (?, ?, ?, ?)")
        .run(signal, hash, payload, Date.now());
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) return null;
      throw error;
    }
  }

  async pruneRawBatches(beforeTimestampMs: number): Promise<{ deleted: number }> {
    this.db.exec("BEGIN");
    try {
      // Orphan any metric_points that reference the batches we're about to delete — they keep their
      // aggregated data, just lose the back-reference to the now-gone raw payload (FK would block).
      this.db
        .prepare("UPDATE metric_points SET raw_batch_id = NULL WHERE raw_batch_id IN (SELECT id FROM raw_batches WHERE received_at < ?)")
        .run(beforeTimestampMs);
      // log_events also back-reference raw_batches; orphan them too (they keep the indexed record).
      this.db
        .prepare("UPDATE log_events SET raw_batch_id = NULL WHERE raw_batch_id IN (SELECT id FROM raw_batches WHERE received_at < ?)")
        .run(beforeTimestampMs);
      const result = this.db.prepare("DELETE FROM raw_batches WHERE received_at < ?").run(beforeTimestampMs);
      this.db.exec("COMMIT");
      return { deleted: Number(result.changes) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createAuthToken(tokenHash: string, label: string, now: number, userRowId: number | null = null): void {
    this.db
      .prepare("INSERT INTO auth_tokens (token_hash, label, created_at, user_row_id) VALUES (?, ?, ?, ?)")
      .run(tokenHash, label, now, userRowId);
  }

  findAuthToken(tokenHash: string): { id: number; revoked: number; userRowId: number | null } | null {
    const row = this.db
      .prepare("SELECT id, revoked, user_row_id AS userRowId FROM auth_tokens WHERE token_hash = ?")
      .get(tokenHash) as { id: number; revoked: number; userRowId: number | null } | undefined;
    if (!row) return null;
    // Best-effort touch so the admin GUI can show recency; failures here must not block auth.
    try {
      this.db.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
    } catch {
      /* ignore */
    }
    return row;
  }

  listAuthTokens(): AuthTokenRecord[] {
    return this.db
      .prepare(
        "SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt, revoked, user_row_id AS userRowId FROM auth_tokens ORDER BY created_at DESC"
      )
      .all() as AuthTokenRecord[];
  }

  revokeAuthToken(id: number): void {
    this.db.prepare("UPDATE auth_tokens SET revoked = 1 WHERE id = ?").run(id);
  }

  getUserById(id: number): AuthUser | null {
    const row = this.db
      .prepare("SELECT id, email, display_name AS displayName, github_login AS githubLogin FROM users WHERE id = ?")
      .get(id) as AuthUser | undefined;
    return row ?? null;
  }

  upsertOAuthUser(input: OAuthUserInput, now: number): AuthUser {
    const existing = this.db
      .prepare(
        `SELECT u.id
         FROM oauth_accounts oa
         JOIN users u ON u.id = oa.user_row_id
         WHERE oa.provider = ? AND oa.provider_user_id = ?`
      )
      .get(input.provider, input.providerUserId) as { id: number } | undefined;
    // Prefer an already-linked account; otherwise try to attach to an existing telemetry user row by
    // ANY verified email (the GitHub primary often differs from the email seen on sessions). Falling
    // through to upsertUser dedupes by the primary email / github login or creates a fresh row.
    const userRowId =
      existing?.id ??
      this.findUserByAnyEmail(input.emails ?? []) ??
      this.upsertUser(
        {
          userEmail: input.email ?? null,
          githubLogin: input.githubLogin ?? null,
          displayName: input.displayName ?? null
        },
        now
      );
    if (userRowId == null) throw new Error("OAuth user has no linkable identity");

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `UPDATE users SET
             email = COALESCE(email, ?),
             github_login = COALESCE(github_login, ?),
             display_name = COALESCE(display_name, ?),
             first_seen_at = MIN(first_seen_at, ?),
             last_seen_at = MAX(last_seen_at, ?)
           WHERE id = ?`
        )
        .run(input.email ?? null, input.githubLogin ?? null, input.displayName ?? null, now, now, userRowId);
      this.db
        .prepare(
          `INSERT INTO oauth_accounts (provider, provider_user_id, user_row_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(provider, provider_user_id) DO UPDATE SET
             user_row_id = excluded.user_row_id,
             updated_at = excluded.updated_at`
        )
        .run(input.provider, input.providerUserId, userRowId, now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const user = this.getUserById(userRowId);
    if (!user) throw new Error("OAuth user link failed");
    return user;
  }

  // Load model_prices into the in-memory index that cost synthesis reads. Called at construction and
  // after every importPricing so the hot path never touches the DB.
  private loadPricing() {
    const rows = this.db
      .prepare(
        `SELECT model, provider,
          input_per_token AS inputPerToken, output_per_token AS outputPerToken,
          cache_read_per_token AS cacheReadPerToken, cache_creation_per_token AS cacheCreationPerToken,
          effective_date AS effectiveDate
         FROM model_prices`
      )
      .all() as ModelPrice[];
    this.priceIndex = indexPrices(rows);
    this.earliestPriceDate = rows.reduce<number | null>((min, r) => (min == null || r.effectiveDate < min ? r.effectiveDate : min), null);
  }

  async getPricing(): Promise<ModelPrice[]> {
    return this.db
      .prepare(
        `SELECT model, provider,
          input_per_token AS inputPerToken, output_per_token AS outputPerToken,
          cache_read_per_token AS cacheReadPerToken, cache_creation_per_token AS cacheCreationPerToken,
          effective_date AS effectiveDate
         FROM model_prices
         ORDER BY model, effective_date DESC`
      )
      .all() as ModelPrice[];
  }

  // Upsert dated price rows (newer effective_date wins for a given model) and reload the index.
  async importPricing(prices: ModelPrice[]): Promise<{ imported: number }> {
    const stmt = this.db.prepare(
      `INSERT INTO model_prices (model, provider, input_per_token, output_per_token, cache_read_per_token, cache_creation_per_token, effective_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model, effective_date) DO UPDATE SET
         provider = excluded.provider,
         input_per_token = excluded.input_per_token,
         output_per_token = excluded.output_per_token,
         cache_read_per_token = excluded.cache_read_per_token,
         cache_creation_per_token = excluded.cache_creation_per_token`
    );
    this.db.exec("BEGIN");
    try {
      for (const p of prices) {
        stmt.run(p.model, p.provider ?? null, p.inputPerToken, p.outputPerToken, p.cacheReadPerToken, p.cacheCreationPerToken, p.effectiveDate);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.loadPricing();
    return { imported: prices.length };
  }

  // Rebuild the synthesized `finius.cost.computed` points from the token points already in
  // metric_points — no transcript re-parse needed. Idempotent: delete then re-derive. Sessions that
  // carry an agent-reported cost are skipped so we never stack computed cost on top of real cost.
  async recomputeComputedCost(): Promise<{ costPoints: number }> {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM metric_points WHERE metric_name = ?").run(COMPUTED_COST_METRIC);
      // After the delete, every remaining kind='cost' row is an agent-reported cost.
      const reported = new Set(
        (this.db.prepare("SELECT DISTINCT session_row_id AS id FROM metric_points WHERE kind = 'cost'").all() as Array<{ id: number }>).map((r) => r.id)
      );
      const tokenRows = this.db
        .prepare(
          `SELECT source, signal, session_id AS sessionId, session_row_id AS sessionRowId, user_id AS userId,
            user_email AS userEmail, user_account_id AS userAccountId, model, metric_name AS metricName,
            token_type AS tokenType, value, timestamp
           FROM metric_points WHERE signal = 'jsonl' AND kind = 'tokens'`
        )
        .all() as Array<{ sessionRowId: number } & Omit<MetricPointInput, "kind" | "attributes">>;
      const tokenPoints: MetricPointInput[] = tokenRows
        .filter((r) => !reported.has(r.sessionRowId))
        .map((r) => ({
          source: r.source,
          signal: r.signal,
          sessionId: r.sessionId,
          userId: r.userId,
          userEmail: r.userEmail,
          userAccountId: r.userAccountId,
          model: r.model,
          metricName: r.metricName,
          kind: "tokens",
          tokenType: r.tokenType,
          value: r.value,
          timestamp: r.timestamp
        }));
      const costPoints = computeCostPoints(tokenPoints, this.priceIndex);
      for (const point of costPoints) this.insertMetricPoint(point, null);
      this.db.exec("COMMIT");
      return { costPoints: costPoints.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertMetricPoint(point: MetricPointInput, rawBatchId: number | null) {
    const sessionRowId = this.upsertSession(point);
    this.db
      .prepare(
        `INSERT INTO metric_points (
          source, signal, session_row_id, session_id, user_id, user_email, user_account_id, model,
          metric_name, kind, token_type, value, unit, timestamp, attributes_json, raw_batch_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        point.source,
        point.signal,
        sessionRowId,
        point.sessionId,
        point.userId ?? null,
        point.userEmail ?? null,
        point.userAccountId ?? null,
        point.model ?? null,
        point.metricName,
        point.kind,
        point.tokenType ?? null,
        point.value,
        point.unit ?? null,
        point.timestamp,
        JSON.stringify(point.attributes ?? {}),
        rawBatchId
      );
  }

  // Maintain the pre-aggregated hourly rollup that serves the home view. Runs inside the same
  // ingest transaction as insertMetricPoint, so the rollup is always consistent with metric_points.
  // NOTE: sum_value/cnt are additive only — distinct counts (sessions/users) cannot be derived from
  // here because an entity spans many buckets; those stay on metric_points.
  private upsertRollup(point: MetricPointInput) {
    const bucket = Math.floor(point.timestamp / 3_600_000) * 3_600_000;
    this.db
      .prepare(
        `INSERT INTO metric_rollup (bucket, source, user_identity, model, kind, token_type, sum_value, cnt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(bucket, source, user_identity, model, kind, token_type)
         DO UPDATE SET sum_value = sum_value + excluded.sum_value, cnt = cnt + excluded.cnt`
      )
      .run(bucket, point.source, preferredIdentity(point), point.model ?? "", point.kind, point.tokenType ?? "", point.value);
  }

  // Upsert the single session row for this point's UUID and fold in which signal it came from. The
  // OR (via MAX over the 0/1 flags) makes presence sticky, and metric_source resolves to 'otel'
  // whenever OTel has ever been seen for the session — that stored flag IS the read-time precedence.
  private upsertSession(point: MetricPointInput) {
    const isOtel = point.signal === "otlp_metrics" ? 1 : 0;
    const isJsonl = point.signal === "jsonl" ? 1 : 0;
    // Resolve (find-or-create) the canonical user for this point's identity so the session can point at
    // a deduped person; null when the point carries no identity at all (stays NULL → "unknown").
    const userRowId = this.upsertUser(point, point.timestamp);
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, user_id, user_email, user_account_id, user_row_id, has_otel, has_jsonl, metric_source, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
          user_id = COALESCE(excluded.user_id, sessions.user_id),
          user_email = COALESCE(excluded.user_email, sessions.user_email),
          user_account_id = COALESCE(excluded.user_account_id, sessions.user_account_id),
          user_row_id = COALESCE(excluded.user_row_id, sessions.user_row_id),
          has_otel = MAX(sessions.has_otel, excluded.has_otel),
          has_jsonl = MAX(sessions.has_jsonl, excluded.has_jsonl),
          metric_source = CASE WHEN MAX(sessions.has_otel, excluded.has_otel) = 1 THEN 'otel' ELSE 'jsonl' END,
          first_seen_at = MIN(sessions.first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(sessions.last_seen_at, excluded.last_seen_at)`
      )
      .run(
        point.sessionId,
        point.userId ?? null,
        point.userEmail ?? null,
        point.userAccountId ?? null,
        userRowId,
        isOtel,
        isJsonl,
        isOtel ? "otel" : "jsonl",
        point.timestamp,
        point.timestamp
      );

    const row = this.db.prepare("SELECT id FROM sessions WHERE session_id = ?").get(point.sessionId) as { id: number };
    return row.id;
  }

  // Find-or-enrich the user for an identity, deduping by the strongest available key (email is the
  // canonical "same user" key; account_id/user_id/github_login are secondary links). On a hit we
  // COALESCE-fill any columns we didn't know before and widen the seen window; otherwise we insert a
  // new row. Returns the user row id, or null for a fully-unknown identity.
  // v1 note: this enriches an existing row but does NOT retroactively merge two pre-existing rows that
  // later prove to be the same person (e.g. an account-only row and an email-only row seen separately).
  private upsertUser(
    id: Pick<MetricPointInput, "userEmail" | "userAccountId" | "userId" | "githubLogin" | "displayName">,
    ts: number
  ): number | null {
    const email = id.userEmail || null;
    const accountId = id.userAccountId || null;
    const userId = id.userId || null;
    const githubLogin = id.githubLogin || null;
    const displayName = id.displayName || null;
    if (!email && !accountId && !userId && !githubLogin) return null;

    const found =
      (email && this.findUser("email", email)) ||
      (accountId && this.findUser("account_id", accountId)) ||
      (userId && this.findUser("user_id", userId)) ||
      (githubLogin && this.findUser("github_login", githubLogin)) ||
      null;

    if (found !== null) {
      this.db
        .prepare(
          `UPDATE users SET
             email = COALESCE(email, ?),
             account_id = COALESCE(account_id, ?),
             user_id = COALESCE(user_id, ?),
             github_login = COALESCE(github_login, ?),
             display_name = COALESCE(display_name, ?),
             first_seen_at = MIN(first_seen_at, ?),
             last_seen_at = MAX(last_seen_at, ?)
           WHERE id = ?`
        )
        .run(email, accountId, userId, githubLogin, displayName, ts, ts, found);
      return found;
    }

    const result = this.db
      .prepare(
        `INSERT INTO users (email, account_id, user_id, github_login, display_name, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(email, accountId, userId, githubLogin, displayName, ts, ts);
    return Number(result.lastInsertRowid);
  }

  private findUser(column: "email" | "account_id" | "user_id" | "github_login", value: string): number | null {
    const row = this.db.prepare(`SELECT id FROM users WHERE ${column} = ? LIMIT 1`).get(value) as { id: number } | undefined;
    return row ? row.id : null;
  }

  // First existing user row matching any of the given emails (used to link an OAuth login to the
  // person's telemetry identity when their provider primary email isn't the one on their sessions).
  private findUserByAnyEmail(emails: string[]): number | null {
    for (const email of emails) {
      if (!email) continue;
      const id = this.findUser("email", email);
      if (id != null) return id;
    }
    return null;
  }

  // Build the users registry once from identities already stored on sessions (existing DBs predate the
  // table). No-op once users has any rows — from then on upsertSession maintains it incrementally.
  private migrateUsers(): void {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    if (n > 0) return;
    const sessions = this.db
      .prepare("SELECT id, user_email, user_account_id, user_id, first_seen_at FROM sessions")
      .all() as Array<{ id: number; user_email: string | null; user_account_id: string | null; user_id: string | null; first_seen_at: number }>;
    if (sessions.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const s of sessions) {
        const uid = this.upsertUser(
          { userEmail: s.user_email, userAccountId: s.user_account_id, userId: s.user_id },
          s.first_seen_at
        );
        if (uid !== null) this.db.prepare("UPDATE sessions SET user_row_id = ? WHERE id = ?").run(uid, s.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private breakdown(field: string, where: string, params: SQLInputValue[], alias = field) {
    // Breakdowns attribute cost/tokens, so restrict to those rows — otherwise lines/decision/
    // active_time points (which carry no model) would add a spurious "unknown" group.
    const scoped = where ? `${where} AND kind IN ('tokens', 'cost')` : "WHERE kind IN ('tokens', 'cost')";
    const rows = this.db
      .prepare(
        `SELECT
          ${field} AS ${alias},
          COALESCE(SUM(CASE WHEN kind = 'cost' THEN value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
          COUNT(DISTINCT session_row_id) AS sessions
        FROM metric_points ${scoped}
        GROUP BY ${field}
        ORDER BY totalCost DESC, totalTokens DESC
        LIMIT 10`
      )
      .all(...params) as Array<Record<string, string | number | null>>;

    return rows.map((row) => ({
      [alias]: String(row[alias] ?? "unknown"),
      totalCost: Number(row.totalCost),
      totalTokens: Number(row.totalTokens),
      sessions: Number(row.sessions)
    })) as never;
  }

  // Rollup equivalent of breakdown(): cost/tokens sum from the rollup, but the per-group distinct
  // session count must still come from metric_points (distinct counts can't be summed across
  // buckets). `rollupDim` is the rollup column; `pointDim` is the matching metric_points expression.
  private rollupBreakdown(rollupDim: string, pointDim: string, filters: SummaryFilters, alias = rollupDim) {
    const { where, params } = rollupWhere(filters);
    const scoped = where ? `${where} AND kind IN ('tokens', 'cost')` : "WHERE kind IN ('tokens', 'cost')";
    const rows = this.db
      .prepare(
        `SELECT
          ${rollupDim} AS ${alias},
          COALESCE(SUM(CASE WHEN kind = 'cost' THEN sum_value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN kind = 'tokens' THEN sum_value ELSE 0 END), 0) AS totalTokens
        FROM ${EFFECTIVE_ROLLUP} AS r ${scoped}
        GROUP BY ${rollupDim}
        ORDER BY totalCost DESC, totalTokens DESC
        LIMIT 10`
      )
      .all(...params) as Array<Record<string, string | number | null>>;

    const sessionsByGroup = this.distinctSessionsByGroup(pointDim, filters);
    return rows.map((row) => {
      const label = String(row[alias] || "unknown"); // rollup '' sentinel (NULL model) -> "unknown"
      return {
        [alias]: label,
        totalCost: Number(row.totalCost),
        totalTokens: Number(row.totalTokens),
        sessions: sessionsByGroup.get(label) ?? 0
      };
    }) as never;
  }

  // Distinct session counts per dimension group, from metric_points. Keyed by the same "unknown"
  // normalization rollupBreakdown uses so the maps line up.
  private distinctSessionsByGroup(pointDim: string, filters: SummaryFilters): Map<string, number> {
    const { where, params } = pointWhere(filters, { dedupe: true });
    const scoped = where ? `${where} AND kind IN ('tokens', 'cost')` : "WHERE kind IN ('tokens', 'cost')";
    const rows = this.db
      .prepare(
        `SELECT ${pointDim} AS grp, COUNT(DISTINCT session_row_id) AS sessions
         FROM metric_points ${scoped}
         GROUP BY ${pointDim}`
      )
      .all(...params) as Array<{ grp: string | null; sessions: number }>;
    return new Map(rows.map((r) => [String(r.grp || "unknown"), r.sessions]));
  }
}

function safeParse(json: string | null): unknown {
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

let warnedCumulative = false;

// Our token/cost aggregation sums data points, which is only correct for DELTA temporality
// (Claude Code's default). Warn once if a backend ever sends CUMULATIVE, which would overcount.
function warnIfCumulative(records: OtelMetricRecord[]) {
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

export { preferredIdentity };
