// Ingest/write layer: free functions over the Drizzle handle for the write side of the pipeline —
// raw_batches dedup, metric_points insertion with materialized `is_primary` precedence, the hourly
// metric_rollup maintenance, session upserts, log_events, source_files, and pruning. Extracted from
// the storage adapter so the write logic lives in the db/ layer alongside the read modules.
//
// Every function takes the Drizzle handle (`db`) as its first arg and uses ONLY it. All writes are
// async via the builder `.execute()` (or the raw-SQL seam in ./raw.js) so the SAME code runs on
// node:sqlite and Postgres. Transactions have been removed (see CLAUDE.md): the derived metric_rollup
// and is_primary flag are rebuildable (rebuildRollup / rebuildIsPrimary), so a partial-failure leaves
// at worst a transient under-count that the maintenance endpoints repair. The one invariant that needs
// protecting without a transaction — no double-counting on a transcript re-import — is preserved by the
// adapter writing the source_files dedup marker FIRST (see processImport).

import { type DrizzleDb } from "./client.js";
import { and, desc, eq, inArray, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import { logEvents, metricPoints, metricRollup, rawBatches, sessions, sourceFiles } from "./schema-active.js";
import { dialect } from "./dialect.js";
import { affectedRows, isUniqueViolation, rawGet, rawRun } from "./raw.js";
import * as usersDb from "./users.js";
import { PROVIDERS, SOURCES, type Signal, isPrimarySource, providerOfSource } from "../../shared/sources.js";
import { preferredIdentity } from "../otel.js";
import type { MetricPointInput, OtelLogRecord, TranscriptInfo } from "../types.js";

// Dedup-insert a raw OTLP batch; returns the new id, or null on the UNIQUE(hash) collision (duplicate).
// payload_json is NOT NULL in the schema; store '' (treated as "no payload") when payload storage is
// disabled, so we avoid a table rebuild while still keeping the dedup hash.
export async function insertRawBatch(db: DrizzleDb, signal: string, hash: string, batch: unknown, storeRawPayloads: boolean): Promise<number | null> {
  const payload = storeRawPayloads ? JSON.stringify(batch) : "";
  try {
    const [row] = (await db
      .insert(rawBatches)
      .values({ signal, hash, payloadJson: payload, receivedAt: Date.now() })
      .returning({ id: rawBatches.id })
      .execute()) as Array<{ id: number }>;
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

// Index OTLP log records into log_events (NOT aggregated into metric_points).
export async function insertLogEvents(db: DrizzleDb, records: OtelLogRecord[], rawBatchId: number | null): Promise<void> {
  for (const record of records) {
    await db
      .insert(logEvents)
      .values({
        eventName: record.eventName,
        severity: record.severityText,
        sessionId: record.sessionId,
        timestamp: record.timestamp,
        attributesJson: JSON.stringify(record.attributes ?? {}),
        bodyJson: record.body === undefined ? null : JSON.stringify(record.body ?? null),
        rawBatchId
      })
      .execute();
  }
}

// Already-imported? A persistent source_files row for this content hash means we've processed it.
export async function uploadExists(db: DrizzleDb, hash: string): Promise<boolean> {
  return !!(await db.select({ one: sql`1` }).from(sourceFiles).where(eq(sourceFiles.hash, hash)).limit(1).execute())[0];
}

// Resolve a Copilot transcript's own chat-session id to the OTel session id that carries its tokens, by
// matching the copilot_chat.* / gen_ai.conversation.id attributes recorded on the OTel metric points.
export async function resolveCopilotTranscriptSession(db: DrizzleDb, chatSessionId: string | null | undefined): Promise<string | undefined> {
  if (!chatSessionId) return undefined;
  const attrs = metricPoints.attributesJson;
  const row = await rawGet<{ sessionId: string }>(
    db,
    sql`SELECT ${metricPoints.sessionId} AS "sessionId"
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
export async function getSourceFileForSession(db: DrizzleDb, sessionRowId: number): Promise<{ blobKey: string; source: string; importedAt: number } | null> {
  const row = (
    await db
      .select({ blobKey: sourceFiles.blobKey, source: sourceFiles.source, importedAt: sourceFiles.importedAt })
      .from(sourceFiles)
      .where(eq(sourceFiles.sessionRowId, sessionRowId))
      .orderBy(desc(sourceFiles.importedAt))
      .limit(1)
      .execute()
  )[0];
  return row ?? null;
}

// Metadata only (no blob read) so the UI can decide whether to show a "view transcript" link.
export async function getSessionTranscriptInfo(db: DrizzleDb, sessionRowId: number): Promise<TranscriptInfo | null> {
  const row = (
    await db
      .select({ source: sourceFiles.source, importedAt: sourceFiles.importedAt, byteSize: sourceFiles.byteSize, lineCount: sourceFiles.lineCount })
      .from(sourceFiles)
      .where(eq(sourceFiles.sessionRowId, sessionRowId))
      .orderBy(desc(sourceFiles.importedAt))
      .limit(1)
      .execute()
  )[0];
  return (row as TranscriptInfo | undefined) ?? null;
}

// Link an imported transcript file (the content-hash dedup marker). The session_row_id is resolved from
// the session id IF the session already exists; on a fresh transcript import the marker is written
// BEFORE the points (so a retry dedups, preserving the no-double-count invariant without a transaction),
// at which point the session row doesn't exist yet — recordSourceFile leaves session_row_id NULL and the
// caller backfills it via linkSourceFileSession after the points (which create the session) are inserted.
export async function recordSourceFile(
  db: DrizzleDb,
  input: { source: string; sessionId: string | null; hash: string; byteSize: number; lineCount: number }
): Promise<void> {
  const sessionRow = input.sessionId
    ? (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.sessionId, input.sessionId)).limit(1).execute())[0]
    : undefined;
  await db
    .insert(sourceFiles)
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
    .execute();
}

// Backfill a source_files row's session_row_id once the session it belongs to exists (the marker was
// written first, before the points that create the session). Idempotent: only fills NULL links.
export async function linkSourceFileSession(db: DrizzleDb, hash: string, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const sessionRow = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1).execute())[0];
  if (!sessionRow) return;
  await db
    .update(sourceFiles)
    .set({ sessionRowId: sessionRow.id })
    .where(and(eq(sourceFiles.hash, hash), isNull(sourceFiles.sessionRowId)))
    .execute();
}

// Delete raw_batches older than the cutoff, orphaning (not cascading) the metric_points/log_events
// back-references first so the aggregated data survives. No transaction (see module header): each step
// is idempotent, so a partial run is repaired by re-running.
export async function pruneRawBatches(db: DrizzleDb, beforeTimestampMs: number): Promise<{ deleted: number }> {
  const staleBatches = db.select({ id: rawBatches.id }).from(rawBatches).where(lt(rawBatches.receivedAt, beforeTimestampMs));
  await db.update(metricPoints).set({ rawBatchId: null }).where(inArray(metricPoints.rawBatchId, staleBatches)).execute();
  await db.update(logEvents).set({ rawBatchId: null }).where(inArray(logEvents.rawBatchId, staleBatches)).execute();
  const result = await db.delete(rawBatches).where(lt(rawBatches.receivedAt, beforeTimestampMs)).execute();
  return { deleted: affectedRows(result) };
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
export async function insertMetricPoint(db: DrizzleDb, point: MetricPointInput, rawBatchId: number | null): Promise<{ isPrimary: boolean; transitioned: boolean }> {
  const provider = providerOfSource(point.source);
  const pref = PROVIDERS[provider].preferredSignal;
  const isPreferredPoint = point.signal === pref;

  // Capture the session's PRIOR "has preferred signal" state BEFORE upsertSession updates the flags.
  // has_otel tracks the otlp_metrics signal, has_jsonl the jsonl signal — so we read the flag that
  // corresponds to this provider's preferred signal. A brand-new session has neither (no preferred).
  const prefColumn = pref === "otlp_metrics" ? sessions.hasOtel : sessions.hasJsonl;
  const existing = (await db.select({ id: sessions.id, prefFlag: prefColumn }).from(sessions).where(eq(sessions.sessionId, point.sessionId)).limit(1).execute())[0];
  const sessionHadPreferred = existing?.prefFlag === 1;

  const sessionRowId = await upsertSession(db, point);

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
    const result = await db
      .update(metricPoints)
      .set({ isPrimary: 0 })
      .where(and(eq(metricPoints.sessionRowId, sessionRowId), ne(metricPoints.signal, pref), eq(metricPoints.isPrimary, 1)))
      .execute();
    transitioned = affectedRows(result) > 0;
  }

  await db
    .insert(metricPoints)
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
    .execute();

  return { isPrimary, transitioned };
}

// Maintain the pre-aggregated hourly rollup that serves the home view. NOTE: sum_value/cnt are additive
// only — distinct counts (sessions/users) cannot be derived from here because an entity spans many
// buckets; those stay on metric_points. The ON CONFLICT increment is atomic per-statement, so
// concurrent incremental upserts stay correct even without a wrapping transaction.
export async function upsertRollup(db: DrizzleDb, point: MetricPointInput): Promise<void> {
  const bucket = Math.floor(point.timestamp / 3_600_000) * 3_600_000;
  await db
    .insert(metricRollup)
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
    .execute();
}

// Rebuild the entire metric_rollup from scratch as the aggregate of every primary metric point. The
// rollup invariant is `metric_rollup == aggregate of metric_points WHERE is_primary = 1`; an
// incremental upsertRollup keeps it true on the happy path, but a bulk delete+reinsert (computed cost
// recompute, or a Codex replace-by-session) breaks it, so we re-aggregate wholesale. The
// bucket/identity/model/token_type expressions MUST match upsertRollup exactly so incremental and
// rebuilt rollups agree (the bucket grain goes through dialect.bucket so it matches Math.floor above).
export async function rebuildRollup(db: DrizzleDb): Promise<void> {
  await db.delete(metricRollup).execute();
  await rawRun(
    db,
    sql`
    INSERT INTO metric_rollup (bucket, source, user_identity, model, kind, token_type, sum_value, cnt)
    SELECT
      ${dialect.bucket(sql`timestamp`, 3_600_000)} AS bucket,
      source,
      COALESCE(user_email, user_account_id, user_id, 'unknown') AS user_identity,
      COALESCE(model, '') AS model,
      kind,
      COALESCE(token_type, '') AS token_type,
      SUM(value) AS sum_value,
      COUNT(*) AS cnt
    FROM metric_points
    WHERE is_primary = 1
    GROUP BY 1, source, user_identity, model, kind, token_type
  `
  );
}

// The shared ingest loop used by the OTLP metrics/traces paths: insert each point, feed the rollup from
// its DYNAMIC primacy, and rebuild once if any insert triggered a transition (late preferred signal
// demoting a session's promoted transcript points).
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
export async function ingestMetricPoints(db: DrizzleDb, points: MetricPointInput[], rawBatchId: number | null): Promise<void> {
  const substantive = new Set(points.filter((p) => !GHOST_KINDS.has(p.kind)).map((p) => p.sessionId));
  const candidateIds = [...new Set(points.map((p) => p.sessionId))].filter((id) => !substantive.has(id));
  const existing = new Set<string>(
    candidateIds.length === 0
      ? []
      : (await db.select({ sessionId: sessions.sessionId }).from(sessions).where(inArray(sessions.sessionId, candidateIds)).execute()).map((r) => r.sessionId)
  );
  let needsRebuild = false;
  for (const point of points) {
    if (GHOST_KINDS.has(point.kind) && !substantive.has(point.sessionId) && !existing.has(point.sessionId)) continue;
    const { isPrimary, transitioned } = await insertMetricPoint(db, point, rawBatchId);
    if (isPrimary) await upsertRollup(db, point);
    if (transitioned) needsRebuild = true;
  }
  if (needsRebuild) await rebuildRollup(db);
}

// Re-materialize is_primary for the ENTIRE table from first principles (the registry's preferred-signal
// rule), independent of the per-point insert-time computation. A point is primary unless shadowed; a
// non-preferred-signal ("shadowable") point is shadowed iff its session ALSO holds a preferred-signal
// point. Authoritative + idempotent: the preferred signal's presence is read from the ACTUAL points in
// the session (an EXISTS), NOT the sticky has_otel/has_jsonl flags — a replaceSessionPoints delete can
// leave a flag over-claiming a signal that no longer has points, which would wrongly shadow the
// survivor. On healthy data this yields exactly what a fresh sequence of insertMetricPoint calls would.
// Unlike the per-point path, this also corrects rows that drifted (a bad backfill, a precedence-rule
// change). Callers rebuild the rollup afterward (the rollup must reflect the corrected is_primary).
export async function rebuildIsPrimary(db: DrizzleDb): Promise<void> {
  // Sources whose signal is NOT their provider's preferred signal (the only ones that can be shadowed):
  // today claude-code-jsonl + copilot-vscode-jsonl. Codex/manual JSONL are their providers' PREFERRED
  // signal, so they're never shadowable. Unknown sources are treated as primary (isPrimarySource).
  const shadowable = SOURCES.filter((s) => !isPrimarySource(s.id));
  if (shadowable.length === 0) {
    await db.update(metricPoints).set({ isPrimary: 1 }).execute();
    return;
  }
  // 1. Everything that is not a known shadowable source is primary (incl. unknown sources).
  await db
    .update(metricPoints)
    .set({ isPrimary: 1 })
    .where(notInArray(metricPoints.source, shadowable.map((s) => s.id)))
    .execute();
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
    // The correlated subquery references the outer table by name (no target alias — legal on both
    // SQLite and Postgres for an unaliased UPDATE target).
    await rawRun(
      db,
      sql`
      UPDATE metric_points SET is_primary = CASE
        WHEN EXISTS (
          SELECT 1 FROM metric_points pp
          WHERE pp.session_row_id = metric_points.session_row_id
            AND pp.signal = ${pref}
        ) THEN 0 ELSE 1 END
      WHERE source IN (${idList})`
    );
  }
}

// Upsert the single session row for this point's UUID and fold in which signal it came from. The OR
// (via greatest over the 0/1 flags) makes presence sticky, and metric_source resolves to 'otel'
// whenever OTel has ever been seen for the session — that stored flag IS the read-time precedence.
export async function upsertSession(db: DrizzleDb, point: MetricPointInput): Promise<number> {
  const isOtel = point.signal === "otlp_metrics" ? 1 : 0;
  const isJsonl = point.signal === "jsonl" ? 1 : 0;
  // Resolve (find-or-create) the canonical user for this point's identity so the session can point at a
  // deduped person; null when the point carries no identity at all (stays NULL → "unknown").
  const userRowId = await usersDb.upsertUser(db, point, point.timestamp);
  await db
    .insert(sessions)
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
        hasOtel: dialect.greatest(sessions.hasOtel, sql`excluded.has_otel`),
        hasJsonl: dialect.greatest(sessions.hasJsonl, sql`excluded.has_jsonl`),
        metricSource: sql`case when ${dialect.greatest(sessions.hasOtel, sql`excluded.has_otel`)} = 1 then 'otel' else 'jsonl' end`,
        firstSeenAt: dialect.least(sessions.firstSeenAt, sql`excluded.first_seen_at`),
        lastSeenAt: dialect.greatest(sessions.lastSeenAt, sql`excluded.last_seen_at`)
      }
    })
    .execute();

  const row = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.sessionId, point.sessionId)).limit(1).execute())[0];
  return row!.id;
}

// Replace a session's prior jsonl points for a given source (Codex/append-only re-uploads). Returns
// whether the replaced source's signal is its provider's preferred one (so the caller rebuilds the
// rollup, whose now-stale rows still hold the deleted points).
export async function replaceSessionPoints(db: DrizzleDb, source: string, sessionIds: string[]): Promise<boolean> {
  for (const sid of sessionIds) {
    const sessionSubquery = db.select({ id: sessions.id }).from(sessions).where(eq(sessions.sessionId, sid));
    await db
      .delete(metricPoints)
      .where(and(eq(metricPoints.source, source), eq(metricPoints.signal, "jsonl"), inArray(metricPoints.sessionRowId, sessionSubquery)))
      .execute();
  }
  return PROVIDERS[providerOfSource(source)].preferredSignal === "jsonl";
}
