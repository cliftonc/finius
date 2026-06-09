// People / models / filter-option / log-event read queries. Extracted from the storage adapter as
// free functions over the Drizzle handle; SQL preserved verbatim. Uses the shared WHERE fragments
// (fragments.ts), the Postgres-seam SQL bits (dialect.ts), and the users-registry enrichment (users.ts).

import { type DrizzleDb } from "./client.js";
import { and, countDistinct, desc, eq, inArray, isNotNull, max, ne, sql } from "drizzle-orm";
import { logEvents, metricPoints, metricRollup } from "./schema-active.js";
import { POINT_IDENTITY, pointWhere, sumWhen } from "./fragments.js";
import { dialect } from "./dialect.js";
import { rawAll } from "./raw.js";
import { enrichUsers } from "./users.js";
import type { SummaryFilters, PersonSummary, ModelSummary, FilterOptions, LogEventSummary } from "../types.js";

const value = metricPoints.value;
const kind = metricPoints.kind;
const tokenType = metricPoints.tokenType;
const inputTokens = () => sumWhen(and(eq(kind, "tokens"), eq(tokenType, "input"))!, value);
const outputTokens = () => sumWhen(and(eq(kind, "tokens"), eq(tokenType, "output"))!, value);
const cacheTokens = () => sumWhen(and(eq(kind, "tokens"), inArray(tokenType, ["cache_creation", "cache_read"]))!, value);
const totalTokens = () => sumWhen(eq(kind, "tokens"), value);
const totalCost = () => sumWhen(eq(kind, "cost"), value);

export async function listPeople(db: DrizzleDb, filters: SummaryFilters): Promise<PersonSummary[]> {
  // Hoist cost/tokens so ORDER BY references the expression (inline `sql` columns carry no alias).
  const cost = totalCost();
  const tokens = totalTokens();
  const rows = (await db
    .select({
      user: POINT_IDENTITY,
      sessions: countDistinct(metricPoints.sessionRowId),
      totalCost: cost,
      inputTokens: inputTokens(),
      outputTokens: outputTokens(),
      cacheTokens: cacheTokens(),
      totalTokens: tokens,
      lastSeenAt: max(metricPoints.timestamp),
      models: dialect.groupConcatDistinct(metricPoints.model)
    })
    .from(metricPoints)
    .where(pointWhere(filters, { dedupe: true }))
    .groupBy(POINT_IDENTITY)
    .orderBy(desc(cost), desc(tokens))
    .execute()) as Array<Omit<PersonSummary, "models" | "email" | "displayName" | "githubLogin"> & { models: string | null }>;

  // Enrich each identity-string group with friendly fields from the users registry. JS-side join (the
  // table is tiny — one row per person) keeps the aggregate query and the `user` filter untouched.
  return (await enrichUsers(db, rows)).map((row) => ({
    ...row,
    models: row.models?.split(",").filter(Boolean) ?? []
  }));
}

export async function listModels(db: DrizzleDb, filters: SummaryFilters): Promise<ModelSummary[]> {
  // Only token/cost points carry a model; other kinds (lines/decision) have NULL model.
  const cost = totalCost();
  const tokens = totalTokens();
  return (await db
    .select({
      model: metricPoints.model,
      sessions: countDistinct(metricPoints.sessionRowId),
      users: countDistinct(POINT_IDENTITY),
      totalCost: cost,
      inputTokens: inputTokens(),
      outputTokens: outputTokens(),
      cacheTokens: cacheTokens(),
      totalTokens: tokens,
      lastSeenAt: max(metricPoints.timestamp)
    })
    .from(metricPoints)
    .where(and(pointWhere(filters, { dedupe: true }), isNotNull(metricPoints.model)))
    .groupBy(metricPoints.model)
    .orderBy(desc(cost), desc(tokens))
    .execute()) as ModelSummary[];
}

export async function getFilterOptions(db: DrizzleDb): Promise<FilterOptions> {
  // The rollup is OTel-only, so union its distinct dimensions with metric_points (all signals) to
  // keep the transcript-derived source ('claude-code-jsonl') and any jsonl-only users/models
  // selectable — the comparison view filters on the JSONL source even when every JSONL session is
  // also covered by OTel (and therefore absent from the OTel rollup).
  // ORDER BY 1 (ordinal) sorts the compound by its first output column — independent of the per-branch
  // alias names (the rollup column `user_identity` is surfaced as `user`), and portable to Postgres.
  const sources = (await db
    .select({ source: metricRollup.source })
    .from(metricRollup)
    .union(db.select({ source: metricPoints.source }).from(metricPoints))
    .orderBy(sql`1`)
    .execute()) as Array<{ source: string }>;
  const userOpts = (await db
    .select({ user: metricRollup.userIdentity })
    .from(metricRollup)
    .union(db.select({ user: sql<string>`${POINT_IDENTITY}` }).from(metricPoints))
    .orderBy(sql`1`)
    .execute()) as Array<{ user: string }>;
  const models = (await db
    .select({ model: metricRollup.model })
    .from(metricRollup)
    .where(ne(metricRollup.model, ""))
    .union(
      db
        .select({ model: sql<string>`${metricPoints.model}` })
        .from(metricPoints)
        .where(and(isNotNull(metricPoints.model), ne(metricPoints.model, "")))
    )
    .orderBy(sql`1`)
    .execute()) as Array<{ model: string }>;
  return { sources: sources.map((r) => r.source), users: userOpts.map((r) => r.user), models: models.map((r) => r.model) };
}

// Grouped inspection view of captured log records: one row per distinct event name with a count,
// the latest timestamp, and a single sample (most recent) so we can see what Codex actually emits.
export async function getLogEventSummary(db: DrizzleDb): Promise<LogEventSummary[]> {
  // Raw SQL via the cross-dialect seam (rawAll → db.all on sqlite, db.execute on pg). One row per event
  // name with a count, latest timestamp, and the most-recent sample. Uses window functions (PARTITION BY
  // + ROW_NUMBER) rather than correlated subqueries on the grouped column — Postgres rejects the latter
  // ("ungrouped column") where SQLite tolerates it; windowing is portable to both (SQLite ≥ 3.25).
  const rows = await rawAll<{ eventName: string; count: number; lastSeenAt: number; sampleAttributes: string | null; sampleBody: string | null }>(
    db,
    sql`SELECT "eventName", "count", "lastSeenAt", "sampleAttributes", "sampleBody" FROM (
        SELECT
          COALESCE(event_name, '(unnamed)') AS "eventName",
          COUNT(*) OVER (PARTITION BY COALESCE(event_name, '(unnamed)')) AS "count",
          MAX(timestamp) OVER (PARTITION BY COALESCE(event_name, '(unnamed)')) AS "lastSeenAt",
          attributes_json AS "sampleAttributes",
          body_json AS "sampleBody",
          ROW_NUMBER() OVER (PARTITION BY COALESCE(event_name, '(unnamed)') ORDER BY timestamp DESC) AS rn
        FROM ${logEvents}
      ) ranked
      WHERE rn = 1
      ORDER BY "count" DESC`
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
