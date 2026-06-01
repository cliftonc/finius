import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FINIUS_HOME, loadConfig, saveConfig } from "./config.js";
import { startServer } from "../server/index.js";
import { generateAuthToken } from "./password.js";

// `finius serve [--port N]` — start the single-process server (API + built dashboard). Data is kept
// under ~/.finius by default so an `npx`/globally-installed CLI has a stable home, independent of cwd.
export async function runServe(argv: string[]): Promise<number> {
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--port" || arg === "-p") && argv[i + 1]) port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else if (arg === "--host" && argv[i + 1]) host = argv[++i];
    else if (arg.startsWith("--host=")) host = arg.slice("--host=".length);
  }
  if (port !== undefined && !Number.isInteger(port)) {
    process.stderr.write("finius serve: --port must be an integer\n");
    return 1;
  }

  // Derive the listen target from the configured server URL (set in `finius setup`) so the dashboard
  // the CLI points users at is the one we actually serve — port AND bind host. A loopback URL stays on
  // loopback; a real host/IP means "reachable on the network", so we bind all interfaces (0.0.0.0).
  // Explicit flags/env win: --port, --host, FINIUS_HOST.
  const target = serveTargetFromConfig();
  if (port === undefined) port = target.port;
  const hostname = host ?? process.env.FINIUS_HOST ?? target.hostname;

  const dataDir = join(FINIUS_HOME, "data");
  mkdirSync(dataDir, { recursive: true });

  // Secure Mode: if `finius setup` saved a master password on this (owner) machine, run the server
  // locked. An explicit env var still wins (handy for one-off overrides).
  const config = loadConfig();
  const authSecret = process.env.FINIUS_AUTH_PASSWORD ?? config?.authPassword;
  const github = config?.auth?.oauth?.github;
  const githubEnabled = !!(github?.enabled && github.clientId && github.clientSecret && github.requiredOrg);
  // The server is secured by EITHER a master password or GitHub OAuth. In both cases this (owner)
  // machine needs a seeded token for its own CLI uploads — in GitHub-only mode there's no password to
  // exchange for one, so mint it here. A machine that merely joined a server keeps its existing token.
  const secure = !!authSecret || githubEnabled;
  let initialAuthToken = config?.authToken;
  if (secure && !initialAuthToken) {
    initialAuthToken = generateAuthToken();
    if (config) saveConfig({ ...config, authToken: initialAuthToken });
  }

  startServer({
    port,
    hostname,
    // Show the configured URL in the banner (e.g. http://192.168.178.180:8787) rather than the bind
    // address (0.0.0.0), so the printed dashboard link is the one other machines can actually open.
    displayUrl: target.displayUrl,
    dbPath: process.env.FINIUS_DB_PATH ?? join(dataDir, "finius.sqlite"),
    blobDir: process.env.FINIUS_BLOB_DIR ?? join(FINIUS_HOME, "transcripts"),
    authSecret,
    initialAuthToken,
    oauth: {
      github: config?.auth?.oauth?.github?.enabled
        ? {
            ...config.auth.oauth.github,
            callbackUrl: `${config.serverUrl}/api/auth/github/callback`
          }
        : undefined
    }
  });

  // The server runs until the process is signalled. Never resolve, so the CLI entrypoint doesn't
  // `process.exit()` out from under the listening server. startServer() installs SIGINT/SIGTERM
  // handlers that close the DB and exit cleanly.
  await new Promise<never>(() => {});
  return 0; // unreachable
}

type ServeTarget = { port: number | undefined; hostname: string; displayUrl: string | undefined };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Derive port + bind host + a human-facing URL from the saved serverUrl (e.g.
// http://192.168.178.180:8787 → port 8787, bind 0.0.0.0, display http://192.168.178.180:8787).
// A loopback URL keeps the safe 127.0.0.1 default; any other host means the server is meant to be
// reachable on the network, so we bind every interface (0.0.0.0) — robust whether the configured host
// is an IP or a DNS name that points back at this box.
function serveTargetFromConfig(): ServeTarget {
  const config = loadConfig();
  if (!config) return { port: undefined, hostname: "127.0.0.1", displayUrl: undefined };
  try {
    const url = new URL(config.serverUrl);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    return {
      port,
      hostname: loopback ? "127.0.0.1" : "0.0.0.0",
      displayUrl: loopback ? undefined : config.serverUrl.replace(/\/+$/, "")
    };
  } catch {
    return { port: undefined, hostname: "127.0.0.1", displayUrl: undefined };
  }
}
