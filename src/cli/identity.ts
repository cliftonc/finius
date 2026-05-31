import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FiniusConfig, StoredIdentity } from "./config.js";

// A resolved end-user identity attached to an uploaded transcript so JSONL/rollout sessions carry the
// same user as live OTEL metrics (which embed user.email / user.account_uuid / user.id). The transcript
// bodies themselves contain no identity, but the machine running the hook knows who the user is.
export type Identity = {
  email?: string;
  accountId?: string;
  userId?: string;
  githubLogin?: string;
  displayName?: string;
  source: "config" | "claude" | "codex" | "git" | "github";
};

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
const CODEX_HOME = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");

// --- Pure parsers (no I/O — unit-tested) ----------------------------------------------------------

// Claude Code records the signed-in account in ~/.claude.json under `oauthAccount`. This is the same
// account live OTEL tags as user.email / user.account_uuid / user.id, so preferring it keeps a
// hook-imported transcript under the same identity as that session's metrics.
export function parseClaudeAccount(raw: string): Identity | null {
  const json = safeParseObject(raw);
  if (!json) return null;
  const acct = asObject(json.oauthAccount);
  const email = asString(acct?.emailAddress);
  const accountId = asString(acct?.accountUuid);
  const userId = asString(json.userID);
  const displayName = asString(acct?.displayName);
  if (!email && !accountId && !userId) return null;
  return { email, accountId, userId, displayName, source: "claude" };
}

// Codex stores its ChatGPT login in ~/.codex/auth.json: `tokens.account_id` plus a JWT `id_token`
// whose payload carries the account email. We decode the JWT payload locally (NO signature
// verification — we only read the `email` claim for attribution, never trust it for auth).
export function parseCodexAuth(raw: string): Identity | null {
  const json = safeParseObject(raw);
  if (!json) return null;
  const tokens = asObject(json.tokens);
  const accountId = asString(tokens?.account_id);
  const claims = asString(tokens?.id_token) ? decodeJwtPayload(asString(tokens?.id_token)!) : null;
  const email = asString(claims?.email);
  const displayName = asString(claims?.name);
  if (!email && !accountId) return null;
  return { email, accountId, displayName, source: "codex" };
}

// Decode (WITHOUT verifying) the payload segment of a JWT. Returns null on any malformed input.
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as unknown;
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Build an Identity from the GitHub fields `gh api user` returns. Pure so it's testable without `gh`.
export function githubIdentity(login?: string, name?: string, email?: string): Identity | null {
  if (!login && !email) return null;
  return { githubLogin: login || undefined, displayName: name || undefined, email: email || undefined, source: "github" };
}

// --- Live readers (filesystem / subprocess) -------------------------------------------------------

export function readClaudeAccount(): Identity | null {
  try {
    return parseClaudeAccount(readFileSync(CLAUDE_CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function readCodexAccount(): Identity | null {
  try {
    return parseCodexAuth(readFileSync(join(CODEX_HOME, "auth.json"), "utf8"));
  } catch {
    return null;
  }
}

// The repo-local commit identity (git config user.email) for the directory a session ran in. A weak
// fallback — it's authorship, not an account — but universal across agents and present in any repo.
export function readGitIdentity(cwd?: string): Identity | null {
  const email = gitConfig("user.email", cwd);
  if (!email) return null;
  return { email, displayName: gitConfig("user.name", cwd), source: "git" };
}

// GitHub identity via the `gh` CLI. `gh api user` (a network call) returns login + name + email — run
// at setup only, never in the hot hook path. Returns null if `gh` is absent or signed out.
export function readGithub(): Identity | null {
  try {
    const out = execFileSync("gh", ["api", "user", "--jq", "{login, name, email}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8_000
    }).trim();
    if (!out) return null;
    const json = safeParseObject(out);
    if (!json) return null;
    return githubIdentity(asString(json.login), asString(json.name), asString(json.email));
  } catch {
    return null;
  }
}

// --- Resolution -----------------------------------------------------------------------------------

// Resolve the identity to attach to an upload, honoring the setup-confirmed config first, then a live
// account read, then the repo's git identity. The shared GitHub login/display name (captured at setup)
// are layered on regardless of which slot won, so the server `users` table can be enriched with them.
export function resolveIdentity(kind: "claude" | "codex", config: FiniusConfig | null, cwd?: string): Identity | null {
  const stored = kind === "claude" ? config?.identity?.claude : config?.identity?.codex;
  const live = kind === "claude" ? readClaudeAccount() : readCodexAccount();
  const base = fromStored(stored) ?? live ?? readGitIdentity(cwd);

  const githubLogin = config?.identity?.githubLogin;
  const displayName = config?.identity?.displayName;
  if (!base) {
    if (!githubLogin && !displayName) return null;
    return { githubLogin, displayName, source: "github" };
  }
  return {
    ...base,
    githubLogin: base.githubLogin ?? githubLogin,
    displayName: base.displayName ?? displayName
  };
}

function fromStored(stored: StoredIdentity | undefined): Identity | null {
  if (!stored) return null;
  const { email, accountId, userId } = stored;
  if (!email && !accountId && !userId) return null;
  return { email, accountId, userId, source: "config" };
}

// --- Small narrowing helpers ----------------------------------------------------------------------

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function gitConfig(key: string, cwd?: string): string | undefined {
  try {
    const out = execFileSync("git", ["config", "--get", key], {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
