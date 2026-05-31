import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type BlobStore, LocalBlobStore } from "./blob.js";
import { parseJsonl } from "../jsonl.js";
import { parseOtelLogRecords, parseOtelMetricPoints, parseOtelMetricRecords, preferredIdentity, stableHash } from "../otel.js";
import type { OtelMetricRecord } from "../otel.js";
import type {
  FilterOptions,
  Granularity,
  ImportResult,
  MetricPointInput,
  ModelSummary,
  PersonSummary,
  SessionSummary,
  StorageAdapter,
  Summary,
  SummaryFilters,
  TimeseriesPoint,
  TranscriptInfo
} from "../types.js";

const GRANULARITY_MS: Record<Granularity, number> = {
  minute: 60_000,
  five_minute: 300_000,
  quarter_hour: 900_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000
};

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

  constructor(path: string, options: SqliteStorageOptions = {}) {
    this.storeRawPayloads = options.storeRawPayloads ?? true;
    this.blob = options.blob ?? new LocalBlobStore(join(dirname(path), "transcripts"));
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
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

    // Logs are not aggregated into metric_points; we keep only the dedup hash (+ optional payload)
    // in raw_batches and report the parsed event count.
    const records = parseOtelLogRecords(batch);
    return { duplicate: false, events: records.length };
  }

  async importJsonl(source: string, sessionHint: Partial<MetricPointInput>, content: string): Promise<ImportResult> {
    // Dedup on the file's content hash; the stored file is the replay source, so the JSONL path no
    // longer touches raw_batches at all.
    const hash = createHash("sha256").update(content).digest("hex");
    const existing = this.db.prepare("SELECT id FROM source_files WHERE hash = ?").get(hash);
    if (existing) return { duplicate: true, importedLines: 0, malformedLines: 0, metricPoints: 0, rawEvents: 0 };

    const lines = content.split(/\r?\n/);
    const parsed = parseJsonl(source, sessionHint, lines);

    // Persist the original file before recording it, so a source_files row never dangles.
    await this.blob.save(hash, content);

    this.db.exec("BEGIN");
    try {
      for (const point of parsed.points) {
        this.insertMetricPoint(point, null);
        this.upsertRollup(point);
      }
      // Link the file to its dominant session (hint, else first parsed point). metric_points keep
      // their own session_row_id, so a file spanning sessions still attributes correctly.
      const sessionId = sessionHint.sessionId ?? parsed.points[0]?.sessionId ?? null;
      const sessionRow = sessionId
        ? (this.db.prepare("SELECT id FROM sessions WHERE source = ? AND session_id = ?").get(source, sessionId) as { id: number } | undefined)
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
        FROM metric_rollup ${where}`
      )
      .get(...params) as Record<string, number>;

    const point = pointWhere(filters);
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
      users: this.rollupBreakdown("user_identity", "COALESCE(user_email, user_account_id, user_id, 'unknown')", filters, "user"),
      sources: this.rollupBreakdown("source", "source", filters)
    };
  }

  // Fallback path: aggregate directly over metric_points (used when a session filter is present,
  // which the rollup can't express). Identical results to summaryFromRollup.
  private summaryFromPoints(filters: SummaryFilters): Summary {
    const { where, params } = pointWhere(filters);
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
      users: this.breakdown("COALESCE(user_email, user_account_id, user_id, 'unknown')", where, params, "user"),
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
          FROM metric_rollup ${where}
          GROUP BY bucket
          ORDER BY bucket ASC`
        )
        .all(bucketMs, bucketMs, ...params) as TimeseriesPoint[];
    }

    const { where, params } = pointWhere(filters);
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

  async listSessions(filters: SummaryFilters): Promise<SessionSummary[]> {
    const { where, params } = sessionWhere(filters);
    const rows = this.db
      .prepare(
        `SELECT
          s.id, s.source, s.session_id AS sessionId, s.user_id AS userId, s.user_email AS userEmail,
          s.user_account_id AS userAccountId, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt,
          COALESCE(SUM(CASE WHEN p.kind = 'cost' THEN p.value ELSE 0 END), 0) AS totalCost,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' AND p.token_type = 'input' THEN p.value ELSE 0 END), 0) AS inputTokens,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' AND p.token_type = 'output' THEN p.value ELSE 0 END), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' AND p.token_type = 'cache_creation' THEN p.value ELSE 0 END), 0) AS cacheCreationTokens,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' AND p.token_type = 'cache_read' THEN p.value ELSE 0 END), 0) AS cacheReadTokens,
          COALESCE(SUM(CASE WHEN p.kind = 'tokens' THEN p.value ELSE 0 END), 0) AS totalTokens,
          GROUP_CONCAT(DISTINCT p.model) AS models
        FROM sessions s
        LEFT JOIN metric_points p ON p.session_row_id = s.id
        ${where}
        GROUP BY s.id
        ORDER BY s.last_seen_at DESC
        LIMIT 100`
      )
      .all(...params) as Array<Omit<SessionSummary, "models"> & { models: string | null }>;

    return rows.map((row) => ({ ...row, models: row.models?.split(",").filter(Boolean) ?? [] }));
  }

  async getSession(id: number): Promise<SessionSummary | null> {
    const rows = await this.listSessions({});
    return rows.find((row) => row.id === id) ?? null;
  }

  async listPeople(filters: SummaryFilters): Promise<PersonSummary[]> {
    const identity = "COALESCE(user_email, user_account_id, user_id, 'unknown')";
    const { where, params } = pointWhere(filters);
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
      .all(...params) as Array<Omit<PersonSummary, "models"> & { models: string | null }>;

    return rows.map((row) => ({ ...row, models: row.models?.split(",").filter(Boolean) ?? [] }));
  }

  async listModels(filters: SummaryFilters): Promise<ModelSummary[]> {
    const identity = "COALESCE(user_email, user_account_id, user_id, 'unknown')";
    const { where, params } = pointWhere(filters);
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
    // Served from the rollup: same distinct dimension values, far fewer rows to scan.
    const sources = this.db.prepare("SELECT DISTINCT source FROM metric_rollup ORDER BY source").all() as Array<{ source: string }>;
    const users = this.db
      .prepare("SELECT DISTINCT user_identity AS user FROM metric_rollup ORDER BY user")
      .all() as Array<{ user: string }>;
    const models = this.db
      .prepare("SELECT DISTINCT model FROM metric_rollup WHERE model <> '' ORDER BY model")
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

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT,
        user_email TEXT,
        user_account_id TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(source, session_id)
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

      CREATE INDEX IF NOT EXISTS idx_metric_points_timestamp ON metric_points(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metric_points_session ON metric_points(session_row_id);
      CREATE INDEX IF NOT EXISTS idx_metric_points_model ON metric_points(model);
      CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_rollup_bucket ON metric_rollup(bucket);
      CREATE INDEX IF NOT EXISTS idx_raw_batches_received_at ON raw_batches(received_at);
      CREATE INDEX IF NOT EXISTS idx_source_files_session ON source_files(session_row_id);
    `);

    // Repair token types ingested before camelCase cache types were normalized (cacheCreation/cacheRead).
    // Idempotent: matches nothing once the data is clean.
    this.db.exec(`
      UPDATE metric_points SET token_type = 'cache_creation' WHERE token_type IN ('cachecreation', 'cache-creation');
      UPDATE metric_points SET token_type = 'cache_read' WHERE token_type IN ('cacheread', 'cache-read');
    `);

    this.backfillActivityMetrics();
    this.migrateRollup();
  }

  // Build metric_rollup from existing metric_points once, and drop the now-unused raw_events audit
  // log. Gated on PRAGMA user_version so it runs exactly once. Must run AFTER backfillActivityMetrics
  // so the replayed activity points are included in the wholesale rollup backfill.
  private migrateRollup() {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version >= 2) return;

    // foreign_keys cannot be toggled inside a transaction, and dropping raw_events would otherwise
    // trip metric_points' (now-removed) FK on legacy databases.
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("DROP TABLE IF EXISTS raw_events");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        INSERT INTO metric_rollup (bucket, source, user_identity, model, kind, token_type, sum_value, cnt)
        SELECT CAST(timestamp / 3600000 AS INTEGER) * 3600000, source,
               COALESCE(user_email, user_account_id, user_id, 'unknown'),
               COALESCE(model, ''), kind, COALESCE(token_type, ''), SUM(value), COUNT(*)
        FROM metric_points
        GROUP BY 1, 2, 3, 4, 5, 6
      `);
      this.db.exec("PRAGMA user_version = 2");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Older batches only stored token/cost metric points. Replay the stored OTLP payloads once to
  // backfill the activity metric_points (lines/decision/active_time) that older builds didn't
  // classify. Gated on PRAGMA user_version so it runs exactly once. The rollup is built afterwards
  // by migrateRollup() from the completed metric_points, so no rollup upsert is needed here.
  private backfillActivityMetrics() {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version >= 1) return;

    const batches = this.db.prepare("SELECT id, payload_json FROM raw_batches WHERE signal = 'otlp_metrics' ORDER BY id ASC").all() as Array<{
      id: number;
      payload_json: string;
    }>;

    this.db.exec("BEGIN");
    try {
      for (const batch of batches) {
        if (!batch.payload_json) continue; // payload storage disabled (FINIUS_RAW_PAYLOADS=off) — nothing to replay.
        const payload = JSON.parse(batch.payload_json);
        // token/cost points already exist from the original ingest — only add the new kinds.
        for (const point of parseOtelMetricPoints(payload)) {
          if (point.kind === "tokens" || point.kind === "cost") continue;
          this.insertMetricPoint(point, batch.id);
        }
      }
      this.db.exec("PRAGMA user_version = 1");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
      const result = this.db.prepare("DELETE FROM raw_batches WHERE received_at < ?").run(beforeTimestampMs);
      this.db.exec("COMMIT");
      return { deleted: Number(result.changes) };
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

  private upsertSession(point: MetricPointInput) {
    this.db
      .prepare(
        `INSERT INTO sessions (source, session_id, user_id, user_email, user_account_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, session_id) DO UPDATE SET
          user_id = COALESCE(excluded.user_id, sessions.user_id),
          user_email = COALESCE(excluded.user_email, sessions.user_email),
          user_account_id = COALESCE(excluded.user_account_id, sessions.user_account_id),
          first_seen_at = MIN(sessions.first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(sessions.last_seen_at, excluded.last_seen_at)`
      )
      .run(point.source, point.sessionId, point.userId ?? null, point.userEmail ?? null, point.userAccountId ?? null, point.timestamp, point.timestamp);

    const row = this.db.prepare("SELECT id FROM sessions WHERE source = ? AND session_id = ?").get(point.source, point.sessionId) as { id: number };
    return row.id;
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
        FROM metric_rollup ${scoped}
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
    const { where, params } = pointWhere(filters);
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

// The rollup can serve a read when it isn't session-filtered (no session dimension) and the
// requested granularity is at least the hourly rollup grain (sub-hour grains need metric_points).
function canUseRollup(filters: SummaryFilters, granularity?: Granularity) {
  if (filters.session != null) return false;
  return granularity == null || GRANULARITY_MS[granularity] >= GRANULARITY_MS.hour;
}

// WHERE builder for metric_rollup. Mirrors pointWhere but maps onto rollup columns: user_identity
// is pre-resolved (no COALESCE), time compares against the hourly bucket, and there is no session.
function rollupWhere(filters: SummaryFilters) {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (filters.from) {
    clauses.push("bucket >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("bucket <= ?");
    params.push(filters.to);
  }
  if (filters.user) {
    clauses.push("user_identity = ?");
    params.push(filters.user);
  }
  if (filters.model) {
    clauses.push("model = ?");
    params.push(filters.model);
  }
  if (filters.source) {
    clauses.push("source = ?");
    params.push(filters.source);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function pointWhere(filters: SummaryFilters) {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (filters.from) {
    clauses.push("timestamp >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push("timestamp <= ?");
    params.push(filters.to);
  }
  if (filters.user) {
    clauses.push("COALESCE(user_email, user_account_id, user_id, 'unknown') = ?");
    params.push(filters.user);
  }
  if (filters.model) {
    clauses.push("model = ?");
    params.push(filters.model);
  }
  if (filters.source) {
    clauses.push("source = ?");
    params.push(filters.source);
  }
  if (filters.session) {
    clauses.push("session_row_id = ?");
    params.push(filters.session);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function sessionWhere(filters: SummaryFilters) {
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
  if (filters.model) {
    clauses.push("p.model = ?");
    params.push(filters.model);
  }
  if (filters.source) {
    clauses.push("s.source = ?");
    params.push(filters.source);
  }
  if (filters.session) {
    clauses.push("s.id = ?");
    params.push(filters.session);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export { preferredIdentity };
