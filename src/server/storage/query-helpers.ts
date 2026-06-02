import type { SQLInputValue } from "node:sqlite";
import type { Granularity, SummaryFilters } from "../types.js";

export const GRANULARITY_MS: Record<Granularity, number> = {
  minute: 60_000,
  five_minute: 300_000,
  quarter_hour: 900_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000
};

// Claude Code's OTel source. Other OTel-native agents (e.g. Copilot) carry their own source strings.
export const OTEL_SOURCE = "claude-code";

export function canUseRollup(filters: SummaryFilters, granularity?: Granularity) {
  if (filters.session != null) return false;
  if (filters.userRowId != null) return false;
  // An explicit non-OTel source filter is the comparison view: it must see ALL of that source's
  // (JSONL) points, including ones shadowed by OTel, which the effective rollup omits. Serve those
  // from metric_points instead, where an explicit source filter returns the raw per-source numbers.
  if (filters.source != null && filters.source !== OTEL_SOURCE) return false;
  if (granularity != null && GRANULARITY_MS[granularity] < GRANULARITY_MS.hour) return false;
  return hourAligned(filters.from) && hourAligned(filters.to);
}

export function rollupWhere(filters: SummaryFilters) {
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
  if (filters.userRowId != null) {
    clauses.push("1 = 0");
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

export const EFFECTIVE_ROLLUP = `(
        SELECT bucket, source, user_identity, model, kind, token_type, sum_value FROM metric_rollup
        UNION ALL
        SELECT
          CAST(timestamp / 3600000 AS INTEGER) * 3600000 AS bucket,
          source,
          COALESCE(user_email, user_account_id, user_id, 'unknown') AS user_identity,
          COALESCE(model, '') AS model,
          kind,
          COALESCE(token_type, '') AS token_type,
          value AS sum_value
        FROM metric_points
        WHERE signal = 'jsonl'
          AND session_row_id IN (SELECT id FROM sessions WHERE metric_source = 'jsonl')
      )`;

export function pointWhere(filters: SummaryFilters, opts: { dedupe?: boolean } = {}) {
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
  if (filters.userRowId != null) {
    const ors = ["session_row_id IN (SELECT id FROM sessions WHERE user_row_id = ?)"];
    params.push(filters.userRowId);
    if (filters.userRowIdEmail) {
      ors.push("session_row_id IN (SELECT id FROM sessions WHERE COALESCE(user_email, user_account_id, user_id, 'unknown') = ?)");
      params.push(filters.userRowIdEmail);
    }
    clauses.push(`(${ors.join(" OR ")})`);
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
  // An explicit source filter means "show that source raw" (for OTel-vs-JSONL comparison), so the
  // precedence predicate only applies to the default, cross-source view.
  if (opts.dedupe && !filters.source) clauses.push(jsonlWins());
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

// Per-session precedence, read from the session's stored authoritative source rather than recomputed.
// A point counts toward deduped totals when its signal IS its session's metric_source.
export function jsonlWins(alias = "") {
  return `(${alias}signal <> 'jsonl' OR ${alias}session_row_id IN (SELECT id FROM sessions WHERE metric_source = 'jsonl'))`;
}

function hourAligned(t?: number) {
  return t == null || t % GRANULARITY_MS.hour === 0;
}
