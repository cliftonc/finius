import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FINIUS_HOME, loadConfig, saveConfig } from "./config.js";
import { startServer } from "../server/index.js";
import { generateAuthToken } from "./password.js";

// `finius serve [--port N]` — start the single-process server (API + built dashboard). Data is kept
// under ~/.finius by default so an `npx`/globally-installed CLI has a stable home, independent of cwd.
export async function runServe(argv: string[]): Promise<number> {
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--port" || arg === "-p") && argv[i + 1]) port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
  }
  if (port !== undefined && !Number.isInteger(port)) {
    process.stderr.write("finius serve: --port must be an integer\n");
    return 1;
  }

  // Without an explicit --port, bind to the port from the configured server URL (set in `finius
  // setup`) so the dashboard the CLI points users at is the one we actually serve.
  if (port === undefined) port = portFromConfig();

  const dataDir = join(FINIUS_HOME, "data");
  mkdirSync(dataDir, { recursive: true });

  // Secure Mode: if `finius setup` saved a master password on this (owner) machine, run the server
  // locked. An explicit env var still wins (handy for one-off overrides).
  const config = loadConfig();
  const authSecret = process.env.FINIUS_AUTH_PASSWORD ?? config?.authPassword;
  let initialAuthToken = config?.authToken;
  if (authSecret && config?.authPassword && !initialAuthToken) {
    initialAuthToken = generateAuthToken();
    saveConfig({ ...config, authToken: initialAuthToken });
  }

  startServer({
    port,
    dbPath: process.env.FINIUS_DB_PATH ?? join(dataDir, "finius.sqlite"),
    blobDir: process.env.FINIUS_BLOB_DIR ?? join(FINIUS_HOME, "transcripts"),
    authSecret,
    initialAuthToken
  });

  // The server runs until the process is signalled. Never resolve, so the CLI entrypoint doesn't
  // `process.exit()` out from under the listening server. startServer() installs SIGINT/SIGTERM
  // handlers that close the DB and exit cleanly.
  await new Promise<never>(() => {});
  return 0; // unreachable
}

// Derive the listen port from the saved serverUrl (e.g. http://localhost:8787 → 8787).
function portFromConfig(): number | undefined {
  const config = loadConfig();
  if (!config) return undefined;
  try {
    const url = new URL(config.serverUrl);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}
