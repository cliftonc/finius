import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, intro, log, note, outro, password as passwordPrompt, spinner, text } from "@clack/prompts";
import {
  type ClaudeSettings,
  TELEMETRY_HOOK_EVENTS,
  withFiniusHook,
  withTelemetryEnv
} from "./claude-settings.js";
import { backfill, findClaudeTranscripts } from "./backfill.js";
import { applyCodexConfig, CODEX_CONFIG_PATH, CODEX_SOURCE, findCodexRollouts, isCodexInstalled } from "./codex.js";
import { type FiniusConfig, CONFIG_PATH, DEFAULT_SERVER_URL, loadConfig, normalizeUrl, resolveAuthToken, saveConfig } from "./config.js";
import { readClaudeAccount, readCodexAccount, readGithub, readGitIdentity } from "./identity.js";
import { installGlobally, isFiniusOnPath } from "./install.js";
import { generateAuthToken, generatePassword } from "./password.js";
import { ask, banner, pc } from "./ui.js";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

export async function runSetup(args: string[] = []): Promise<number> {
  banner("setup");
  intro(pc.bgCyan(pc.black(" Configure Finius ")));

  const current = loadConfig();
  const defaultUrl = current?.serverUrl ?? DEFAULT_SERVER_URL;

  // A server URL can be passed directly (e.g. `finius setup http://localhost:8787`, the form the
  // dashboard's setup modal hands you) — when valid we skip the prompt and use it.
  const argUrl = args.map((a) => normalizeUrl(a)).find((a): a is string => Boolean(a));
  const serverUrl = argUrl
    ? (log.info(`Using server URL ${pc.cyan(argUrl)}`), argUrl)
    : normalizeUrl(
        ask(
          await text({
            message: "Finius server URL",
            placeholder: defaultUrl,
            defaultValue: defaultUrl,
            validate: (value) => (value && !normalizeUrl(value) ? "Enter a valid URL" : undefined)
          })
        )
      ) || defaultUrl;

  const health = await checkServer(serverUrl);

  // Resolve authentication (Secure Mode). May generate a master password (owner of a new server) or
  // exchange one for a client token (joining an existing secure server). No-op for open servers.
  const auth = await configureAuth(serverUrl, health, {
    authPassword: current?.authPassword,
    authToken: current?.authToken
  });

  // Capture a user identity so uploaded transcripts are attributed to a person (and line up with
  // live OTEL metrics). Detected from the local Claude/Codex/GitHub/git state, confirmed by the user.
  const identity = await configureIdentity(current);

  saveConfig({ serverUrl, authPassword: auth.authPassword, authToken: auth.authToken, identity });
  log.success(`Saved config ${pc.dim(CONFIG_PATH)}`);

  // Install globally so the bare `finius` command works everywhere — including the hook, which then
  // needs only `finius hook` rather than an absolute path tied to this npx cache.
  let onPath = isFiniusOnPath();
  if (!onPath) {
    const wantGlobal = ask(
      await confirm({ message: "Install finius globally so the `finius` command works everywhere?" })
    );
    if (wantGlobal) {
      const s = spinner();
      s.start("Running `npm install -g finius`");
      onPath = installGlobally();
      s.stop(
        onPath
          ? "Installed — `finius` is now on your PATH"
          : pc.yellow("Global install didn't complete; the hook will use an absolute path instead.")
      );
    }
  }

  // Only offer to configure agents that are actually installed.
  const credential = resolveAuthToken({ serverUrl, ...auth });
  const haveClaude = isClaudeInstalled();
  const haveCodex = isCodexInstalled();

  if (haveClaude) await configureClaude(serverUrl, credential, onPath, health.reachable);
  if (haveCodex) await configureCodex(serverUrl, credential, onPath, health.reachable);
  if (!haveClaude && !haveCodex) {
    log.warn(
      "No Claude Code or Codex install detected — skipping agent configuration.\n" +
        "Re-run `finius setup` after installing one, or import transcripts manually."
    );
  }

  outro(`${pc.green("Done.")} Next: run ${pc.cyan("finius serve")} to start the server + dashboard.`);
  return 0;
}

