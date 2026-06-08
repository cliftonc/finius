// Aggregation/read queries over metric_points + metric_rollup: summary, timeseries, and the
// breakdown helpers. Extracted from the storage adapter as free functions over the Drizzle handle;
// the SQL is preserved verbatim. Uses the shared WHERE fragments (fragments.ts), the Postgres-seam
// SQL bits (dialect.ts), and the users-registry enrichment (users.ts).

import { type DrizzleDb } from "./client.js";
import { type SQL, sql } from "drizzle-orm";
import { metricPoints, metricRollup } from "./schema.js";
import {
  GRANULARITY_MS,
  POINT_IDENTITY,
  canUseRollup,
  pointWhere,
  rollupWhere,
  whereClause,
  whereClauseAnd
} from "./fragments.js";
import { dialect } from "./dialect.js";
import { enrichUsers } from "./users.js";
import type { Granularity, SummaryFilters, Summary, TimeseriesPoint, ModelTimeseriesPoint } from "../types.js";

export function getSummary(db: DrizzleDb, filters: SummaryFilters): Summary {
  // The rollup has no session dimension, so a session-filtered summary falls back to metric_points.
  return canUseRollup(filters) ? summaryFromRollup(db, filters) : summaryFromPoints(db, filters);
}

// Served from the pre-aggregated rollup. Scalar totals + activeSenders sum cleanly from rollup
// rows; sessionCount is a distinct count that cannot be summed across buckets, so it stays on
// metric_points (see upsertRollup note).
function summaryFromRollup(db: DrizzleDb, filters: SummaryFilters): Summary {
  const where = rollupWhere(filters);
  const totals = db.get<Record<string, number>>(
    sql`SELECT
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
      FROM ${metricRollup} ${whereClause(where)}`
  ) as Record<string, number>;

  const pointWhereFrag = pointWhere(filters, { dedupe: true });
  const { sessionCount } = db.get<{ sessionCount: number }>(
    sql`SELECT COUNT(DISTINCT session_row_id) AS sessionCount FROM ${metricPoints} ${whereClause(pointWhereFrag)}`
  ) as { sessionCount: number };

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
    models: rollupBreakdown(db, sql`model`, "model", sql`model`, filters),
    users: enrichUsers(db, rollupBreakdown(db, sql`user_identity`, "user", POINT_IDENTITY, filters)),
    sources: rollupBreakdown(db, sql`source`, "source", sql`source`, filters)
  };
}

// Fallback path: aggregate directly over metric_points (used when a session filter is present,
// which the rollup can't express). Identical results to summaryFromRollup.
function summaryFromPoints(db: DrizzleDb, filters: SummaryFilters): Summary {
  const where = pointWhere(filters, { dedupe: true });
  const totals = db.get<Record<string, number>>(
    sql`SELECT
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
      FROM ${metricPoints} ${whereClause(where)}`
  ) as Record<string, number>;

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
    models: breakdown(db, sql`model`, "model", where),
    users: enrichUsers(db, breakdown(db, POINT_IDENTITY, "user", where)),
    sources: breakdown(db, sql`source`, "source", where)
  };
}

export function getTimeseries(db: DrizzleDb, filters: SummaryFilters & { granularity?: Granularity }): TimeseriesPoint[] {
  const granularity = filters.granularity ?? "hour";
  const bucketMs = GRANULARITY_MS[granularity];
  // Hour/day/week (>= the hourly rollup grain) re-bucket from the rollup; sub-hour grains and
  // session-filtered reads (the live view) fall back to metric_points for exact resolution.
  if (canUseRollup(filters, granularity)) {
    const where = rollupWhere(filters);
    return db.all<TimeseriesPoint>(
      sql`SELECT
          ${dialect.bucket(sql`bucket`, bucketMs)} AS bucket,
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
        FROM ${metricRollup} ${whereClause(where)}
        GROUP BY bucket
        ORDER BY bucket ASC`
    ) as TimeseriesPoint[];
  }

  const where = pointWhere(filters, { dedupe: true });
  const rows = db.all<TimeseriesPoint>(
    sql`SELECT
        ${dialect.bucket(sql`timestamp`, bucketMs)} AS bucket,
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
      FROM ${metricPoints} ${whereClause(where)}
      GROUP BY bucket
      ORDER BY bucket ASC`
  ) as TimeseriesPoint[];
  return rows;
}

