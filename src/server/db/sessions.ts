// Session list/detail read queries. Extracted from the storage adapter as free functions over the
// Drizzle handle; SQL preserved verbatim. Uses the shared WHERE fragments (fragments.ts), the
// Postgres-seam SQL bits (dialect.ts), the users-registry directory/lookup (users.ts), and OTEL_SOURCE.

import { type DrizzleDb } from "./client.js";
import { type SQL, and, sql } from "drizzle-orm";
import { metricPoints, sessions, sourceFiles } from "./schema.js";
import { OTEL_SOURCE, whereClause } from "./fragments.js";
import { dialect } from "./dialect.js";
import { getUserById, userDirectory } from "./users.js";
import type { SummaryFilters, SessionSummary } from "../types.js";

export function listSessions(db: DrizzleDb, filters: SummaryFilters): Promise<SessionSummary[]> {
  return buildSessions(db, filters, sql`ORDER BY s.last_seen_at DESC LIMIT 100`);
}

// Direct id lookup (no LIMIT) so drilling into any session — not just the 100 most recent — works.
export async function getSession(db: DrizzleDb, id: number): Promise<SessionSummary | null> {
  const rows = await buildSessions(db, { session: id }, sql``);
  return rows[0] ?? null;
}

// Shared session-row builder. One row per session UUID. By default the joined metric_points are
// restricted to the session's authoritative signal (so totals never mix OTel with a shadowed
// transcript); an explicit `source` filter switches to that source's raw points for the OTel-vs-
// JSONL comparison view, and limits the list to sessions that actually carry that source.
export async function buildSessions(db: DrizzleDb, filters: SummaryFilters, tail: SQL): Promise<SessionSummary[]> {
  const joinCondition: SQL = filters.source
    ? sql`p.session_row_id = s.id AND p.source = ${filters.source}`
    : sql`p.session_row_id = s.id AND p.is_primary = 1`;

  const clauses: SQL[] = [];
  if (filters.from) clauses.push(sql`s.last_seen_at >= ${filters.from}`);
  if (filters.to) clauses.push(sql`s.first_seen_at <= ${filters.to}`);
  if (filters.user) clauses.push(sql`COALESCE(s.user_email, s.user_account_id, s.user_id, 'unknown') = ${filters.user}`);
  if (filters.userRowId != null) {
    const ors: SQL[] = [sql`s.user_row_id = ${filters.userRowId}`];
    if (filters.userRowIdEmail) {
      ors.push(sql`COALESCE(s.user_email, s.user_account_id, s.user_id, 'unknown') = ${filters.userRowIdEmail}`);
    }
    clauses.push(sql`(${sql.join(ors, sql` OR `)})`);
  }
  if (filters.model) clauses.push(sql`p.model = ${filters.model}`);
  if (filters.session) clauses.push(sql`s.id = ${filters.session}`);
  if (filters.source) {
    clauses.push(sql`EXISTS(SELECT 1 FROM ${metricPoints} mp WHERE mp.session_row_id = s.id AND mp.source = ${filters.source})`);
  }
  const where = whereClause(and(...clauses));

  const rows = db.all(
    sql`SELECT
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
        (SELECT COALESCE(SUM(mp.value), 0) FROM ${metricPoints} mp
           WHERE mp.session_row_id = s.id AND mp.signal = 'otlp_metrics' AND mp.kind = 'tokens') AS otelTotalTokens,
        (SELECT COALESCE(SUM(mp.value), 0) FROM ${metricPoints} mp
           WHERE mp.session_row_id = s.id AND mp.signal = 'jsonl' AND mp.kind = 'tokens') AS jsonlTotalTokens,
        -- Per-signal cost too. OTel cost is Claude's reported figure; JSONL cost is the synthesized
        -- finius.cost.computed point (kind=cost, signal=jsonl). Independent of the authoritative join so
        -- the UI can show the delta when a session carries both.
        (SELECT COALESCE(SUM(mp.value), 0) FROM ${metricPoints} mp
           WHERE mp.session_row_id = s.id AND mp.signal = 'otlp_metrics' AND mp.kind = 'cost') AS otelTotalCost,
        (SELECT COALESCE(SUM(mp.value), 0) FROM ${metricPoints} mp
           WHERE mp.session_row_id = s.id AND mp.signal = 'jsonl' AND mp.kind = 'cost') AS jsonlTotalCost,
        -- The actual source for each signal on this session (e.g. 'copilot-chat' vs 'codex-cli-jsonl'),
        -- so the UI can tell which agent produced it. Independent of the authoritative join/filters.
        (SELECT mp.source FROM ${metricPoints} mp
           WHERE mp.session_row_id = s.id AND mp.signal = 'otlp_metrics' LIMIT 1) AS otelSource,
        (SELECT mp.source FROM ${metricPoints} mp
           WHERE mp.session_row_id = s.id AND mp.signal = 'jsonl' LIMIT 1) AS jsonlSource,
        ${dialect.groupConcatDistinct(sql`p.model`)} AS models,
        EXISTS(SELECT 1 FROM ${sourceFiles} sf WHERE sf.session_row_id = s.id) AS hasTranscript
      FROM ${sessions} s
      LEFT JOIN ${metricPoints} p ON ${joinCondition}
      ${where}
      GROUP BY s.id
      ${tail}`
  ) as Array<
      Omit<SessionSummary, "models" | "hasTranscript" | "source" | "hasOtel" | "hasJsonl" | "githubLogin" | "displayName"> & {
        userRowId: number | null;
        metricSource: "otel" | "jsonl";
        models: string | null;
        hasTranscript: number;
        hasOtel: number;
        hasJsonl: number;
        otelSource: string | null;
        jsonlSource: string | null;
      }
    >;

  // Resolve each session's friendly identity (GitHub login / display name) the same way People does,
  // keyed by the session's canonical identity string, so the sessions list can prefer it over email.
  const directory = await userDirectory(db);
  return rows.map(({ otelSource, jsonlSource, ...row }) => {
    const u = (row.userRowId ? getUserById(db, row.userRowId) : null) ?? directory.get(row.userEmail ?? row.userAccountId ?? row.userId ?? "unknown");
    return {
      ...row,
      source: row.metricSource === "otel" ? otelSource ?? OTEL_SOURCE : jsonlSource ?? "claude-code-jsonl",
      metricSource: row.metricSource,
      hasOtel: row.hasOtel === 1,
      hasJsonl: row.hasJsonl === 1,
      githubLogin: u?.githubLogin ?? null,
      displayName: u?.displayName ?? null,
      models: row.models?.split(",").filter(Boolean) ?? [],
      hasTranscript: row.hasTranscript === 1
    };
  });
}
