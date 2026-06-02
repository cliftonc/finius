import { readFileSync } from "node:fs";
import { uploadHeaders } from "./client.js";
import { loadConfig, resolveAuthToken, resolveServerUrl } from "./config.js";
import { resolveIdentity } from "./identity.js";

// Shape of the JSON Claude Code pipes to a hook command on stdin. We only need a few fields.
type HookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""; // run interactively with no piped input — nothing to do
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Invoked by Claude Code's SessionEnd / PreCompact hooks. Reads the session transcript and uploads
// its contents to the Finius server. Always resolves with exit code 0 — a hook must never block or
// fail Claude Code, even when the server is down.
export async function runHook(): Promise<number> {
  let input: HookInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw) as HookInput;
  } catch {
    return 0; // unparseable stdin — nothing actionable
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) return 0;

  let content: string;
  try {
    content = readFileSync(transcriptPath, "utf8");
  } catch {
    return 0; // file may have been cleaned up (e.g. a very short session)
  }
  if (!content.trim()) return 0;

  const endpoint = `${resolveServerUrl()}/api/import/claude-hook`;
  const config = loadConfig();
  const headers = uploadHeaders(resolveAuthToken(config));

  // Attribute the upload to a user (config-confirmed → live Claude account → git), so a hook-imported
  // transcript lands under the same identity as that session's live OTEL metrics.
  const identity = resolveIdentity("claude", config, input.cwd);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: input.session_id,
        transcript: content,
        cwd: input.cwd,
        hook_event_name: input.hook_event_name,
        user_email: identity?.email,
        user_account_id: identity?.accountId,
        user_id: identity?.userId,
        github_login: identity?.githubLogin,
        display_name: identity?.displayName
      }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok) process.stderr.write(`finius hook: ${endpoint} returned ${res.status}\n`);
  } catch (err) {
    process.stderr.write(`finius hook: upload to ${endpoint} failed (${(err as Error).message})\n`);
  }
  return 0;
}
