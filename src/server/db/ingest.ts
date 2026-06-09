// Ingest/write layer: free functions over the Drizzle handle for the write side of the pipeline —
// raw_batches dedup, metric_points insertion with materialized `is_primary` precedence, the hourly
// metric_rollup maintenance, session upserts, log_events, source_files, and pruning. Extracted from
// the storage adapter so the write logic lives in the db/ layer alongside the read modules.
//
// Every function takes the Drizzle handle (`db`) as its first arg and uses ONLY it (the same shared
// connection the adapter's transactions run on). Functions that must run atomically as a group
// (ingestMetricPoints, insertLogEvents, recordSourceFile) do NOT open their own transaction — the
// caller wraps them in `db.transaction(...)`, exactly as the adapter did inline.

import { type DrizzleDb } from "./client.js";
import { and, desc, eq, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
import { logEvents, metricPoints, metricRollup, rawBatches, sessions, sourceFiles } from "./schema.js";
import { dialect } from "./dialect.js";
import * as usersDb from "./users.js";
import { PROVIDERS, SOURCES, type Signal, isPrimarySource, providerOfSource } from "../../shared/sources.js";
import { preferredIdentity } from "../otel.js";
import type { MetricPointInput, OtelLogRecord, TranscriptInfo } from "../types.js";

// Dedup-insert a raw OTLP batch; returns the new id, or null on the UNIQUE(hash) collision (duplicate).
// payload_json is NOT NULL in the schema; store '' (treated as "no payload") when payload storage is
// disabled, so we avoid a table rebuild while still keeping the dedup hash.
export function insertRawBatch(db: DrizzleDb, signal: string, hash: string, batch: unknown, storeRawPayloads: boolean): number | null {
  const payload = storeRawPayloads ? JSON.stringify(batch) : "";
  try {
    const [row] = db.insert(rawBatches).values({ signal, hash, payloadJson: payload, receivedAt: Date.now() }).returning({ id: rawBatches.id }).all();
    return row.id;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) return null;
    throw error;
  }
}

// Index OTLP log records into log_events (NOT aggregated into metric_points). Caller wraps in a txn.
export function insertLogEvents(db: DrizzleDb, records: OtelLogRecord[], rawBatchId: number | null): void {
  for (const record of records) {
    db.insert(logEvents)
      .values({
        eventName: record.eventName,
        severity: record.severityText,
        sessionId: record.sessionId,
        timestamp: record.timestamp,
        attributesJson: JSON.stringify(record.attributes ?? {}),
        bodyJson: record.body === undefined ? null : JSON.stringify(record.body ?? null),
        rawBatchId
      })
      .run();
  }
}

// Already-imported? A persistent source_files row for this content hash means we've processed it.
export function uploadExists(db: DrizzleDb, hash: string): boolean {
  return !!db.select({ one: sql`1` }).from(sourceFiles).where(eq(sourceFiles.hash, hash)).get();
}

// Resolve a Copilot transcript's own chat-session id to the OTel session id that carries its tokens, by
// matching the copilot_chat.* / gen_ai.conversation.id attributes recorded on the OTel metric points.
export function resolveCopilotTranscriptSession(db: DrizzleDb, chatSessionId: string | null | undefined): string | undefined {
  if (!chatSessionId) return undefined;
  const attrs = metricPoints.attributesJson;
  const row = db.get<{ sessionId: string }>(
    sql`SELECT ${metricPoints.sessionId} AS sessionId
       FROM ${metricPoints}
       WHERE ${metricPoints.source} = 'github-copilot'
         AND ${metricPoints.signal} = 'otlp_metrics'
         AND (
           ${dialect.jsonExtract(attrs, '$."copilot_chat.chat_session_id"')} = ${chatSessionId}
           OR ${dialect.jsonExtract(attrs, '$."copilot_chat.session_id"')} = ${chatSessionId}
           OR ${dialect.jsonExtract(attrs, '$."gen_ai.conversation.id"')} = ${chatSessionId}
         )
       ORDER BY ${metricPoints.timestamp} DESC
       LIMIT 1`
  );
  return row?.sessionId;
}

