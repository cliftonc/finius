// Composable Drizzle `sql` WHERE fragments for the aggregation/read queries (formerly
// storage/query-helpers.ts's {where, params} string builders). Each builder returns an
// `SQL | undefined` predicate (the AND-combined conditions, WITHOUT a leading WHERE keyword) so call
// sites can splice it as `where(frag)` / `${whereClause(frag)}` and append extra `AND …` scoping with
// `andAll(frag, sql\`…\`)`. Params are interpolated via the `sql` template (no positional `?` array),
// removing the join-vs-where param-ordering footgun.
//
// `rollupWhere`/`pointWhere` reference the typed schema columns so a column rename is a compile error.

import { type SQL, and, sql } from "drizzle-orm";
import { metricPoints, metricRollup, sessions } from "./schema.js";
import type { Granularity, SummaryFilters } from "../types.js";

export { CLAUDE_OTEL_SOURCE as OTEL_SOURCE } from "../../shared/sources.js";

export const GRANULARITY_MS: Record<Granularity, number> = {
  minute: 60_000,
  five_minute: 300_000,
  quarter_hour: 900_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000
};

// The canonical identity expression — COALESCE(user_email, user_account_id, user_id, 'unknown') over
// metric_points columns. Used by pointWhere's user filter and reused (verbatim text) by the read
// queries that GROUP BY / COUNT DISTINCT identity.
export const POINT_IDENTITY: SQL = sql`COALESCE(${metricPoints.userEmail}, ${metricPoints.userAccountId}, ${metricPoints.userId}, 'unknown')`;

export function canUseRollup(filters: SummaryFilters, granularity?: Granularity) {
  if (filters.session != null) return false;
  if (filters.userRowId != null) return false;
  // An explicit source filter is always a raw/comparison request: the unified rollup holds only
  // primary points, so a comparison-only source (a shadowed transcript) isn't there at all. Read
  // metric_points instead, where an explicit source filter returns the raw per-source numbers.
  if (filters.source != null) return false;
  if (granularity != null && GRANULARITY_MS[granularity] < GRANULARITY_MS.hour) return false;
  return hourAligned(filters.from) && hourAligned(filters.to);
}

// WHERE predicate over metric_rollup rows. Returns undefined when no filter applies (→ no WHERE).
export function rollupWhere(filters: SummaryFilters): SQL | undefined {
  const clauses: SQL[] = [];
  if (filters.from) clauses.push(sql`${metricRollup.bucket} >= ${filters.from}`);
  if (filters.to) clauses.push(sql`${metricRollup.bucket} <= ${filters.to}`);
  if (filters.user) clauses.push(sql`${metricRollup.userIdentity} = ${filters.user}`);
  if (filters.userRowId != null) clauses.push(sql`1 = 0`);
  if (filters.model) clauses.push(sql`${metricRollup.model} = ${filters.model}`);
  if (filters.source) clauses.push(sql`${metricRollup.source} = ${filters.source}`);
  return and(...clauses);
}

// WHERE predicate over metric_points rows. With `dedupe` (and no explicit source filter) appends the
// `is_primary = 1` precedence predicate — the static, set-once-at-insert flag. An explicit source
// filter means "show that source raw" (OTel-vs-JSONL comparison), so it skips is_primary.
export function pointWhere(filters: SummaryFilters, opts: { dedupe?: boolean } = {}): SQL | undefined {
  const clauses: SQL[] = [];
  if (filters.from) clauses.push(sql`${metricPoints.timestamp} >= ${filters.from}`);
  if (filters.to) clauses.push(sql`${metricPoints.timestamp} <= ${filters.to}`);
  if (filters.user) clauses.push(sql`${POINT_IDENTITY} = ${filters.user}`);
  if (filters.userRowId != null) {
    const ors: SQL[] = [sql`${metricPoints.sessionRowId} IN (SELECT ${sessions.id} FROM ${sessions} WHERE ${sessions.userRowId} = ${filters.userRowId})`];
    if (filters.userRowIdEmail) {
      ors.push(
        sql`${metricPoints.sessionRowId} IN (SELECT ${sessions.id} FROM ${sessions} WHERE COALESCE(${sessions.userEmail}, ${sessions.userAccountId}, ${sessions.userId}, 'unknown') = ${filters.userRowIdEmail})`
      );
    }
    clauses.push(sql`(${sql.join(ors, sql` OR `)})`);
  }
  if (filters.model) clauses.push(sql`${metricPoints.model} = ${filters.model}`);
  if (filters.source) clauses.push(sql`${metricPoints.source} = ${filters.source}`);
  if (filters.session) clauses.push(sql`${metricPoints.sessionRowId} = ${filters.session}`);
  if (opts.dedupe && !filters.source) clauses.push(sql`${metricPoints.isPrimary} = 1`);
  return and(...clauses);
}

// Render a predicate as a `WHERE …` clause, or empty SQL when there's no predicate. Splice into a
// query as `${whereClause(frag)}`.
export function whereClause(predicate: SQL | undefined): SQL {
  return predicate ? sql`WHERE ${predicate}` : sql``;
}

// Combine a WHERE predicate with additional always-applied scoping (e.g. `kind IN ('tokens','cost')`)
// and render the `WHERE …` clause. Mirrors the old `where ? \`${where} AND <extra>\` : \`WHERE <extra>\``.
export function whereClauseAnd(predicate: SQL | undefined, ...extra: SQL[]): SQL {
  const combined = and(predicate, ...extra);
  return combined ? sql`WHERE ${combined}` : sql``;
}

function hourAligned(t?: number) {
  return t == null || t % GRANULARITY_MS.hour === 0;
}
