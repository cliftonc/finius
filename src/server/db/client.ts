// Drizzle client seam. Opens the built-in node:sqlite DatabaseSync (no native dependency), applies
// the same PRAGMAs the adapter uses today, and wraps it with drizzle-orm's node-sqlite driver. Both
// the Drizzle handle and the raw DatabaseSync are returned: runMigrations needs raw access for the
// legacy-DB baselining shim (ensureColumn ALTERs + rollup rebuild) that has to run BEFORE the migrator
// touches indexes on columns a legacy DB may lack.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import * as schema from "./schema.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: DrizzleDb;
  sqlite: DatabaseSync;
}

// Hooks let runMigrations reuse the adapter's existing data-backfill routines (rebuildRollup re-
// aggregates metric_rollup from the primary points; migrateUsers populates the users registry from
// sessions on first run) instead of duplicating that SQL here.
export interface MigrationHooks {
  rebuildRollup: () => void;
  migrateUsers: () => void;
}

// Resolve the migrations folder relative to this module so it works under `npx` regardless of cwd
// (mirrors index.ts's clientDist resolution): under tsx the source path src/server/db/migrations is
// used; from the built dist the emitted dist/server/db/migrations (populated by the build's copy
// step) is used. Falls back to a cwd-relative path for repo-root invocations.
const moduleDir = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR =
  [join(moduleDir, "migrations"), join(process.cwd(), "src/server/db/migrations"), join(process.cwd(), "dist/server/db/migrations")].find((dir) =>
    existsSync(dir)
  ) ?? join(moduleDir, "migrations");

// Open the DB, apply PRAGMAs, and wrap with Drizzle. Returns both handles.
export function connect(path: string): DbHandle {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  return { db, sqlite };
}

function tableExists(sqlite: DatabaseSync, name: string): boolean {
  return sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

// Add a column to a table if it isn't already present (idempotent ALTER for pre-existing DBs).
// Returns true iff the column was actually added (so callers can run a one-time backfill).
function ensureColumn(sqlite: DatabaseSync, table: string, column: string, decl: string): boolean {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return false;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

// Bring the schema up to date via the drizzle-kit migrations, adopting both fresh and legacy DBs.
//
// Fresh DB: no tables yet, so the baseline migration creates everything (incl. is_primary + all
// indexes) and records itself in __drizzle_migrations. This is the test path.
//
// Legacy populated DB (tables exist, no __drizzle_migrations): the baseline indexes columns a legacy
// DB may lack (is_primary, sessions.user_row_id, auth_tokens.user_row_id), so its CREATE INDEX
// statements would ERROR. We therefore add those columns FIRST (idempotent ALTERs), then run the
// migrator — whose baseline is fully IF NOT EXISTS, so the now-valid index creates succeed, the table
// creates no-op, and the baseline is recorded. When we just added is_primary, every existing row
// defaulted to 1; demote the registry's comparison-only sources to 0 and rebuild the rollup ONCE so
// old data matches the new model (primary JSONL enters the rollup; shadowed transcripts drop out of
// dashboard totals).
//
// Idempotency: a second construction on the now-migrated file is no longer "legacy" (__drizzle_
// migrations exists), so the shim is skipped and the migrator finds the baseline already applied and
// does nothing.
export function runMigrations(sqlite: DatabaseSync, db: DrizzleDb, hooks: MigrationHooks): void {
  const legacy = tableExists(sqlite, "metric_points") && !tableExists(sqlite, "__drizzle_migrations");

  if (legacy) {
    sqlite.exec("BEGIN");
    try {
      ensureColumn(sqlite, "sessions", "user_row_id", "INTEGER");
      ensureColumn(sqlite, "auth_tokens", "user_row_id", "INTEGER");
      const addedPrimary = ensureColumn(sqlite, "metric_points", "is_primary", "INTEGER NOT NULL DEFAULT 1");
      if (addedPrimary) {
        // Materialize the original jsonlWins precedence (fallback restored): a jsonl point counts iff
        // its session has no preferred (OTel) signal. Sessions whose metric_source='otel' have OTel, so
        // their jsonl (transcript) points are shadowed → is_primary=0; everything else stays at the
        // DEFAULT 1, so transcript-only Claude/Copilot sessions keep counting (fallback) and Codex/
        // manual jsonl (the preferred signal) stays primary. Then rebuild the rollup to match.
        sqlite.exec("UPDATE metric_points SET is_primary = 0 WHERE signal = 'jsonl' AND session_row_id IN (SELECT id FROM sessions WHERE metric_source = 'otel')");
        hooks.rebuildRollup();
      }
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  // Fresh: creates the full schema (incl. is_primary + all indexes). Legacy: the IF NOT EXISTS table
  // creates no-op, the now-valid index creates succeed, and the baseline is recorded.
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  // Post-migration data backfill (data, not schema): populate the users registry from sessions the
  // first time it's empty.
  hooks.migrateUsers();
}
