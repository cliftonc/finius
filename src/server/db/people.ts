// People / models / filter-option / log-event read queries. Extracted from the storage adapter as
// free functions over the Drizzle handle; SQL preserved verbatim. Uses the shared WHERE fragments
// (fragments.ts), the Postgres-seam SQL bits (dialect.ts), and the users-registry enrichment (users.ts).

import { type DrizzleDb } from "./client.js";
import { sql } from "drizzle-orm";
import { logEvents, metricPoints, metricRollup } from "./schema.js";
import { POINT_IDENTITY, pointWhere, whereClause, whereClauseAnd } from "./fragments.js";
import { dialect } from "./dialect.js";
import { enrichUsers } from "./users.js";
import type { SummaryFilters, PersonSummary, ModelSummary, FilterOptions, LogEventSummary } from "../types.js";

export function listPeople(db: DrizzleDb, filters: SummaryFilters): PersonSummary[] {
  const where = pointWhere(filters, { dedupe: true });
  const rows = db.all<Omit<PersonSummary, "models" | "email" | "displayName" | "githubLogin"> & { models: string | null }>(
    sql`SELECT
        ${POINT_IDENTITY} AS user,
        COUNT(DISTINCT session_row_id) AS sessions,
        COALESCE(SUM(CASE WHEN kind = 'cost' THEN value ELSE 0 END), 0) AS totalCost,
        COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'input' THEN value ELSE 0 END), 0) AS inputTokens,
        COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'output' THEN value ELSE 0 END), 0) AS outputTokens,
        COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type IN ('cache_creation', 'cache_read') THEN value ELSE 0 END), 0) AS cacheTokens,
        COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
        MAX(timestamp) AS lastSeenAt,
        ${dialect.groupConcatDistinct(sql`model`)} AS models
      FROM ${metricPoints} ${whereClause(where)}
      GROUP BY ${POINT_IDENTITY}
      ORDER BY totalCost DESC, totalTokens DESC`
  ) as Array<Omit<PersonSummary, "models" | "email" | "displayName" | "githubLogin"> & { models: string | null }>;

  // Enrich each identity-string group with friendly fields from the users registry. JS-side join (the
  // table is tiny — one row per person) keeps the aggregate SQL and the `user` filter untouched.
  return enrichUsers(db, rows).map((row) => ({
    ...row,
    models: row.models?.split(",").filter(Boolean) ?? []
  }));
}

export function listModels(db: DrizzleDb, filters: SummaryFilters): ModelSummary[] {
  const where = pointWhere(filters, { dedupe: true });
  // Only token/cost points carry a model; other kinds (lines/decision) have NULL model.
  const scoped = whereClauseAnd(where, sql`model IS NOT NULL`);
  const rows = db.all<ModelSummary>(
    sql`SELECT
        model,
        COUNT(DISTINCT session_row_id) AS sessions,
        COUNT(DISTINCT ${POINT_IDENTITY}) AS users,
        COALESCE(SUM(CASE WHEN kind = 'cost' THEN value ELSE 0 END), 0) AS totalCost,
        COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'input' THEN value ELSE 0 END), 0) AS inputTokens,
        COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type = 'output' THEN value ELSE 0 END), 0) AS outputTokens,
        COALESCE(SUM(CASE WHEN kind = 'tokens' AND token_type IN ('cache_creation', 'cache_read') THEN value ELSE 0 END), 0) AS cacheTokens,
        COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
        MAX(timestamp) AS lastSeenAt
      FROM ${metricPoints} ${scoped}
      GROUP BY model
      ORDER BY totalCost DESC, totalTokens DESC`
  ) as ModelSummary[];
  return rows;
}

export function getFilterOptions(db: DrizzleDb): FilterOptions {
  // The rollup is OTel-only, so union its distinct dimensions with metric_points (all signals) to
  // keep the transcript-derived source ('claude-code-jsonl') and any jsonl-only users/models
  // selectable — the comparison view filters on the JSONL source even when every JSONL session is
  // also covered by OTel (and therefore absent from the OTel rollup).
  const sources = db.all<{ source: string }>(
    sql`SELECT source FROM ${metricRollup} UNION SELECT source FROM ${metricPoints} ORDER BY source`
  ) as Array<{ source: string }>;
  const userOpts = db.all<{ user: string }>(
    sql`SELECT user_identity AS user FROM ${metricRollup}
       UNION SELECT COALESCE(user_email, user_account_id, user_id, 'unknown') AS user FROM ${metricPoints}
       ORDER BY user`
  ) as Array<{ user: string }>;
  const models = db.all<{ model: string }>(
    sql`SELECT model FROM ${metricRollup} WHERE model <> ''
       UNION SELECT model FROM ${metricPoints} WHERE model IS NOT NULL AND model <> ''
       ORDER BY model`
  ) as Array<{ model: string }>;
  return { sources: sources.map((r) => r.source), users: userOpts.map((r) => r.user), models: models.map((r) => r.model) };
}

// Grouped inspection view of captured log records: one row per distinct event name with a count,
// the latest timestamp, and a single sample (most recent) so we can see what Codex actually emits.
export function getLogEventSummary(db: DrizzleDb): LogEventSummary[] {
  const rows = db.all<{ eventName: string; count: number; lastSeenAt: number; sampleAttributes: string | null; sampleBody: string | null }>(
    sql`SELECT
        COALESCE(event_name, '(unnamed)') AS eventName,
        COUNT(*) AS count,
        MAX(timestamp) AS lastSeenAt,
        (SELECT attributes_json FROM ${logEvents} e2
           WHERE COALESCE(e2.event_name, '(unnamed)') = COALESCE(e1.event_name, '(unnamed)')
           ORDER BY e2.timestamp DESC LIMIT 1) AS sampleAttributes,
        (SELECT body_json FROM ${logEvents} e2
           WHERE COALESCE(e2.event_name, '(unnamed)') = COALESCE(e1.event_name, '(unnamed)')
           ORDER BY e2.timestamp DESC LIMIT 1) AS sampleBody
      FROM ${logEvents} e1
      GROUP BY COALESCE(event_name, '(unnamed)')
      ORDER BY count DESC`
  );
  return rows.map((row) => ({
    eventName: row.eventName,
    count: row.count,
    lastSeenAt: row.lastSeenAt,
    sample: row.sampleAttributes
      ? { attributes: safeParse(row.sampleAttributes) as Record<string, unknown>, body: safeParse(row.sampleBody) }
      : null
  }));
}

function safeParse(json: string | null): unknown {
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