// The most-recent transcript file linked to a session (blob key + metadata); the caller reads the blob.
export function getSourceFileForSession(db: DrizzleDb, sessionRowId: number): { blobKey: string; source: string; importedAt: number } | null {
  const row = db
    .select({ blobKey: sourceFiles.blobKey, source: sourceFiles.source, importedAt: sourceFiles.importedAt })
    .from(sourceFiles)
    .where(eq(sourceFiles.sessionRowId, sessionRowId))
    .orderBy(desc(sourceFiles.importedAt))
    .limit(1)
    .get();
  return row ?? null;
}

// Metadata only (no blob read) so the UI can decide whether to show a "view transcript" link.
export function getSessionTranscriptInfo(db: DrizzleDb, sessionRowId: number): TranscriptInfo | null {
  const row = db
    .select({ source: sourceFiles.source, importedAt: sourceFiles.importedAt, byteSize: sourceFiles.byteSize, lineCount: sourceFiles.lineCount })
    .from(sourceFiles)
    .where(eq(sourceFiles.sessionRowId, sessionRowId))
    .orderBy(desc(sourceFiles.importedAt))
    .limit(1)
    .get();
  return (row as TranscriptInfo | undefined) ?? null;
}

// Link an imported transcript file to the single session row for its UUID (resolving the row from the
// session id). Caller wraps in the import transaction.
export function recordSourceFile(
  db: DrizzleDb,
  input: { source: string; sessionId: string | null; hash: string; byteSize: number; lineCount: number }
): void {
  const sessionRow = input.sessionId
    ? db.select({ id: sessions.id }).from(sessions).where(eq(sessions.sessionId, input.sessionId)).get()
    : undefined;
  db.insert(sourceFiles)
    .values({
      source: input.source,
      sessionRowId: sessionRow?.id ?? null,
      sessionId: input.sessionId,
      hash: input.hash,
      blobKey: input.hash,
      byteSize: input.byteSize,
      lineCount: input.lineCount,
      importedAt: Date.now()
    })
    .run();
}

// Delete raw_batches older than the cutoff, orphaning (not cascading) the metric_points/log_events
// back-references first so the aggregated data survives. Opens its own transaction.
export function pruneRawBatches(db: DrizzleDb, beforeTimestampMs: number): { deleted: number } {
  const deleted = db.transaction(() => {
    const staleBatches = db.select({ id: rawBatches.id }).from(rawBatches).where(lt(rawBatches.receivedAt, beforeTimestampMs));
    db.update(metricPoints).set({ rawBatchId: null }).where(inArray(metricPoints.rawBatchId, staleBatches)).run();
    db.update(logEvents).set({ rawBatchId: null }).where(inArray(logEvents.rawBatchId, staleBatches)).run();
    const result = db.delete(rawBatches).where(lt(rawBatches.receivedAt, beforeTimestampMs)).run();
    return Number(result.changes);
  });
  return { deleted };
}

