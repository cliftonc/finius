import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { connectSqlite, runMigrationsSqlite } from "../src/server/db/client.js";

// Durable schema guard. The adapter now builds its schema solely via the Drizzle migrator (schema.ts
// → generated baseline migration), so there is no second migrate() path to diff against. Instead we
// freeze the expected normalized schema STRUCTURE as a committed fixture
// (tests/fixtures/schema-snapshot.json) and assert a freshly-migrated DB still matches it.
//
// The snapshot is the same syntax-independent description the previous parity test computed: read
// purely from SQLite's structural introspection (PRAGMA table_info / index_list / index_info /
// foreign_key_list, plus the WITHOUT ROWID flag), not from raw CREATE TABLE text. Any change to
// schema.ts or the migration that alters the physical schema (a column, type, default, index, FK, PK,
// or WITHOUT ROWID) changes this structure and FAILS the test — regenerate the fixture deliberately
// (see scripts in the PR notes) only when the schema change is intentional.

const dir = mkdtempSync(join(tmpdir(), "finius-parity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type ColInfo = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
type IndexListRow = { name: string; unique: number; origin: string; partial: number };
type IndexInfoRow = { seqno: number; name: string | null };
type FkRow = { table: string; from: string; to: string; on_update: string; on_delete: string };

// A canonical, syntax-independent description of one table, derived purely from PRAGMAs.
function describeTable(sqlite: DatabaseSync, table: string) {
  const cols = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[]).map((c) => ({
    name: c.name,
    type: c.type.toUpperCase(),
    notnull: c.notnull,
    // Normalize default representation ('jsonl' vs jsonl, 0 vs '0') to a trimmed string.
    dflt: c.dflt_value === null ? null : String(c.dflt_value).replace(/^'(.*)'$/, "$1"),
    pk: c.pk
  }));

  // sqlite_autoindex_* names are auto-assigned (UNIQUE constraints) — compare by structure, not name.
  const indexes = (sqlite.prepare(`PRAGMA index_list(${table})`).all() as IndexListRow[])
    .map((idx) => {
      const columns = (sqlite.prepare(`PRAGMA index_info(${idx.name})`).all() as IndexInfoRow[])
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name);
      const autogen = idx.name.startsWith("sqlite_autoindex_");
      return {
        // Keep explicit index names (idx_*); ignore auto-generated UNIQUE-constraint index names.
        name: autogen ? null : idx.name,
        unique: idx.unique,
        origin: idx.origin, // 'c' explicit CREATE INDEX, 'u' UNIQUE constraint, 'pk' primary key
        columns
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const fks = (sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as FkRow[])
    .map((fk) => ({ table: fk.table, from: fk.from, to: fk.to, onUpdate: fk.on_update, onDelete: fk.on_delete }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const withoutRowid = (sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string } | undefined)?.sql
    ?.toUpperCase()
    .includes("WITHOUT ROWID") ?? false;

  return { cols, indexes, fks, withoutRowid };
}

function describeSchema(sqlite: DatabaseSync) {
  const tables = (
    sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const byTable: Record<string, ReturnType<typeof describeTable>> = {};
  for (const t of tables) byTable[t] = describeTable(sqlite, t);
  return { tables, byTable };
}

const SNAPSHOT_PATH = fileURLToPath(new URL("./fixtures/schema-snapshot.json", import.meta.url));

describe("schema guard: Drizzle migration matches the committed schema snapshot", () => {
  it("produces the frozen normalized schema structure", () => {
    // Build a fresh DB through the same migrator the adapter uses.
    const path = join(dir, "fresh.sqlite");
    const { db, sqlite } = connectSqlite(path);
    runMigrationsSqlite(db);

    const actual = describeSchema(sqlite);
    const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as ReturnType<typeof describeSchema>;

    // Same set of tables.
    expect(actual.tables).toEqual(expected.tables);

    // Same columns/types/notnull/default/pk, same indexes (incl. WITHOUT ROWID), same FKs, per table.
    for (const table of expected.tables) {
      expect(actual.byTable[table], `table ${table} differs from snapshot`).toEqual(expected.byTable[table]);
    }

    sqlite.close();
  });
});
