// Raw-SQL execution + result-shape seam between the two backends. The typed Drizzle builders share a
// uniform async `.execute()` across sqlite-core and pg-core, but a few hand-written `sql`…`` queries
// (correlated subqueries, INSERT…SELECT) and the affected-row counts differ between drivers:
// node:sqlite exposes db.all/get/run(sql) (sync) and StatementResultingChanges.changes, while
// node-postgres exposes db.execute(sql) (async) and QueryResult.rows/.rowCount. These helpers
// feature-detect the handle at runtime so the SAME db/ code runs on both. node:sqlite is synchronous
// underneath, so its branch resolves immediately; callers just `await`.

import { type SQLWrapper } from "drizzle-orm";
import { type DrizzleDb } from "./client.js";

type AnyDb = {
  all?: (q: SQLWrapper) => unknown;
  get?: (q: SQLWrapper) => unknown;
  run?: (q: SQLWrapper) => unknown;
  execute?: (q: SQLWrapper) => Promise<unknown>;
};

// Run a raw query and return all rows. sqlite-core: db.all(sql) (sync). pg-core: db.execute(sql) → { rows }.
export async function rawAll<T = Record<string, unknown>>(db: DrizzleDb, query: SQLWrapper): Promise<T[]> {
  const d = db as unknown as AnyDb;
  if (typeof d.all === "function") return d.all(query) as T[];
  const res = (await d.execute!(query)) as { rows?: T[] } | T[];
  return (Array.isArray(res) ? res : res.rows ?? []) as T[];
}

// Run a raw query and return the first row (or undefined).
export async function rawGet<T = Record<string, unknown>>(db: DrizzleDb, query: SQLWrapper): Promise<T | undefined> {
  const d = db as unknown as AnyDb;
  if (typeof d.get === "function") return (d.get(query) as T | undefined) ?? undefined;
  return (await rawAll<T>(db, query))[0];
}

// Run a raw statement for its side effect only.
export async function rawRun(db: DrizzleDb, query: SQLWrapper): Promise<void> {
  const d = db as unknown as AnyDb;
  if (typeof d.run === "function") {
    d.run(query);
    return;
  }
  await d.execute!(query);
}

// Affected-row count from a builder `.execute()` result, across StatementResultingChanges (sqlite,
// `.changes`) and QueryResult (postgres, `.rowCount`).
export function affectedRows(result: unknown): number {
  const r = result as { changes?: number | bigint; rowCount?: number | null } | null;
  return Number(r?.changes ?? r?.rowCount ?? 0);
}

// UNIQUE / primary-key violation detection across drivers: Postgres SQLSTATE 23505, else node:sqlite's
// constraint message. Drizzle wraps the driver error (DrizzleQueryError) and puts the original — which
// carries pg's `.code` — on `.cause`, so walk the cause chain. Used by the dedup-insert short-circuits
// (raw_batches.hash, source_files.hash).
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e != null && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: string }).code === "23505") return true;
    if (e instanceof Error && e.message.includes("UNIQUE")) return true;
  }
  return false;
}
