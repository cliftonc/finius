// Postgres seam. These are the ONLY three SQL constructs in the read queries that differ between
// SQLite and Postgres; everything else is portable ANSI SQL composed via Drizzle `sql` fragments.
// A future Postgres dialect swaps ONLY this file (e.g. `string_agg(DISTINCT x, ',')` for
// groupConcatDistinct, `(col->>'path')` for jsonExtract, `floor(ts/ms)*ms` for bucket). The schema's
// own dialect concerns (AUTOINCREMENT, WITHOUT ROWID, boolean type) are handled separately.

import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

export interface SqlDialect {
  // GROUP_CONCAT(DISTINCT <col>) — comma-joined distinct values. (Postgres: string_agg(DISTINCT col, ',')).
  groupConcatDistinct(col: SQLWrapper): SQL;
  // json_extract(<col>, '<path>') — keeps the EXACT path strings used today (e.g. the quoted
  // '$."copilot_chat.chat_session_id"'). (Postgres: <col>->>'<json key>').
  jsonExtract(col: SQLWrapper, path: string): SQL;
  // CAST(<tsExpr> / <ms> AS INTEGER) * <ms> — floor to the bucket grain. (Postgres: floor(...)*ms).
  bucket(tsExpr: SQLWrapper, ms: number): SQL;
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
  }
};

// The active dialect. Today: SQLite. A Postgres build points this at a PG_DIALECT.
export const dialect: SqlDialect = SQLITE_DIALECT;
