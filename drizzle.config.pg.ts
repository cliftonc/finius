import { defineConfig } from "drizzle-kit";

// Postgres migration generator config (the SQLite one is drizzle.config.ts). `drizzle-kit generate`
// diffs schema.pg.ts → SQL without connecting, so the url is only a placeholder for completeness; the
// generated migrations under ./src/server/db/migrations-pg are applied at startup by client.ts's
// runMigrations when the postgres backend is selected. Regenerate with `npm run db:generate:pg`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.pg.ts",
  out: "./src/server/db/migrations-pg",
  dbCredentials: { url: process.env.FINIUS_DATABASE_URL ?? "postgres://localhost:5432/finius" }
});
