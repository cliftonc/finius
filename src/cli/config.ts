import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Everything the CLI owns lives under ~/.finius (override with FINIUS_HOME).
export const FINIUS_HOME = process.env.FINIUS_HOME ? resolve(process.env.FINIUS_HOME) : join(homedir(), ".finius");
export const CONFIG_PATH = join(FINIUS_HOME, "config.json");
export const DEFAULT_SERVER_URL = "http://localhost:8787";

// A user identity to attribute uploaded transcripts to, mirroring the OTEL fields Claude Code emits
// (user.email / user.account_uuid / user.id). Captured once at `finius setup` so JSONL/rollout
// imports land under the same user as that session's live metrics.
export type StoredIdentity = {
  email?: string;
  accountId?: string;
  userId?: string;
};

export type FiniusConfig = {
  // The public, client-facing base URL — what OTEL exporters, the upload hook, OAuth callbacks, the
  // dashboard banner, and `doctor` reachability checks all point at. Behind a TLS-terminating reverse
  // proxy this is the external URL (e.g. https://finius.cliftonc.nl), which is NOT the address the
  // Node process binds to — that's `listen`.
  serverUrl: string;
  // Optional explicit bind target for `finius serve`, decoupled from the public `serverUrl`. Needed
  // when the public URL is a proxied origin (https, no port) but the process must listen on a plain
  // local port. Omitted for the localhost/LAN case, where the bind is derived from `serverUrl`.
  listen?: {
    host?: string;
    port?: number;
  };
  // The master password — only present on the machine that set up (owns) a Secure Mode server. It's
  // accepted directly as a credential, so the owner needs no minted token.
  authPassword?: string;
  // A minted client session token (from POST /api/auth/login). Present on machines that joined an
  // existing Secure Mode server. This machine's credential for OTEL/hook/dashboard.
  authToken?: string;
  // Per-agent identity confirmed at setup. The hook/backfill sends the matching slot so transcript
  // imports carry a user. Codex is stored as-is (its real ChatGPT account, +alias and all). The
  // GitHub login/display name are shared across tools (one `gh` login per machine).
  identity?: {
    claude?: StoredIdentity;
    codex?: StoredIdentity;
    githubLogin?: string;
    displayName?: string;
  };
  auth?: {
    oauth?: {
      github?: {
        enabled?: boolean;
        clientId?: string;
        clientSecret?: string;
        requiredOrg?: string;
      };
    };
  };
};

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): FiniusConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<FiniusConfig>;
    return {
      ...raw,
      serverUrl: normalizeUrl(raw.serverUrl) || DEFAULT_SERVER_URL
    };
  } catch {
    return null;
  }
}

// This machine's credential for Secure Mode. Only minted session tokens are valid on protected
// endpoints; the master password is accepted solely by /api/auth/login.
export function resolveAuthToken(config: FiniusConfig | null): string | undefined {
  return config?.authToken ?? undefined;
}

export function saveConfig(config: FiniusConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// Resolution order: explicit env override → saved config → built-in default.
export function resolveServerUrl(): string {
  return normalizeUrl(process.env.FINIUS_SERVER_URL) || loadConfig()?.serverUrl || DEFAULT_SERVER_URL;
}

// Trim whitespace and any trailing slashes so we can safely append paths.
export function normalizeUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}