type ServerHealth = { reachable: boolean; secure: boolean };

async function checkServer(serverUrl: string): Promise<ServerHealth> {
  const s = spinner();
  s.start(`Checking server at ${serverUrl}`);
  try {
    const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { secure?: boolean };
      s.stop(`Server reachable at ${pc.cyan(serverUrl)}`);
      return { reachable: true, secure: !!body.secure };
    }
    s.stop(pc.yellow(`Server responded with ${res.status} — start it with \`finius serve\``));
  } catch {
    s.stop(pc.yellow("Server not reachable yet — start it later with `finius serve`"));
  }
  return { reachable: false, secure: false };
}

type AuthState = { authPassword?: string; authToken?: string };

// Resolve this machine's auth credential. Two paths:
//  • Joining an existing Secure Mode server → prompt for the password and exchange it for a per-client
//    session token (persisted as authToken).
//  • An open/new server → offer to enable Secure Mode by generating a master password plus an owner
//    token. The password starts the server; the token is seeded into the DB and used by clients.
// Existing credentials are kept on re-run (doctor verifies them).
async function configureAuth(serverUrl: string, health: ServerHealth, current: AuthState): Promise<AuthState> {
  if (health.secure) {
    if (current.authToken) {
      log.info("Server requires authentication — keeping the client token already in your config.");
      return current;
    }
    if (current.authPassword) {
      const token = await login(serverUrl, current.authPassword);
      if (token) {
        log.success("Authenticated with the saved password — saved a client token for this machine.");
        return { ...current, authToken: token };
      }
      log.warn("Saved password was rejected by the server login endpoint.");
    }
    log.warn("This Finius server requires authentication.");
    for (;;) {
      const entered = ask(await passwordPrompt({ message: "Server password" }));
      const trimmed = entered.trim();
      if (!trimmed) {
        if (ask(await confirm({ message: "No password entered — skip auth setup for now?", initialValue: false }))) {
          return current;
        }
        continue;
      }
      const token = await login(serverUrl, trimmed);
      if (token) {
        log.success("Authenticated — saved a client token for this machine.");
        return { authToken: token };
      }
      log.error("That password was rejected — try again.");
    }
  }

  if (current.authPassword) {
    if (current.authToken) {
      log.info("Auth is enabled (this machine owns the password). Keeping it.");
      return current;
    }
    log.info("Auth is enabled (this machine owns the password). Creating an owner token.");
    return { ...current, authToken: generateAuthToken() };
  }

  const wantAuth = ask(
    await confirm({
      message: "Require authentication to view/ingest?",
      // Off by default — fine for localhost or a trusted private network.
      initialValue: false
    })
  );
  if (!wantAuth) return {};

  const pw = generatePassword();
  const token = generateAuthToken();
  note(
    `${pc.bold(pc.cyan(pw))}\n\n${pc.dim("Save it now — other machines need it to connect, and\nyou'll use it to log in to the dashboard.")}`,
    "Secure Mode enabled — your Finius password"
  );
  return { authPassword: pw, authToken: token };
}

