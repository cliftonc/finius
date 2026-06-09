// Aggregation/read queries over metric_points + metric_rollup: summary, timeseries, and the
// breakdown helpers. Free functions over the Drizzle handle, written with the typed query builder —
// FROM/WHERE/GROUP BY/ORDER BY are builder calls; only the conditional aggregates (via sumWhen) and
// the dialect time-bucket stay as `sql`. Uses the shared WHERE fragments (fragments.ts), the
// Postgres-seam SQL bits (dialect.ts), and the users-registry enrichment (users.ts).

import { type DrizzleDb } from "./client.js";
import { type Column, type SQL, and, countDistinct, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { metricPoints, metricRollup } from "./schema-active.js";
import { GRANULARITY_MS, POINT_IDENTITY, canUseRollup, pointWhere, rollupWhere, sumWhen } from "./fragments.js";
import { dialect } from "./dialect.js";
import { enrichUsers } from "./users.js";
import type { Granularity, SummaryFilters, Summary, TimeseriesPoint, ModelTimeseriesPoint } from "../types.js";

// The 12 conditional-sum columns shared by summaryFromRollup/summaryFromPoints (and, +cacheTokens, by
// getTimeseries). Parameterized by the table's kind/token_type/value columns so the rollup (sum_value)
// and the points (value) paths share one definition.
function summaryAggregates(kind: Column, tokenType: Column, value: Column) {
  const kt = (k: string, tt: string) => sumWhen(and(eq(kind, k), eq(tokenType, tt))!, value);
  const tok = (tt: string) => kt("tokens", tt);
  return {
    totalCost: sumWhen(eq(kind, "cost"), value),
    inputTokens: tok("input"),
    outputTokens: tok("output"),
    cacheCreationTokens: tok("cache_creation"),
    cacheReadTokens: tok("cache_read"),
    totalTokens: sumWhen(eq(kind, "tokens"), value),
    linesAdded: kt("lines", "added"),
    linesRemoved: kt("lines", "removed"),
    editsAccepted: kt("decision", "accept"),
    editsRejected: kt("decision", "reject"),
    pullRequests: sumWhen(eq(kind, "pull_request"), value),
    commits: sumWhen(eq(kind, "commit"), value)
  };
}

export async function getSummary(db: DrizzleDb, filters: SummaryFilters): Promise<Summary> {
  // The rollup has no session dimension, so a session-filtered summary falls back to metric_points.
  return canUseRollup(filters) ? summaryFromRollup(db, filters) : summaryFromPoints(db, filters);
}

// Served from the pre-aggregated rollup. Scalar totals + activeSenders sum cleanly from rollup
// rows; sessionCount is a distinct count that cannot be summed across buckets, so it stays on
// metric_points (see upsertRollup note).
async function summaryFromRollup(db: DrizzleDb, filters: SummaryFilters): Promise<Summary> {
  const where = rollupWhere(filters);
  const totals = (
    await db
      .select({
        ...summaryAggregates(metricRollup.kind, metricRollup.tokenType, metricRollup.sumValue),
        activeSenders: countDistinct(metricRollup.userIdentity)
      })
      .from(metricRollup)
      .where(where)
      .execute()
  )[0]!;

  const sessionRow = (
    await db
      .select({ sessionCount: countDistinct(metricPoints.sessionRowId) })
      .from(metricPoints)
      .where(pointWhere(filters, { dedupe: true }))
      .execute()
  )[0];

  return {
    ...totals,
    sessionCount: sessionRow?.sessionCount ?? 0,
    models: await rollupBreakdown(db, sql`model`, "model", sql`model`, filters),
    users: await enrichUsers(db, await rollupBreakdown(db, sql`user_identity`, "user", POINT_IDENTITY, filters)),
    sources: await rollupBreakdown(db, sql`source`, "source", sql`source`, filters)
  };
}

// Fallback path: aggregate directly over metric_points (used when a session filter is present,
// which the rollup can't express). Identical results to summaryFromRollup.
async function summaryFromPoints(db: DrizzleDb, filters: SummaryFilters): Promise<Summary> {
  const where = pointWhere(filters, { dedupe: true });
  const totals = (
    await db
      .select({
        ...summaryAggregates(metricPoints.kind, metricPoints.tokenType, metricPoints.value),
        sessionCount: countDistinct(metricPoints.sessionRowId),
        activeSenders: countDistinct(POINT_IDENTITY)
      })
      .from(metricPoints)
      .where(where)
      .execute()
  )[0]!;

  return {
    ...totals,
    models: await breakdown(db, sql`model`, "model", where),
    users: await enrichUsers(db, await breakdown(db, POINT_IDENTITY, "user", where)),
    sources: await breakdown(db, sql`source`, "source", where)
  };
}

export async function getTimeseries(db: DrizzleDb, filters: SummaryFilters & { granularity?: Granularity }): Promise<TimeseriesPoint[]> {
  const granularity = filters.granularity ?? "hour";
  const bucketMs = GRANULARITY_MS[granularity];
  // Hour/day/week (>= the hourly rollup grain) re-bucket from the rollup; sub-hour grains and
  // session-filtered reads (the live view) fall back to metric_points for exact resolution.
  // Group/order by the bucket EXPRESSION (not the output alias) — the inline `sql` select columns
  // carry no `AS bucket`, and grouping by the expression is the portable form (Postgres too).
  if (canUseRollup(filters, granularity)) {
    const bucket = sql<number>`${dialect.bucket(metricRollup.bucket, bucketMs)}`;
    const agg = summaryAggregates(metricRollup.kind, metricRollup.tokenType, metricRollup.sumValue);
    return (await db
      .select({
        bucket,
        ...agg,
        cacheTokens: sumWhen(and(eq(metricRollup.kind, "tokens"), inArray(metricRollup.tokenType, ["cache_creation", "cache_read"]))!, metricRollup.sumValue)
      })
      .from(metricRollup)
      .where(rollupWhere(filters))
      .groupBy(bucket)
      .orderBy(bucket)
      .execute()) as TimeseriesPoint[];
  }

  const bucket = sql<number>`${dialect.bucket(metricPoints.timestamp, bucketMs)}`;
  const agg = summaryAggregates(metricPoints.kind, metricPoints.tokenType, metricPoints.value);
  return (await db
    .select({
      bucket,
      ...agg,
      cacheTokens: sumWhen(and(eq(metricPoints.kind, "tokens"), inArray(metricPoints.tokenType, ["cache_creation", "cache_read"]))!, metricPoints.value)
    })
    .from(metricPoints)
    .where(pointWhere(filters, { dedupe: true }))
    .groupBy(bucket)
    .orderBy(bucket)
    .execute()) as TimeseriesPoint[];
}

// Per-model timeseries: one row per (bucket, model) with summed tokens and a distinct session
// count. Always reads metric_points (the distinct session count can't be summed across rollup
// buckets, and only token/cost points carry a model), applying the same is_primary filter so a
// session with both OTel and a transcript isn't double-counted. The client pivots these flat rows
// into one line per model for the "tokens / sessions by model" charts.
export async function getModelTimeseries(db: DrizzleDb, filters: SummaryFilters & { granularity?: Granularity }): Promise<ModelTimeseriesPoint[]> {
  const granularity = filters.granularity ?? "hour";
  const bucketMs = GRANULARITY_MS[granularity];
  const bucket = sql<number>`${dialect.bucket(metricPoints.timestamp, bucketMs)}`;
  return (await db
    .select({
      bucket,
      model: metricPoints.model,
      totalTokens: sumWhen(eq(metricPoints.kind, "tokens"), metricPoints.value),
      sessions: countDistinct(metricPoints.sessionRowId)
    })
    .from(metricPoints)
    .where(and(pointWhere(filters, { dedupe: true }), isNotNull(metricPoints.model), inArray(metricPoints.kind, ["tokens", "cost"])))
    .groupBy(bucket, metricPoints.model)
    .orderBy(bucket)
    .execute()) as ModelTimeseriesPoint[];
}

export async function breakdown(db: DrizzleDb, field: SQL, alias: string, where: SQL | undefined) {
  // Breakdowns attribute cost/tokens, so restrict to those rows — otherwise lines/decision/
  // active_time points (which carry no model) would add a spurious "unknown" group.
  const totalCost = sumWhen(eq(metricPoints.kind, "cost"), metricPoints.value);
  const totalTokens = sumWhen(eq(metricPoints.kind, "tokens"), metricPoints.value);
  const rows = (await db
    .select({ [alias]: field, totalCost, totalTokens, sessions: countDistinct(metricPoints.sessionRowId) })
    .from(metricPoints)
    .where(and(where, inArray(metricPoints.kind, ["tokens", "cost"])))
    .groupBy(field)
    .orderBy(desc(totalCost), desc(totalTokens))
    .limit(10)
    .execute()) as Array<Record<string, string | number | null>>;

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
export async function rollupBreakdown(db: DrizzleDb, rollupDim: SQL, alias: string, pointDim: SQL, filters: SummaryFilters) {
  const totalCost = sumWhen(eq(metricRollup.kind, "cost"), metricRollup.sumValue);
  const totalTokens = sumWhen(eq(metricRollup.kind, "tokens"), metricRollup.sumValue);
  const rows = (await db
    .select({ [alias]: rollupDim, totalCost, totalTokens })
    .from(metricRollup)
    .where(and(rollupWhere(filters), inArray(metricRollup.kind, ["tokens", "cost"])))
    .groupBy(rollupDim)
    .orderBy(desc(totalCost), desc(totalTokens))
    .limit(10)
    .execute()) as Array<Record<string, string | number | null>>;

  const sessionsByGroup = await distinctSessionsByGroup(db, pointDim, filters);
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
export async function distinctSessionsByGroup(db: DrizzleDb, pointDim: SQL, filters: SummaryFilters): Promise<Map<string, number>> {
  const rows = (await db
    .select({ grp: pointDim, sessions: countDistinct(metricPoints.sessionRowId) })
    .from(metricPoints)
    .where(and(pointWhere(filters, { dedupe: true }), inArray(metricPoints.kind, ["tokens", "cost"])))
    .groupBy(pointDim)
    .execute()) as Array<{ grp: string | null; sessions: number }>;
  return new Map(rows.map((r) => [String(r.grp || "unknown"), r.sessions]));
}