// Insert one metric point with a session-aware is_primary, restoring the original jsonlWins fallback
// semantics in materialized form. Returns whether the inserted point is primary (so the caller knows
// whether to feed the rollup incrementally) and whether a transition (demotion of the session's
// previously-promoted non-preferred points) occurred (so the caller rebuilds the rollup).
//
// The rule (per the central registry's preferredSignal): the preferred signal always counts; the
// non-preferred signal counts only when the session has NO preferred-signal point (fallback). This
// matches the pre-refactor read-time precedence (a Claude/Copilot transcript counts iff the session
// has no OTel; a Codex/manual transcript always counts; OTel always counts), but is materialized so
// reads stay `WHERE is_primary = 1`.
export function insertMetricPoint(db: DrizzleDb, point: MetricPointInput, rawBatchId: number | null): { isPrimary: boolean; transitioned: boolean } {
  const provider = providerOfSource(point.source);
  const pref = PROVIDERS[provider].preferredSignal;
  const isPreferredPoint = point.signal === pref;

  // Capture the session's PRIOR "has preferred signal" state BEFORE upsertSession updates the flags.
  // has_otel tracks the otlp_metrics signal, has_jsonl the jsonl signal — so we read the flag that
  // corresponds to this provider's preferred signal. A brand-new session has neither (no preferred).
  const prefColumn = pref === "otlp_metrics" ? sessions.hasOtel : sessions.hasJsonl;
  const existing = db.select({ id: sessions.id, prefFlag: prefColumn }).from(sessions).where(eq(sessions.sessionId, point.sessionId)).get();
  const sessionHadPreferred = existing?.prefFlag === 1;

  const sessionRowId = upsertSession(db, point);

  // is_primary: preferred always counts; non-preferred counts only when the session has no preferred
  // signal point (fallback). This must be computed against the PRIOR state — for the preferred point
  // itself, `sessionHadPreferred` may be false even though, after this insert, the session will have
  // one (we handle that via the transition demotion below).
  const isPrimary = isPreferredPoint ? true : !sessionHadPreferred;

  // Transition (demotion): if this is the FIRST preferred-signal point for a session that previously
  // only had non-preferred points (which were promoted to is_primary=1 as a fallback), those points
  // are now shadowed and must be demoted. This perturbs the rollup, so signal a rebuild.
  let transitioned = false;
  if (isPreferredPoint && !sessionHadPreferred && existing) {
    const result = db
      .update(metricPoints)
      .set({ isPrimary: 0 })
      .where(and(eq(metricPoints.sessionRowId, sessionRowId), ne(metricPoints.signal, pref), eq(metricPoints.isPrimary, 1)))
      .run();
    transitioned = Number(result.changes) > 0;
  }

  db.insert(metricPoints)
    .values({
      source: point.source,
      signal: point.signal,
      sessionRowId,
      sessionId: point.sessionId,
      userId: point.userId ?? null,
      userEmail: point.userEmail ?? null,
      userAccountId: point.userAccountId ?? null,
      model: point.model ?? null,
      metricName: point.metricName,
      kind: point.kind,
      tokenType: point.tokenType ?? null,
      value: point.value,
      unit: point.unit ?? null,
      timestamp: point.timestamp,
      attributesJson: JSON.stringify(point.attributes ?? {}),
      rawBatchId,
      isPrimary: isPrimary ? 1 : 0
    })
    .run();

  return { isPrimary, transitioned };
}

// Maintain the pre-aggregated hourly rollup that serves the home view. Runs inside the same ingest
// transaction as insertMetricPoint, so the rollup is always consistent with metric_points. NOTE:
// sum_value/cnt are additive only — distinct counts (sessions/users) cannot be derived from here
// because an entity spans many buckets; those stay on metric_points.
export function upsertRollup(db: DrizzleDb, point: MetricPointInput): void {
  const bucket = Math.floor(point.timestamp / 3_600_000) * 3_600_000;
  db.insert(metricRollup)
    .values({
      bucket,
      source: point.source,
      userIdentity: preferredIdentity(point),
      model: point.model ?? "",
      kind: point.kind,
      tokenType: point.tokenType ?? "",
      sumValue: point.value,
      cnt: 1
    })
    .onConflictDoUpdate({
      target: [metricRollup.bucket, metricRollup.source, metricRollup.userIdentity, metricRollup.model, metricRollup.kind, metricRollup.tokenType],
      set: { sumValue: sql`${metricRollup.sumValue} + excluded.sum_value`, cnt: sql`${metricRollup.cnt} + excluded.cnt` }
    })
    .run();
}

// Rebuild the entire metric_rollup from scratch as the aggregate of every primary metric point. The
// rollup invariant is `metric_rollup == aggregate of metric_points WHERE is_primary = 1`; an
// incremental upsertRollup keeps it true on the happy path, but a bulk delete+reinsert (computed cost
// recompute, or a Codex replace-by-session) breaks it, so we re-aggregate wholesale. The
// bucket/identity/model/token_type expressions MUST match upsertRollup exactly so incremental and
// rebuilt rollups agree. Callers run this inside their own transaction.
export function rebuildRollup(db: DrizzleDb): void {
  db.delete(metricRollup).run();
  db.run(sql`
    INSERT INTO metric_rollup (bucket, source, user_identity, model, kind, token_type, sum_value, cnt)
    SELECT
      CAST(timestamp / 3600000 AS INTEGER) * 3600000 AS bucket,
      source,
      COALESCE(user_email, user_account_id, user_id, 'unknown') AS user_identity,
      COALESCE(model, '') AS model,
      kind,
      COALESCE(token_type, '') AS token_type,
      SUM(value) AS sum_value,
      COUNT(*) AS cnt
    FROM metric_points
    WHERE is_primary = 1
    GROUP BY bucket, source, user_identity, model, kind, token_type
  `);
}

