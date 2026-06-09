// Cross-dialect schema parity. The SQLite schema (schema.ts) and the Postgres schema (schema.pg.ts)
// are maintained as two files because Drizzle's builders are dialect-bound. The schema-active.ts barrel
// casts the Postgres tables to the SQLite types, so the WHOLE db/ layer's correctness on Postgres rests
// on the two schemas having IDENTICAL structure — same tables, same column NAMES, same nullability, same
// PK/index/FK/unique shapes. This test guards that invariant: add a column to one schema and forget the
// other, and it fails. Column TYPES legitimately differ (integer↔bigint, real↔doublePrecision,
// autoincrement↔identity) and are intentionally NOT compared.

import { describe, expect, it } from "vitest";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import * as sqliteSchema from "../src/server/db/schema";
import * as pgSchema from "../src/server/db/schema.pg";

type Shape = {
  name: string;
  columns: Array<{ name: string; notNull: boolean; primary: boolean }>;
  primaryKeys: string[][];
  indexes: Array<{ name: string | undefined; columns: string[] }>;
  foreignKeys: Array<{ columns: string[]; foreignColumns: string[] }>;
  uniques: Array<{ name: string | undefined; columns: string[] }>;
};

const colName = (c: unknown): string => (c as { name?: string }).name ?? String(c);
const sortBy = <T>(arr: T[], key: (t: T) => string): T[] => [...arr].sort((a, b) => key(a).localeCompare(key(b)));

// Normalize a drizzle table config to a dialect-independent, comparable shape (names + structure only).
function normalize(cfg: ReturnType<typeof sqliteTableConfig> | ReturnType<typeof pgTableConfig>): Shape {
  return {
    name: cfg.name,
    columns: sortBy(
      cfg.columns.map((c) => ({ name: c.name, notNull: c.notNull, primary: c.primary })),
      (c) => c.name
    ),
    primaryKeys: sortBy(
      cfg.primaryKeys.map((pk) => pk.columns.map((c) => c.name).sort()),
      (cols) => cols.join(",")
    ),
    indexes: sortBy(
      cfg.indexes.map((i) => ({ name: i.config.name, columns: i.config.columns.map(colName).sort() })),
      (i) => i.name ?? i.columns.join(",")
    ),
    foreignKeys: sortBy(
      cfg.foreignKeys.map((f) => {
        const ref = f.reference();
        return { columns: ref.columns.map((c) => c.name).sort(), foreignColumns: ref.foreignColumns.map((c) => c.name).sort() };
      }),
      (f) => f.columns.join(",")
    ),
    uniques: sortBy(
      cfg.uniqueConstraints.map((u) => ({ name: u.name, columns: u.columns.map((c) => c.name).sort() })),
      (u) => u.name ?? u.columns.join(",")
    )
  };
}

// The 10 tables, paired by export name. Keep in sync with both schema modules.
const TABLES = ["rawBatches", "users", "sessions", "metricPoints", "metricRollup", "sourceFiles", "authTokens", "oauthAccounts", "logEvents", "modelPrices"] as const;

describe("schema cross-dialect parity (sqlite vs postgres)", () => {
  it("exports the same set of tables from both schema modules", () => {
    const sqliteExports = Object.keys(sqliteSchema).sort();
    const pgExports = Object.keys(pgSchema).sort();
    expect(pgExports).toEqual(sqliteExports);
    expect(sqliteExports).toEqual([...TABLES].sort());
  });

  for (const table of TABLES) {
    it(`${table}: identical table/column/PK/index/FK/unique structure`, () => {
      const sqlite = normalize(sqliteTableConfig(sqliteSchema[table]));
      const pg = normalize(pgTableConfig(pgSchema[table]));
      expect(pg).toEqual(sqlite);
    });
  }
});
