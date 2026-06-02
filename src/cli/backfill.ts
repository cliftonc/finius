import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, spinner } from "@clack/prompts";
import { uploadHeaders } from "./client.js";
import { loadConfig, resolveAuthToken, resolveServerUrl } from "./config.js";
import { type Identity, resolveIdentity } from "./identity.js";
import { pc } from "./ui.js";
import type { TranscriptFormat } from "../server/types.js";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export type UploadOutcome = "ok" | "duplicate" | "failed";
export type BackfillResult = { uploaded: number; duplicate: number; failed: number; total: number };

// Recursively collect files under `dir` whose basename matches `match`. Safe on missing dirs.
export function walkFiles(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && match(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Every Claude Code transcript on disk (~/.claude/projects/**/<session>.jsonl).
export function findClaudeTranscripts(): string[] {
  return walkFiles(CLAUDE_PROJECTS_DIR, (n) => n.endsWith(".jsonl"));
}

// Upload one transcript file to the server. Idempotent server-side (content hash / replace-by-session).
// Attributes the upload to a user: an explicit `identity` if given, else resolved from config by format
// (so both the setup backfill and the Codex hook attach a user with no extra threading).
export async function uploadTranscript(
  path: string,
  opts: { source: string; format: TranscriptFormat; sessionId?: string; identity?: Identity; cwd?: string }
): Promise<UploadOutcome> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return "failed";
  }
  if (!content.trim()) return "failed";

  const config = loadConfig();
  const endpoint = `${resolveServerUrl()}/api/import/jsonl`;
  const headers = uploadHeaders(resolveAuthToken(config));
  const identity = opts.identity ?? resolveIdentity(opts.format === "codex" ? "codex" : "claude", config, opts.cwd);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content,
        source: opts.source,
        format: opts.format,
        sessionId: opts.sessionId,
        userEmail: identity?.email,
        userAccountId: identity?.accountId,
        userId: identity?.userId,
        githubLogin: identity?.githubLogin,
        displayName: identity?.displayName
      }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok) {
      process.stderr.write(`\nfinius: ${endpoint} returned ${res.status}\n`);
      return "failed";
    }
    const body = (await res.json().catch(() => ({}))) as { duplicate?: boolean };
    return body.duplicate ? "duplicate" : "ok";
  } catch (err) {
    process.stderr.write(`\nfinius: upload to ${endpoint} failed (${(err as Error).message})\n`);
    return "failed";
  }
}

// Upload a list of transcripts ONE AT A TIME — never concurrently, which would swamp the server with
// large bodies — rendering a live spinner with progress. Returns tallied outcomes.
export async function backfill(
  files: string[],
  opts: { source: string; format: TranscriptFormat; label: string; sessionIdFromPath?: (path: string) => string | undefined }
): Promise<BackfillResult> {
  const result: BackfillResult = { uploaded: 0, duplicate: 0, failed: 0, total: files.length };
  if (files.length === 0) {
    log.info(`${opts.label}: nothing to import.`);
    return result;
  }

  const total = files.length;
  const s = spinner();
  s.start(`Importing ${opts.label}`);
  let done = 0;
  for (const file of files) {
    const outcome = await uploadTranscript(file, { source: opts.source, format: opts.format, sessionId: opts.sessionIdFromPath?.(file) });
    if (outcome === "ok") result.uploaded++;
    else if (outcome === "duplicate") result.duplicate++;
    else result.failed++;
    done++;
    s.message(`Importing ${opts.label} ${pc.dim(`(${done}/${total})`)}`);
  }
  const summary =
    `${opts.label}: ${pc.green(`${result.uploaded} new`)}, ${result.duplicate} already-present` +
    (result.failed > 0 ? `, ${pc.red(`${result.failed} failed`)}` : "") +
    ` (of ${result.total}).`;
  s.stop(summary);

  if (result.failed > 0) {
    log.warn("Failures usually mean the server isn't running — `finius serve`, then re-run setup.");
  }
  return result;
}
