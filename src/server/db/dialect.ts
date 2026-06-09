// Postgres seam. These are the ONLY three SQL constructs in the read queries that differ between
// SQLite and Postgres; everything else is portable ANSI SQL composed via Drizzle `sql` fragments.
// A future Postgres dialect swaps ONLY this file (e.g. `string_agg(DISTINCT x, ',')` for
// groupConcatDistinct, `(col->>'path')` for jsonExtract, `floor(ts/ms)*ms` for bucket). The schema's
// own dialect concerns (AUTOINCREMENT, WITHOUT ROWID, boolean type) are handled separately.

import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { activeBackend } from "./schema-active.js";

export interface SqlDialect {
  // GROUP_CONCAT(DISTINCT <col>) — comma-joined distinct values. (Postgres: string_agg(DISTINCT col, ',')).
  groupConcatDistinct(col: SQLWrapper): SQL;
  // json_extract(<col>, '<path>') — keeps the EXACT path strings used today (e.g. the quoted
  // '$."copilot_chat.chat_session_id"'). (Postgres: <col>->>'<json key>').
  jsonExtract(col: SQLWrapper, path: string): SQL;
  // CAST(<tsExpr> / <ms> AS INTEGER) * <ms> — floor to the bucket grain. (Postgres: floor(...)*ms).
  bucket(tsExpr: SQLWrapper, ms: number): SQL;
  // The smaller/larger of two scalar values. SQLite spells these `min(a,b)`/`max(a,b)` (2-arg scalar
  // functions); Postgres `min/max` are AGGREGATES, so it must use `LEAST(a,b)`/`GREATEST(a,b)`. Used in
  // the sticky first/last-seen window of the user/session upserts.
  least(a: SQLWrapper, b: SQLWrapper): SQL;
  greatest(a: SQLWrapper, b: SQLWrapper): SQL;
}

export const SQLITE_DIALECT: SqlDialect = {
  groupConcatDistinct(col) {
    return sql`GROUP_CONCAT(DISTINCT ${col})`;
  },
  jsonExtract(col, path) {
    // The path is a literal SQL fragment (a string constant), not a bound param, to match the
    // verbatim json_extract(col, '$.…') text the original raw SQL emitted.
    return sql`json_extract(${col}, ${sql.raw(`'${path}'`)})`;
  },
  bucket(tsExpr, ms) {
    return sql`CAST(${tsExpr} / ${sql.raw(String(ms))} AS INTEGER) * ${sql.raw(String(ms))}`;
  },
  least(a, b) {
    return sql`min(${a}, ${b})`;
  },
  greatest(a, b) {
    return sql`max(${a}, ${b})`;
  }
};

// SQLite stores attributes as a JSON string; its json_extract path is `$."<key>"`. Postgres extracts a
// text value from a jsonb cast of that same text column: `(<col>::jsonb ->> '<key>')`. The keys finius
// uses contain dots (e.g. "copilot_chat.chat_session_id") but are a SINGLE jsonb key, not a nested path,
// so we lift the bracketed key out of the SQLite `$."<key>"` form and bind it.
function jsonPathKey(path: string): string {
  const match = /^\$\."(.+)"$/.exec(path);
  return match ? match[1] : path.replace(/^\$\.?/, "");
}

export const PG_DIALECT: SqlDialect = {
  groupConcatDistinct(col) {
    return sql`string_agg(DISTINCT ${col}::text, ',')`;
  },
  jsonExtract(col, path) {
    return sql`(${col}::jsonb ->> ${jsonPathKey(path)})`;
  },
  bucket(tsExpr, ms) {
    // floor to the grain on a numeric division, back to bigint to match the epoch-ms columns.
    return sql`(floor(${tsExpr}::numeric / ${sql.raw(String(ms))}) * ${sql.raw(String(ms))})::bigint`;
  },
  least(a, b) {
    return sql`LEAST(${a}, ${b})`;
  },
  greatest(a, b) {
    return sql`GREATEST(${a}, ${b})`;
  }
};

// The active dialect, resolved from the backend the process selected (FINIUS_DB_BACKEND, via the schema
// barrel). Default SQLite.
export const dialect: SqlDialect = activeBackend() === "postgres" ? PG_DIALECT : SQLITE_DIALECT;
