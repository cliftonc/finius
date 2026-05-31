import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { banner, panel, pc } from "../branding.js";
import { createApp } from "./app.js";
import { EventBus } from "./events.js";
import { normalizeLiteLlm } from "./pricing.js";
import { githubSnapshot } from "./pricing-backfill.js";
import { LocalBlobStore } from "./storage/blob.js";
import { SqliteStorageAdapter } from "./storage/sqlite.js";

// LiteLLM's community price feed: per-model input/output/cache token costs for Anthropic + OpenAI
// (and many more). Override with FINIUS_PRICING_URL; disable the fetch with FINIUS_PRICING_FETCH=off.
const DEFAULT_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export type StartServerOptions = {
  port?: number;
  hostname?: string;
  dbPath?: string;
  blobDir?: string;
  storeRawPayloads?: boolean;
  rawRetentionDays?: number;
  cronToken?: string;
  authSecret?: string;
  initialAuthToken?: string;
};

export type RunningServer = {
  storage: SqliteStorageAdapter;
  events: EventBus;
  clientDist?: string;
  hostname: string;
  port: number;
};

export function startServer(options: StartServerOptions = {}): RunningServer {
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const hostname = options.hostname ?? process.env.FINIUS_HOST ?? "127.0.0.1";
  const dbPath = options.dbPath ?? process.env.FINIUS_DB_PATH ?? "data/finius.sqlite";
  const storeRawPayloads = options.storeRawPayloads ?? (process.env.FINIUS_RAW_PAYLOADS ?? "retain") !== "off";
  const rawRetentionDaysRaw = options.rawRetentionDays ?? Number(process.env.FINIUS_RAW_RETENTION_DAYS ?? 7);
  const rawRetentionDays = Number.isFinite(rawRetentionDaysRaw) ? rawRetentionDaysRaw : 7;
  const blobDir = options.blobDir ?? process.env.FINIUS_BLOB_DIR;
  const blob = blobDir ? new LocalBlobStore(resolve(blobDir)) : undefined;
  const cronToken = options.cronToken ?? process.env.FINIUS_CRON_TOKEN;
  const authSecret = options.authSecret ?? process.env.FINIUS_AUTH_PASSWORD;
  const initialAuthToken = options.initialAuthToken;

  const storage = new SqliteStorageAdapter(resolve(dbPath), { storeRawPayloads, blob });
  if (authSecret && initialAuthToken) seedInitialAuthToken(storage, initialAuthToken);
  const events = new EventBus();
  const app = createApp({ storage, events, cronToken, rawRetentionDays, authSecret });

  // Resolve the built client relative to this module so the UI is served no matter the cwd
  // (e.g. when launched via `npx @cliftonc/finius serve`). Falls back to a cwd-relative path for
  // repo-root invocations like `npm start`.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const clientDist = [join(moduleDir, "..", "client"), resolve("dist/client")].find((dir) => existsSync(dir));

  if (clientDist) {
    app.use("/*", serveStatic({ root: clientDist }));
    app.get("*", serveStatic({ path: join(clientDist, "index.html") }));
  }

  // Effective transcript location: the explicit blob dir, else the adapter's default of
  // <db-dir>/transcripts. Computed here only so we can report it on startup.
  const resolvedDb = resolve(dbPath);
  const transcriptsDir = blobDir ? resolve(blobDir) : join(dirname(resolvedDb), "transcripts");

  serve({ fetch: app.fetch, hostname, port }, (info) => {
    const url = `http://${hostname}:${info.port}`;
    banner("serve");
    process.stdout.write(`\n  ${pc.green("●")} ${pc.bold("Finius is live")}  ${pc.dim("·")}  ${pc.cyan(url)}\n\n`);
    process.stdout.write(
      `${panel([
        ["Dashboard", clientDist ? pc.cyan(url) : pc.yellow("not built — run `npm run build` to serve the UI")],
        ["API", `${url}/api`],
        ["Database", pc.dim(resolvedDb)],
        ["Transcripts", pc.dim(transcriptsDir)],
        ["Raw payloads", storeRawPayloads ? `retained, pruned after ${rawRetentionDays}d` : pc.dim("off")],
        ["Auth", authSecret ? `${pc.green("secure mode")} ${pc.dim("· log in with password:")} ${pc.bold(authSecret)}` : pc.dim("open (no auth)")]
      ])}\n\n`
    );
  });

  // Wire historical pricing backfill: when a JSONL import lands on a day we have no price for, the
  // processing queue fetches that day's rates from LiteLLM's git history. Disabled with
  // FINIUS_PRICING_FETCH=off (keeps the server fully offline).
  if ((process.env.FINIUS_PRICING_FETCH ?? "on") !== "off") {
    storage.setHistoricalPriceFetcher(githubSnapshot);
  }

  // Refresh model pricing in the background so we can compute cost for agents that don't report it
  // (Codex, JSONL Claude). Non-blocking and offline-safe: on failure we keep whatever rows are
  // already cached in model_prices and still recompute from them.
  void syncPricing(storage);

  const shutdown = async () => {
    const timeout = new Promise<void>((resolve) => windowlessSetTimeout(resolve, 5_000));
    await Promise.race([storage.settleIngest(), timeout]);
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { storage, events, clientDist, hostname, port };
}

function windowlessSetTimeout(callback: () => void, delay: number) {
  return globalThis.setTimeout(callback, delay);
}

async function syncPricing(storage: SqliteStorageAdapter) {
  if ((process.env.FINIUS_PRICING_FETCH ?? "on") === "off") return;
  const url = process.env.FINIUS_PRICING_URL ?? DEFAULT_PRICING_URL;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const prices = normalizeLiteLlm(await res.json(), Date.now());
    if (prices.length === 0) throw new Error("no usable prices in feed");
    await storage.importPricing(prices);
    const { costPoints } = await storage.recomputeComputedCost();
    console.log(panel([["Pricing", `${prices.length} models synced ${pc.dim(`(recomputed ${costPoints} cost points)`)}`]]));
  } catch (err) {
    console.warn(`  ${pc.yellow("▲")} pricing sync failed ${pc.dim(`(${(err as Error).message})`)} — using cached pricing`);
    // Re-apply whatever pricing is already cached so a restart still reflects locally-imported rows.
    try {
      await storage.recomputeComputedCost();
    } catch {
      /* ignore */
    }
  }
}

function seedInitialAuthToken(storage: SqliteStorageAdapter, token: string) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  if (storage.findAuthToken(tokenHash)) return;
  storage.createAuthToken(tokenHash, "owner", Date.now());
}

// Auto-start when executed directly (`node dist/server/index.js`), but not when this module is
// imported by the CLI's `serve` command.
const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) startServer();
