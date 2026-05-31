import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app.js";
import { EventBus } from "./events.js";
import { LocalBlobStore } from "./storage/blob.js";
import { SqliteStorageAdapter } from "./storage/sqlite.js";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.FINIUS_DB_PATH ?? "data/finius.sqlite";
const storeRawPayloads = (process.env.FINIUS_RAW_PAYLOADS ?? "retain") !== "off";
const rawRetentionDays = Number(process.env.FINIUS_RAW_RETENTION_DAYS ?? 7);
const blob = process.env.FINIUS_BLOB_DIR ? new LocalBlobStore(resolve(process.env.FINIUS_BLOB_DIR)) : undefined;
const storage = new SqliteStorageAdapter(resolve(dbPath), { storeRawPayloads, blob });
const events = new EventBus();
const app = createApp({
  storage,
  events,
  cronToken: process.env.FINIUS_CRON_TOKEN,
  rawRetentionDays: Number.isFinite(rawRetentionDays) ? rawRetentionDays : 7
});
const clientDist = resolve("dist/client");

if (existsSync(clientDist)) {
  app.use("/*", serveStatic({ root: clientDist }));
  app.get("*", serveStatic({ path: join(clientDist, "index.html") }));
}

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`Finius API listening on http://127.0.0.1:${info.port}`);
});

process.on("SIGINT", () => {
  storage.close();
  process.exit(0);
});