// Per-model timeseries: one row per (bucket, model) with summed tokens and a distinct session
// count. Always reads metric_points (the distinct session count can't be summed across rollup
// buckets, and only token/cost points carry a model), applying the same is_primary filter so a
// session with both OTel and a transcript isn't double-counted. The client pivots these flat rows
// into one line per model for the "tokens / sessions by model" charts.
export function getModelTimeseries(db: DrizzleDb, filters: SummaryFilters & { granularity?: Granularity }): ModelTimeseriesPoint[] {
  const granularity = filters.granularity ?? "hour";
  const bucketMs = GRANULARITY_MS[granularity];
  const where = pointWhere(filters, { dedupe: true });
  const scoped = whereClauseAnd(where, sql`model IS NOT NULL`, sql`kind IN ('tokens', 'cost')`);
  return db.all<ModelTimeseriesPoint>(
    sql`SELECT
        ${dialect.bucket(sql`timestamp`, bucketMs)} AS bucket,
        model,
        COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
        COUNT(DISTINCT session_row_id) AS sessions
      FROM ${metricPoints} ${scoped}
      GROUP BY bucket, model
      ORDER BY bucket ASC`
  ) as ModelTimeseriesPoint[];
}

export function breakdown(db: DrizzleDb, field: SQL, alias: string, where: SQL | undefined) {
  // Breakdowns attribute cost/tokens, so restrict to those rows — otherwise lines/decision/
  // active_time points (which carry no model) would add a spurious "unknown" group.
  const scoped = whereClauseAnd(where, sql`kind IN ('tokens', 'cost')`);
  const rows = db.all<Record<string, string | number | null>>(
    sql`SELECT
        ${field} AS ${sql.raw(alias)},
        COALESCE(SUM(CASE WHEN kind = 'cost' THEN value ELSE 0 END), 0) AS totalCost,
        COALESCE(SUM(CASE WHEN kind = 'tokens' THEN value ELSE 0 END), 0) AS totalTokens,
        COUNT(DISTINCT session_row_id) AS sessions
      FROM ${metricPoints} ${scoped}
      GROUP BY ${field}
      ORDER BY totalCost DESC, totalTokens DESC
      LIMIT 10`
  ) as Array<Record<string, string | number | null>>;

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
export function rollupBreakdown(db: DrizzleDb, rollupDim: SQL, alias: string, pointDim: SQL, filters: SummaryFilters) {
  const where = rollupWhere(filters);
  const scoped = whereClauseAnd(where, sql`kind IN ('tokens', 'cost')`);
  const rows = db.all<Record<string, string | number | null>>(
    sql`SELECT
        ${rollupDim} AS ${sql.raw(alias)},
        COALESCE(SUM(CASE WHEN kind = 'cost' THEN sum_value ELSE 0 END), 0) AS totalCost,
        COALESCE(SUM(CASE WHEN kind = 'tokens' THEN sum_value ELSE 0 END), 0) AS totalTokens
      FROM ${metricRollup} ${scoped}
      GROUP BY ${rollupDim}
      ORDER BY totalCost DESC, totalTokens DESC
      LIMIT 10`
  ) as Array<Record<string, string | number | null>>;

  const sessionsByGroup = distinctSessionsByGroup(db, pointDim, filters);
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
export function distinctSessionsByGroup(db: DrizzleDb, pointDim: SQL, filters: SummaryFilters): Map<string, number> {
  const where = pointWhere(filters, { dedupe: true });
  const scoped = whereClauseAnd(where, sql`kind IN ('tokens', 'cost')`);
  const rows = db.all<{ grp: string | null; sessions: number }>(
    sql`SELECT ${pointDim} AS grp, COUNT(DISTINCT session_row_id) AS sessions
       FROM ${metricPoints} ${scoped}
       GROUP BY ${pointDim}`
  ) as Array<{ grp: string | null; sessions: number }>;
  return new Map(rows.map((r) => [String(r.grp || "unknown"), r.sessions]));
}
