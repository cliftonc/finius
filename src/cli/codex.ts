import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type CodexBlockOptions, type CodexMergeResult, withFiniusCodexBlock } from "./codex-config.js";
import { uploadTranscript, walkFiles } from "./backfill.js";

// Codex stores everything under ~/.codex (override with CODEX_HOME, as the app itself does).
export const CODEX_HOME = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
export const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
const CODEX_SESSIONS_DIR = join(CODEX_HOME, "sessions");
export const CODEX_SOURCE = "codex-cli-jsonl";

// Codex is "installed" if its home dir or the macOS app bundle is present.
export function isCodexInstalled(): boolean {
  return existsSync(CODEX_HOME) || existsSync("/Applications/Codex.app");
}

// Apply (or refresh) the Finius-managed block in ~/.codex/config.toml. Pure merge in codex-config.ts;
// this just does the read/write. Creates the file if missing.
export function applyCodexConfig(opts: CodexBlockOptions): CodexMergeResult {
  const current = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const result = withFiniusCodexBlock(current, opts);
  if (result.changed) {
    mkdirSync(dirname(CODEX_CONFIG_PATH), { recursive: true });
    writeFileSync(CODEX_CONFIG_PATH, result.toml, "utf8");
  }
  return result;
}

// Every Codex rollout transcript on disk (~/.codex/sessions/**/rollout-*.jsonl).
export function findCodexRollouts(): string[] {
  return walkFiles(CODEX_SESSIONS_DIR, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"));
}

// `finius codex-hook` — invoked by Codex's Stop hook. Codex passes a JSON payload on stdin (shape not
// fully documented), so we read it best-effort but don't depend on it: we locate the session's rollout
// file ourselves (by session id if present, else the most-recently-modified rollout) and upload it.
// The server replaces the session's prior Codex points on every upload, so re-firing per turn is safe.
// Always resolves 0 — a hook must never block or fail the agent.
export async function runCodexHook(): Promise<number> {
  let payload: Record<string, unknown> = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // unparseable stdin — fall back to "newest rollout"
  }

  const sessionId = firstString(payload, ["session_id", "sessionId", "conversation_id", "id", "thread_id"]);
  const explicit = firstString(payload, ["rollout_path", "transcript_path", "path", "rollout"]);
  const cwd = firstString(payload, ["cwd", "workdir", "working_directory"]);
  const rollout = explicit && existsSync(explicit) ? explicit : findRollout(sessionId);
  if (!rollout) return 0;

  // uploadTranscript resolves the Codex identity from config (git-fallback uses cwd) on its own.
  await uploadTranscript(rollout, { source: CODEX_SOURCE, format: "codex", sessionId, cwd });
  return 0;
}

// Newest rollout under ~/.codex/sessions/**, optionally restricted to those whose filename contains
// the given session id (Codex names files `rollout-<ts>-<sessionId>.jsonl`).
export function findRollout(sessionId?: string): string | null {
  const all = findCodexRollouts();
  if (!all.length) return null;
  const pool = sessionId ? all.filter((f) => f.includes(sessionId)) : all;
  const candidates = pool.length ? pool : all;
  let best = candidates[0];
  let bestMtime = mtime(best);
  for (const f of candidates.slice(1)) {
    const m = mtime(f);
    if (m > bestMtime) {
      best = f;
      bestMtime = m;
    }
  }
  return best;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