// Detect a user identity from the local agent state and confirm it with the user, so the hook/backfill
// can attribute uploaded transcripts to a person. Preference for the default offered: the Claude
// account email (it matches live OTEL), falling back to GitHub, then git. Codex is captured as-is (its
// real ChatGPT account). The GitHub login/display name are captured once here (never in the hot hook).
async function configureIdentity(current: FiniusConfig | null): Promise<FiniusConfig["identity"]> {
  const claude = readClaudeAccount();
  const codex = readCodexAccount();
  const github = readGithub();
  const git = readGitIdentity();

  const detected: string[] = [];
  if (claude?.email) detected.push(`${pc.dim("Claude account")}  ${claude.email}`);
  if (codex?.email) detected.push(`${pc.dim("Codex account")}   ${codex.email} ${pc.dim("(used as-is for Codex)")}`);
  if (github?.githubLogin) {
    detected.push(`${pc.dim("GitHub")}          @${github.githubLogin}${github.email ? pc.dim(` (${github.email})`) : ""}`);
  }
  if (!claude?.email && git?.email) detected.push(`${pc.dim("Git identity")}    ${git.email} ${pc.dim("(fallback)")}`);
  if (detected.length) note(detected.join("\n"), "Detected accounts");

  const stored = current?.identity;
  const defaultEmail = stored?.claude?.email ?? claude?.email ?? github?.email ?? git?.email ?? "";
  const answer = ask(
    await text({
      message: "Your email for attribution",
      placeholder: defaultEmail || "none",
      defaultValue: defaultEmail,
      initialValue: defaultEmail
    })
  ).trim();
  const email = answer || defaultEmail || undefined;

  // Only keep the detected account ids when the confirmed email still matches the detected account —
  // a hand-typed override belongs to a different identity, so we drop ids that aren't its own.
  const claudeSlot =
    email && claude?.email === email
      ? { email, accountId: claude.accountId, userId: claude.userId }
      : email
        ? { email, accountId: stored?.claude?.accountId, userId: stored?.claude?.userId }
        : stored?.claude;

  const codexSlot = codex?.email || codex?.accountId
    ? { email: codex.email, accountId: codex.accountId }
    : stored?.codex;

  const githubLogin = github?.githubLogin ?? stored?.githubLogin;
  const displayName = github?.displayName ?? claude?.displayName ?? git?.displayName ?? stored?.displayName;

  const identity = {
    ...(claudeSlot ? { claude: claudeSlot } : {}),
    ...(codexSlot ? { codex: codexSlot } : {}),
    ...(githubLogin ? { githubLogin } : {}),
    ...(displayName ? { displayName } : {})
  };
  if (Object.keys(identity).length === 0) return undefined;

  const label = displayName ?? email ?? githubLogin;
  log.success(`Attributing sessions to ${pc.cyan(String(label))}${githubLogin ? pc.dim(` (@${githubLogin})`) : ""}.`);
  return identity;
}

// Exchange the master password for a client session token at the login endpoint. Returns null on a
// rejected password or any network error (the caller re-prompts).
async function login(serverUrl: string, password: string): Promise<string | null> {
  try {
    const res = await fetch(`${serverUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, label: hostname() }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}

function readClaudeSettings(): ClaudeSettings {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf8")) as ClaudeSettings;
  } catch {
    throw new Error(`${CLAUDE_SETTINGS_PATH} is not valid JSON — fix or remove it, then re-run setup.`);
  }
}

function writeClaudeSettings(settings: ClaudeSettings): void {
  mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// Prefer the bare `finius <sub>` once the CLI is on PATH (survives upgrades, matches `npm i -g`).
// Otherwise fall back to an absolute `node <cli> <sub>` so the hook still works from this install.
function hookCommand(onPath: boolean, sub: string): string {
  if (onPath) return `finius ${sub}`;
  const cliEntry = join(dirname(fileURLToPath(import.meta.url)), "index.js");
  return `${quote(process.execPath)} ${quote(cliEntry)} ${sub}`;
}

// Claude Code keeps its config under ~/.claude; its presence is our "installed" signal.
function isClaudeInstalled(): boolean {
  return existsSync(join(homedir(), ".claude"));
}

// Configure Claude Code: OTEL env vars + the transcript-upload hook, both opt-in.
async function configureClaude(serverUrl: string, credential: string | undefined, onPath: boolean, canImport: boolean): Promise<void> {
  log.step(pc.bold("Claude Code") + pc.dim(` — edits ${CLAUDE_SETTINGS_PATH}`));
  const wantEnv = ask(await confirm({ message: "Add OpenTelemetry env vars (so Claude Code reports usage)?" }));
  const wantHook = ask(await confirm({ message: "Install the SessionEnd/PreCompact hook (so transcripts upload)?" }));
  if (wantEnv || wantHook) {
    const settings = readClaudeSettings();
    if (wantEnv) withTelemetryEnv(settings, serverUrl, credential);
    if (wantHook) withFiniusHook(settings, hookCommand(onPath, "hook"));
    writeClaudeSettings(settings);
    const lines = [`Updated ${pc.dim(CLAUDE_SETTINGS_PATH)}`];
    if (wantEnv) lines.push(`${pc.green("•")} OTEL env vars set under \`env\``);
    if (wantHook) lines.push(`${pc.green("•")} Hook installed for ${TELEMETRY_HOOK_EVENTS.join(" + ")} under \`hooks\``);
    lines.push(pc.dim("Restart any open Claude Code sessions for the changes to take effect."));
    log.success(lines.join("\n"));
  } else {
    log.info("Skipped Claude Code configuration.");
  }

  // The hook only catches future sessions; offer to import what's already on disk (one at a time),
  // but only when the server is reachable. Otherwise the uploads would fail immediately.
  if (canImport && ask(await confirm({ message: "Import your existing Claude sessions now?" }))) {
    await backfill(findClaudeTranscripts(), { source: "claude-code-jsonl", format: "claude", label: "Claude sessions" });
  }
}

