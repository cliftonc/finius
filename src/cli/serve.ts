import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FINIUS_HOME, loadConfig, resolvePostgresUrl, saveConfig } from "./config.js";
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

  const config = loadConfig();

  // Resolve the bind target. The public `serverUrl` only contributes a *default* — it never overrides
  // an explicit listen address — because behind a reverse proxy the public origin (https, no port) is
  // not what this Node process should bind to. Precedence:
  //   port: --port flag > config.listen.port > explicit port in serverUrl > startServer's 8787 default
  //   host: --host flag > FINIUS_HOST env > config.listen.host > host derived from serverUrl
  //         (loopback URL → 127.0.0.1, any other host → 0.0.0.0)
  // The human-facing banner still shows the public serverUrl, not the bind address.
  const target = config ? serveTargetFromServerUrl(config.serverUrl) : LOCAL_TARGET;
  if (port === undefined) port = config?.listen?.port ?? target.port;
  const hostname = host ?? process.env.FINIUS_HOST ?? config?.listen?.host ?? target.hostname;

  // Storage backend. A configured/overridden Postgres URL switches `serve` to Postgres; otherwise the
  // default local SQLite file under ~/.finius/data. The env vars are set BEFORE the dynamic import of
  // the server below so the schema barrel (schema-active.ts) and dialect.ts resolve the right backend at
  // module-load time.
  const postgresUrl = resolvePostgresUrl(config);
  if (postgresUrl) {
    process.env.FINIUS_DATABASE_URL = postgresUrl;
    process.env.FINIUS_DB_BACKEND = "postgres";
  }

  const dataDir = join(FINIUS_HOME, "data");
  mkdirSync(dataDir, { recursive: true });

  // Loaded only now (dynamic import) so the FINIUS_DB_BACKEND/FINIUS_DATABASE_URL env above is set
  // before the server's DB modules evaluate.
  const { startServer } = await import("../server/index.js");

  // Secure Mode: if `finius setup` saved a master password on this (owner) machine, run the server
  // locked. An explicit env var still wins (handy for one-off overrides).
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

  await startServer({
    port,
    hostname,
    // Show the configured URL in the banner (e.g. http://192.168.178.180:8787) rather than the bind
    // address (0.0.0.0), so the printed dashboard link is the one other machines can actually open.
    displayUrl: target.displayUrl,
    dbPath: process.env.FINIUS_DB_PATH ?? join(dataDir, "finius.sqlite"),
    database: postgresUrl ? { backend: "postgres", url: postgresUrl } : undefined,
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

// The bind target when there's no config yet: safe loopback default, no public banner URL.
const LOCAL_TARGET: ServeTarget = { port: undefined, hostname: "127.0.0.1", displayUrl: undefined };

// Derive a *default* bind port/host + the human-facing banner URL from the saved public serverUrl
// (e.g. http://192.168.178.180:8787 -> port 8787, bind 0.0.0.0, display http://192.168.178.180:8787).
// Only an explicit port in the URL contributes a bind port — scheme defaults like https:443 are
// proxy/public details, not what this Node process should listen on (so a portless URL yields
// `port: undefined`, leaving config.listen / the 8787 default to decide). A loopback URL keeps the
// safe 127.0.0.1 default; any other host means "reachable on the network", so we bind every interface
// (0.0.0.0) — robust whether the configured host is an IP or a DNS name that points back at this box.
export function serveTargetFromServerUrl(serverUrl: string): ServeTarget {
  try {
    const url = new URL(serverUrl);
    const port = url.port ? Number(url.port) : undefined;
    const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    return {
      port,
      hostname: loopback ? "127.0.0.1" : "0.0.0.0",
      displayUrl: loopback ? undefined : serverUrl.replace(/\/+$/, "")
    };
  } catch {
    return { port: undefined, hostname: "127.0.0.1", displayUrl: undefined };
  }
}