// The shared ingest loop used by the OTLP metrics/traces paths: insert each point, feed the rollup from
// its DYNAMIC primacy, and rebuild once if any insert triggered a transition (late preferred signal
// demoting a session's promoted transcript points). Caller wraps in a transaction.
//
// `active_time` and `session` (start count) are the only metrics Claude Code emits for a session that
// did no real work — they fire on mere activity / session start. Every other kind (tokens, cost, lines,
// decision, pull_request, commit) is substantive activity worth a session.
const GHOST_KINDS = new Set(["active_time", "session"]);

// A session row should exist only for sessions with REAL activity. Claude Code exports `active_time`/
// `session.count` for sessions that never made an API call; inserting those alone would create a
// 0-token "ghost" session row (session_row_id is NOT NULL, so the point can't exist without a row). We
// therefore DROP these telemetry-only points when their session has no substantive metric. Eligibility
// is computed batch-wide so point ORDER within the batch doesn't matter: a session counts if it carries
// any substantive point ANYWHERE in this batch, OR it already has a row from earlier activity.
export function ingestMetricPoints(db: DrizzleDb, points: MetricPointInput[], rawBatchId: number | null): void {
  const substantive = new Set(points.filter((p) => !GHOST_KINDS.has(p.kind)).map((p) => p.sessionId));
  const candidateIds = [...new Set(points.map((p) => p.sessionId))].filter((id) => !substantive.has(id));
  const existing = new Set<string>(
    candidateIds.length === 0
      ? []
      : db.select({ sessionId: sessions.sessionId }).from(sessions).where(inArray(sessions.sessionId, candidateIds)).all().map((r) => r.sessionId)
  );
  let needsRebuild = false;
  for (const point of points) {
    if (GHOST_KINDS.has(point.kind) && !substantive.has(point.sessionId) && !existing.has(point.sessionId)) continue;
    const { isPrimary, transitioned } = insertMetricPoint(db, point, rawBatchId);
    if (isPrimary) upsertRollup(db, point);
    if (transitioned) needsRebuild = true;
  }
  if (needsRebuild) rebuildRollup(db);
}