// Configure Codex: the Stop hook (uploads rollouts), optional OTEL log capture, and a one-time
// backfill of existing sessions. Codex config is TOML; we own a clearly-delimited managed block.
async function configureCodex(serverUrl: string, credential: string | undefined, onPath: boolean, canImport: boolean): Promise<void> {
  log.step(pc.bold("Codex") + pc.dim(` — edits ${CODEX_CONFIG_PATH}`));
  const wantHook = ask(await confirm({ message: "Install the Stop hook (upload Codex rollouts to Finius)?" }));
  const wantOtel = ask(await confirm({ message: "Enable OpenTelemetry log capture (event inspection only)?", initialValue: false }));

  if (wantHook || wantOtel) {
    const result = applyCodexConfig({
      hookCommand: wantHook ? hookCommand(onPath, "codex-hook") : undefined,
      otlpLogsEndpoint: wantOtel ? `${serverUrl}/otlp/v1/logs` : undefined,
      // In Secure Mode the exporter must authenticate; otherwise the server would 401 every batch.
      authToken: wantOtel ? credential : undefined
    });
    const lines: string[] = [];
    if (result.changed) lines.push(`Updated ${pc.dim(CODEX_CONFIG_PATH)}`);
    if (result.addedHook) lines.push(`${pc.green("•")} Stop hook installed (runs \`${hookCommand(onPath, "codex-hook")}\`)`);
    if (result.addedOtel) lines.push(`${pc.green("•")} [otel] exporter → Finius logs endpoint`);
    if (result.skippedHook) {
      lines.push(`${pc.yellow("•")} You already define [hooks] in config.toml — left it untouched (add the Stop hook manually).`);
    }
    if (result.skippedOtel) lines.push(`${pc.yellow("•")} You already define [otel] in config.toml — left it untouched.`);
    lines.push(pc.dim("Restart Codex for the changes to take effect."));
    log.success(lines.join("\n"));
  } else {
    log.info("Skipped Codex configuration.");
  }

  // The hook only catches future sessions; offer to import what's already on disk (one at a time),
  // but only when the server is reachable. Otherwise the uploads would fail immediately.
  if (canImport && ask(await confirm({ message: "Import your existing Codex sessions now?" }))) {
    await backfill(findCodexRollouts(), { source: CODEX_SOURCE, format: "codex", label: "Codex sessions" });
  }
}

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}
