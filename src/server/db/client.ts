// Drizzle client seam. Two backends:
//   - sqlite (default): the built-in node:sqlite DatabaseSync (no native dependency), wrapped by
//     drizzle-orm's node-sqlite driver. Synchronous underneath.
//   - postgres (opt-in): node-postgres (`pg`, a pure-JS, lazily-imported optional peer dep) wrapped by
//     drizzle-orm's node-postgres driver. Fully async.
// A process uses exactly one (chosen by serve from config). The db/ layer is backend-neutral: it talks
// to the Drizzle handle via `.execute()` and the raw-SQL seam (raw.ts), and the SQL differences live in
// dialect.ts. The Postgres handle is cast to the canonical (sqlite) `DrizzleDb` type — the schema barrel
// (schema-active.ts) already presents the active tables under the sqlite types, so the whole layer stays
// typed against one shape while running on either driver.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import * as schema from "./schema.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

// What the adapter is told to open. A bare string path is shorthand for sqlite (tests, the default).
export type DbDescriptor = { backend: "sqlite"; path: string } | { backend: "postgres"; url: string };

// A live connection: the Drizzle handle plus backend-specific migrate/close, so the adapter stays
// backend-neutral.
export interface DbConnection {
  db: DrizzleDb;
  runMigrations: () => Promise<void>;
  close: () => Promise<void>;
}

// Resolve a migrations folder relative to this module so it works under `npx` regardless of cwd: under
// tsx the source path is used; from the built dist the emitted dist/.../<dir> (populated by the build's
// copy step) is used. Falls back to a cwd-relative path for repo-root invocations.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const resolveMigrationsDir = (name: string) =>
  [join(moduleDir, name), join(process.cwd(), `src/server/db/${name}`), join(process.cwd(), `dist/server/db/${name}`)].find((dir) => existsSync(dir)) ??
  join(moduleDir, name);

export const MIGRATIONS_DIR = resolveMigrationsDir("migrations");
export const MIGRATIONS_DIR_PG = resolveMigrationsDir("migrations-pg");

// sqlite connect (sync). Opens the DB, applies the PRAGMAs, wraps with Drizzle. Returns both the Drizzle
// handle and the raw DatabaseSync (the adapter closes via the DbConnection; the schema-parity test uses
// the raw handle for PRAGMA introspection).
export function connectSqlite(path: string): { db: DrizzleDb; sqlite: DatabaseSync } {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  return { db, sqlite };
}

// Apply the sqlite migrations (the generated baseline is the single source of truth; the migrator
// creates everything on a fresh DB and is a no-op once recorded in __drizzle_migrations).
export function runMigrationsSqlite(db: DrizzleDb): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

// Open the backend the descriptor names. Postgres deps are imported lazily so the default sqlite path
// (and `npx finius` install) never loads `pg`.
export async function connect(descriptor: DbDescriptor): Promise<DbConnection> {
  if (descriptor.backend === "postgres") return connectPostgres(descriptor.url);
  const { db, sqlite } = connectSqlite(descriptor.path);
  return {
    db,
    runMigrations: async () => runMigrationsSqlite(db),
    close: async () => sqlite.close()
  };
}

async function connectPostgres(url: string): Promise<DbConnection> {
  let Pool: typeof import("pg").Pool;
  let types: typeof import("pg").types;
  try {
    ({ Pool, types } = await import("pg"));
  } catch {
    throw new Error("Postgres backend selected but the 'pg' driver isn't installed. Install it: `npm i pg` (it's an optional peer dependency).");
  }
  // node-postgres returns int8 (bigint) AND COUNT(*) as STRINGS by default. Our bigint columns are
  // epoch-ms (well under 2^53) and counts are small, so parse OID 20 as a JS number — this keeps the
  // raw-SQL reads (buildSessions, getLogEventSummary) numeric, matching the sqlite path. (The typed
  // builders use drizzle's bigint mode:"number", which also yields numbers.)
  types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
  const { drizzle: drizzlePg } = await import("drizzle-orm/node-postgres");
  const { migrate: migratePg } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new Pool({ connectionString: url });
  // Cast the pg handle to the canonical sqlite DrizzleDb type — the runtime methods used by the db/
  // layer (insert/select/update/delete/.execute, plus raw db.execute via raw.ts) are present on both
  // drivers; the SQL dialect differences are handled in dialect.ts. The handle-level `schema` is only
  // needed for the relational `db.query.*` API, which finius doesn't use, so it's omitted.
  const db = drizzlePg({ client: pool }) as unknown as DrizzleDb;
  return {
    db,
    runMigrations: async () => {
      // The pg migrator wants its own handle type; the runtime object is correct.
      await migratePg(db as unknown as Parameters<typeof migratePg>[0], { migrationsFolder: MIGRATIONS_DIR_PG });
    },
    close: async () => {
      await pool.end();
    }
  };
}