// Re-materialize is_primary for the ENTIRE table from first principles (the registry's preferred-signal
// rule), independent of the per-point insert-time computation. A point is primary unless shadowed; a
// non-preferred-signal ("shadowable") point is shadowed iff its session ALSO holds a preferred-signal
// point. Authoritative + idempotent: the preferred signal's presence is read from the ACTUAL points in
// the session (an EXISTS), NOT the sticky has_otel/has_jsonl flags — a replaceSessionPoints delete can
// leave a flag over-claiming a signal that no longer has points, which would wrongly shadow the
// survivor. On healthy data this yields exactly what a fresh sequence of insertMetricPoint calls would.
// Unlike the per-point path, this also corrects rows that drifted (a bad backfill, a precedence-rule
// change). Callers run this inside their own transaction and rebuild the rollup afterward (the rollup
// must reflect the corrected is_primary).
export function rebuildIsPrimary(db: DrizzleDb): void {
  // Sources whose signal is NOT their provider's preferred signal (the only ones that can be shadowed):
  // today claude-code-jsonl + copilot-vscode-jsonl. Codex/manual JSONL are their providers' PREFERRED
  // signal, so they're never shadowable. Unknown sources are treated as primary (isPrimarySource).
  const shadowable = SOURCES.filter((s) => !isPrimarySource(s.id));
  if (shadowable.length === 0) {
    db.update(metricPoints).set({ isPrimary: 1 }).run();
    return;
  }
  // 1. Everything that is not a known shadowable source is primary (incl. unknown sources).
  db.update(metricPoints).set({ isPrimary: 1 }).where(notInArray(metricPoints.source, shadowable.map((s) => s.id))).run();
  // 2. A shadowable point is shadowed (0) iff the session holds a point of THAT point's provider's
  //    preferred SIGNAL — exactly the per-point insert rule (insertMetricPoint reads has_otel/has_jsonl,
  //    i.e. the presence of the preferred signal). NOT "any non-shadowable source": a different provider's
  //    preferred-jsonl source (codex/manual) in the same session must NOT shadow a claude/copilot
  //    transcript. Group the shadowable sources by their preferred signal and shadow each group against
  //    its own signal, so the rule is correct for any registry shape (today every group is otlp_metrics).
  const groups = new Map<Signal, string[]>();
  for (const s of shadowable) {
    const pref = PROVIDERS[providerOfSource(s.id)].preferredSignal;
    (groups.get(pref) ?? groups.set(pref, []).get(pref)!).push(s.id);
  }
  for (const [pref, ids] of groups) {
    const idList = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `
    );
    // The correlated subquery references the outer table by name (SQLite allows this; no target alias).
    db.run(sql`
      UPDATE metric_points SET is_primary = CASE
        WHEN EXISTS (
          SELECT 1 FROM metric_points pp
          WHERE pp.session_row_id = metric_points.session_row_id
            AND pp.signal = ${pref}
        ) THEN 0 ELSE 1 END
      WHERE source IN (${idList})`);
  }
}

// Upsert the single session row for this point's UUID and fold in which signal it came from. The OR
// (via MAX over the 0/1 flags) makes presence sticky, and metric_source resolves to 'otel' whenever
// OTel has ever been seen for the session — that stored flag IS the read-time precedence.
export function upsertSession(db: DrizzleDb, point: MetricPointInput): number {
  const isOtel = point.signal === "otlp_metrics" ? 1 : 0;
  const isJsonl = point.signal === "jsonl" ? 1 : 0;
  // Resolve (find-or-create) the canonical user for this point's identity so the session can point at a
  // deduped person; null when the point carries no identity at all (stays NULL → "unknown").
  const userRowId = usersDb.upsertUser(db, point, point.timestamp);
  db.insert(sessions)
    .values({
      sessionId: point.sessionId,
      userId: point.userId ?? null,
      userEmail: point.userEmail ?? null,
      userAccountId: point.userAccountId ?? null,
      userRowId,
      hasOtel: isOtel,
      hasJsonl: isJsonl,
      metricSource: isOtel ? "otel" : "jsonl",
      firstSeenAt: point.timestamp,
      lastSeenAt: point.timestamp
    })
    .onConflictDoUpdate({
      target: sessions.sessionId,
      set: {
        userId: sql`coalesce(excluded.user_id, ${sessions.userId})`,
        userEmail: sql`coalesce(excluded.user_email, ${sessions.userEmail})`,
        userAccountId: sql`coalesce(excluded.user_account_id, ${sessions.userAccountId})`,
        userRowId: sql`coalesce(excluded.user_row_id, ${sessions.userRowId})`,
        hasOtel: sql`max(${sessions.hasOtel}, excluded.has_otel)`,
        hasJsonl: sql`max(${sessions.hasJsonl}, excluded.has_jsonl)`,
        metricSource: sql`case when max(${sessions.hasOtel}, excluded.has_otel) = 1 then 'otel' else 'jsonl' end`,
        firstSeenAt: sql`min(${sessions.firstSeenAt}, excluded.first_seen_at)`,
        lastSeenAt: sql`max(${sessions.lastSeenAt}, excluded.last_seen_at)`
      }
    })
    .run();

  const row = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.sessionId, point.sessionId)).get();
  return row!.id;
}

// Replace a session's prior jsonl points for a given source (Codex/append-only re-uploads). Returns
// whether the replaced source's signal is its provider's preferred one (so the caller rebuilds the
// rollup, whose now-stale rows still hold the deleted points). Caller wraps in the import transaction.
export function replaceSessionPoints(db: DrizzleDb, source: string, sessionIds: string[]): boolean {
  for (const sid of sessionIds) {
    const sessionSubquery = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.sessionId, sid));
    db.delete(metricPoints)
      .where(and(eq(metricPoints.source, source), eq(metricPoints.signal, "jsonl"), inArray(metricPoints.sessionRowId, sessionSubquery)))
      .run();
  }
  return PROVIDERS[providerOfSource(source)].preferredSignal === "jsonl";
}
