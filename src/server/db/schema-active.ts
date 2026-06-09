// Active-schema barrel. Drizzle's query builders are dialect-bound: the SQLite tables (schema.ts,
// `sqliteTable`) and the Postgres tables (schema.pg.ts, `pgTable`) are different object types. A finius
// process uses exactly ONE backend (serve picks it from config), so the choice is resolved ONCE here at
// module load and every db/*.ts file imports its tables from this barrel instead of a concrete schema.
//
// The selection reads FINIUS_DB_BACKEND, which the entry point (serve/CLI) sets BEFORE the server
// modules load. Default = sqlite (the local-first default; also what tests use).
//
// Each table is cast to its SQLite type so the downstream db/*.ts files stay fully typed against ONE
// schema's column types while the runtime object is the active backend's. Soundness rests on the two
// schemas having IDENTICAL column names — guarded by tests/schema-cross-parity.test.ts. (At runtime a
// Postgres handle drives Postgres tables; the static "sqlite" types are a compile-time convenience.)

import * as sqliteSchema from "./schema.js";
import * as pgSchema from "./schema.pg.js";

export type ActiveBackend = "sqlite" | "postgres";

// Postgres is active when explicitly selected (FINIUS_DB_BACKEND=postgres) OR a connection URL is
// present (FINIUS_DATABASE_URL) — so both the `serve` path (which sets these before the dynamic import
// of the server) and a direct `FINIUS_DATABASE_URL=… node dist/server/index.js` run agree with the
// connection the adapter opens. Default sqlite.
export function activeBackend(): ActiveBackend {
  if (process.env.FINIUS_DB_BACKEND === "postgres") return "postgres";
  if ((process.env.FINIUS_DATABASE_URL ?? "").trim() !== "") return "postgres";
  return "sqlite";
}

const s = activeBackend() === "postgres" ? pgSchema : sqliteSchema;

// One cast per table (via unknown — the two dialect table types don't structurally overlap).
type SqliteSchema = typeof sqliteSchema;
const pick = <K extends keyof SqliteSchema>(key: K): SqliteSchema[K] => s[key] as unknown as SqliteSchema[K];

export const rawBatches = pick("rawBatches");
export const users = pick("users");
export const sessions = pick("sessions");
export const metricPoints = pick("metricPoints");
export const metricRollup = pick("metricRollup");
export const sourceFiles = pick("sourceFiles");
export const authTokens = pick("authTokens");
export const oauthAccounts = pick("oauthAccounts");
export const logEvents = pick("logEvents");
export const modelPrices = pick("modelPrices");
