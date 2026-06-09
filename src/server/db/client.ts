// Drizzle client seam. Opens the built-in node:sqlite DatabaseSync (no native dependency), applies
// the same PRAGMAs the adapter uses today, and wraps it with drizzle-orm's node-sqlite driver. Both
// the Drizzle handle and the raw DatabaseSync are returned (the adapter keeps the raw handle for
// close(); the schema-parity test uses it for PRAGMA introspection).

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

// Bring the schema up to date via the drizzle-kit migrations. The generated migrations under
// MIGRATIONS_DIR are the single source of truth: the migrator applies any not yet recorded in
// __drizzle_migrations and is a no-op once they all are. The DB is assumed re-creatable, so there is
// no legacy-adoption path — schema changes flow through `schema.ts` -> `drizzle-kit generate` only.
export function runMigrations(db: DrizzleDb): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
