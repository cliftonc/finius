import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
import { installGlobally, isFiniusGloballyInstalled, isFiniusOnPath } from "./install.js";
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
  const oauth = health.reachable ? undefined : await configureOAuth(serverUrl, current);
  if (health.reachable) log.info("Connected to an existing server — skipping dashboard OAuth configuration.");

  // GitHub-only Secure Mode has no master password to exchange for a token, but this (owner) machine
  // still needs one for its own hook/OTEL uploads. Mint it now so the credential below is set; `serve`
  // seeds the same token into the DB on first run.
  let resolvedAuth = auth;
  if (oauth?.github?.enabled && !resolvedAuth.authToken && !resolvedAuth.authPassword) {
    resolvedAuth = { ...resolvedAuth, authToken: generateAuthToken() };
    log.info("GitHub-only secure mode — generated an owner token for this machine's uploads.");
  }

  saveConfig({ serverUrl, authPassword: resolvedAuth.authPassword, authToken: resolvedAuth.authToken, identity, auth: oauth ? { oauth } : undefined });
  log.success(`Saved config ${pc.dim(CONFIG_PATH)}`);

  // Install globally so the bare `finius` command works everywhere — including the hook, which then
  // needs only `finius hook` rather than an absolute path tied to this npx cache. Note: under `npx`
  // the npx shim sits on PATH (and shadows any global install), so `isFiniusOnPath()` alone would
  // wrongly skip this — check the durable global install too, or the prompt never appears.
  let onPath = isFiniusOnPath() || isFiniusGloballyInstalled();
  if (!onPath) {
    const wantGlobal = ask(
      await confirm({ message: "Install finius globally so the `finius` command works everywhere?" })
    );
    if (wantGlobal) {
      const s = spinner();
      s.start("Running `npm install -g @cliftonc/finius`");
      onPath = installGlobally();
      s.stop(
        onPath
          ? "Installed — `finius` is now on your PATH"
          : pc.yellow("Global install didn't complete; the hook will use an absolute path instead.")
      );
    }
  }

  // Only offer to configure agents that are actually installed.
  const credential = resolveAuthToken({ serverUrl, ...resolvedAuth });
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
    const browserToken = await browserLogin(serverUrl);
    if (browserToken) {
      log.success("Authenticated in the browser — saved a client token for this machine.");
      return { authToken: browserToken };
    }
    for (;;) {
      // @clack's password prompt yields undefined on an empty submit — coalesce before trimming.
      const entered = ask(await passwordPrompt({ message: "Server password" }));
      const trimmed = (entered ?? "").trim();
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

  if (health.reachable) {
    log.info("Server is already running in open mode — skipping server auth configuration.");
    return current;
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

async function browserLogin(serverUrl: string): Promise<string | null> {
  const callback = await startCliAuthCallback();
  const loginUrl = `${serverUrl}/?cli_return_to=${encodeURIComponent(callback.returnTo)}`;
  note(
    `${pc.cyan(loginUrl)}\n\n${pc.dim("Complete login in your browser. This command will continue automatically when the browser redirects back.")}`,
    "Browser login"
  );
  const token = await callback.waitForToken();
  return token;
}

async function startCliAuthCallback(): Promise<{ returnTo: string; waitForToken: () => Promise<string | null> }> {
  let resolveToken: (token: string | null) => void = () => {};
  const tokenPromise = new Promise<string | null>((resolve) => {
    resolveToken = resolve;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const token = url.searchParams.get("token");
    if (url.pathname !== "/callback" || !token) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Finius login callback is missing a token.");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(cliCallbackPage());
    resolveToken(token);
    server.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const timeout = setTimeout(() => {
    resolveToken(null);
    server.close();
  }, 5 * 60_000);

  return {
    returnTo: `http://127.0.0.1:${port}/callback`,
    waitForToken: async () => {
      const token = await tokenPromise;
      clearTimeout(timeout);
      return token;
    }
  };
}

// The page shown in the browser once the CLI login completes. Self-contained (no external assets
// beyond the same Google Fonts the dashboard uses): the real Finius mark + wordmark from the
// dashboard header (logo left of "Finius" in Fraunces), light theme, fully centered.
export function cliCallbackPage(): string {
  // The exact artwork from src/client/ui/FiniusLogo.tsx / public/favicon.svg.
  const logo = `<svg class="logo" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g>
      <rect x="29.1449" y="23.3542" width="18" height="28.5815" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -15.4466 37.9985)" fill="#FFFFFF"/>
      <path fill="#FFFFFF" stroke="none" stroke-linecap="round" stroke-miterlimit="10" stroke-width="2" d="M13.9792,56.7778 c0.3645,0.3645,0.8533,0.5189,1.325,0.4674c0,0,8.9017,0.0515,13.9615-4.8025C29.33,52.387,29.39,52.327,29.45,52.2669 c1.8352-1.8352,1.8309-4.8068,0-6.6377c-1.831-1.831-4.8025-1.8352-6.6377,0l-8.8331,8.8331 C13.3403,55.1013,13.3403,56.1389,13.9792,56.7778z"/>
      <ellipse cx="34.4281" cy="24.1507" rx="2.328" ry="2.328" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -6.9934 31.4179)" fill="#5C9E31"/>
      <ellipse cx="52.0767" cy="41.3611" rx="2.328" ry="2.328" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -13.9938 48.9382)" fill="#5C9E31"/>
      <ellipse cx="24.3188" cy="34.2599" rx="2.328" ry="2.328" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -17.1026 27.2305)" fill="#5C9E31"/>
      <ellipse cx="41.5796" cy="51.5206" rx="2.328" ry="2.328" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -24.2522 44.4912)" fill="#5C9E31"/>
      <rect x="42.8977" y="18.1717" width="1.67" height="27.3291" transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 97.1681 23.4242)" fill="#5C9E31"/>
      <rect x="31.153" y="29.4453" width="1.67" height="27.3291" transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 85.0901 50.9742)" fill="#5C9E31"/>
      <rect x="27.9561" y="19.0196" width="1.6895" height="18.295" transform="matrix(0.7071 0.7071 -0.7071 0.7071 28.3527 -12.1153)" fill="#5C9E31"/>
      <rect x="46.7884" y="37.8519" width="1.6895" height="18.295" transform="matrix(0.7071 0.7071 -0.7071 0.7071 47.185 -19.9159)" fill="#5C9E31"/>
      <ellipse cx="38.1014" cy="37.4676" rx="5.7418" ry="9.277" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -15.334 37.9158)" fill="#5C9E31"/>
      <path fill="#FFFFFF" stroke="none" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" stroke-width="2" d="M47.425,35.1923L35.6923,46.925c-0.0422,0.0422-0.0886,0.0725-0.1392,0.0987c-0.2062,0.1007-0.4716,0.0578-0.6501-0.1206 l-6.2227-6.2227c-0.1785-0.1785-0.2214-0.4439-0.1206-0.6501c0.0262-0.0505,0.0565-0.097,0.0987-0.1392L40.391,28.1583 c0.0422-0.0422,0.0887-0.0725,0.1392-0.0987c0.2062-0.1007,0.4716-0.0578,0.6501,0.1206l6.2227,6.2227 c0.1785,0.1785,0.2214,0.4439,0.1206,0.6501C47.4974,35.1036,47.4672,35.1501,47.425,35.1923z"/>
      <path fill="#FFFFFF" stroke="none" stroke-linecap="round" stroke-miterlimit="10" stroke-width="2" d="M57.1856,13.5714 c0.3645,0.3645,0.5189,0.8533,0.4674,1.325c0,0,0.0515,8.9017-4.8025,13.9615c-0.0557,0.0643-0.1158,0.1243-0.1758,0.1844 c-1.8352,1.8352-4.8068,1.8309-6.6377,0c-1.831-1.831-1.8352-4.8025,0-6.6377l8.8331-8.8331 C55.5091,12.9325,56.5467,12.9325,57.1856,13.5714z"/>
    </g>
    <g>
      <path fill="none" stroke="#000000" stroke-linecap="round" stroke-miterlimit="10" stroke-width="2" d="M13.9792,56.7778 c0.3645,0.3645,0.8533,0.5189,1.325,0.4674c0,0,8.9017,0.0515,13.9615-4.8025C29.33,52.387,29.39,52.327,29.45,52.2669 c1.8352-1.8352,1.8309-4.8068,0-6.6377c-1.831-1.831-4.8025-1.8352-6.6377,0l-8.8331,8.8331 C13.3403,55.1013,13.3403,56.1389,13.9792,56.7778z"/>
      <path fill="none" stroke="#000000" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" stroke-width="2" d="M41.0551,53.3579L22.4424,34.7451c-0.3905-0.3905-0.3905-1.0237,0-1.4142l11.2424-11.2424c0.3905-0.3905,1.0237-0.3905,1.4142,0 l18.6127,18.6127c0.3905,0.3905,0.3905,1.0237,0,1.4142L42.4693,53.3579C42.0788,53.7484,41.4456,53.7484,41.0551,53.3579z"/>
      <path fill="none" stroke="#000000" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" stroke-width="2" d="M47.425,35.1923L35.6923,46.925c-0.0422,0.0422-0.0886,0.0725-0.1392,0.0987c-0.2062,0.1007-0.4716,0.0578-0.6501-0.1206 l-6.2227-6.2227c-0.1785-0.1785-0.2214-0.4439-0.1206-0.6501c0.0262-0.0505,0.0565-0.097,0.0987-0.1392L40.391,28.1583 c0.0422-0.0422,0.0887-0.0725,0.1392-0.0987c0.2062-0.1007,0.4716-0.0578,0.6501,0.1206l6.2227,6.2227 c0.1785,0.1785,0.2214,0.4439,0.1206,0.6501C47.4974,35.1036,47.4672,35.1501,47.425,35.1923z"/>
      <path fill="none" stroke="#000000" stroke-linecap="round" stroke-miterlimit="10" stroke-width="2" d="M57.1856,13.5714 c0.3645,0.3645,0.5189,0.8533,0.4674,1.325c0,0,0.0515,8.9017-4.8025,13.9615c-0.0557,0.0643-0.1158,0.1243-0.1758,0.1844 c-1.8352,1.8352-4.8068,1.8309-6.6377,0c-1.831-1.831-1.8352-4.8025,0-6.6377l8.8331-8.8331 C55.5091,12.9325,56.5467,12.9325,57.1856,13.5714z"/>
    </g>
  </svg>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Finius — login complete</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    min-height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: radial-gradient(1100px 560px at 50% -8%, #f1f6ee 0%, #fafafa 55%, #f4f4f5 100%);
    color: #18181b;
  }
  .card {
    width: 100%;
    max-width: 440px;
    background: #ffffff;
    border: 1px solid #ececec;
    border-radius: 16px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.06);
    padding: 40px 32px;
    text-align: center;
  }
  .brand { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .logo { width: 44px; height: 44px; display: block; }
  .wordmark {
    font-family: Fraunces, ui-serif, Georgia, "Times New Roman", serif;
    font-optical-sizing: auto;
    font-weight: 600;
    font-size: 44px;
    line-height: 1;
    letter-spacing: -0.02em;
    color: #18181b;
  }
  .badge {
    display: inline-flex; align-items: center; gap: 8px;
    margin-top: 22px; padding: 6px 14px;
    background: #eef7e9; color: #3f7d23;
    border: 1px solid #d8eccb; border-radius: 999px;
    font-size: 14px; font-weight: 600;
  }
  .badge svg { width: 16px; height: 16px; }
  p { margin: 18px 0 0; color: #71717a; font-size: 15px; line-height: 1.5; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">
      ${logo}
      <span class="wordmark">Finius</span>
    </div>
    <div class="badge">
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10.5l4 4 8-9" stroke="#3f7d23" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Login complete
    </div>
    <p>You're signed in. Close this tab and return to your terminal — setup will continue automatically.</p>
  </main>
</body>
</html>`;
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

async function configureOAuth(serverUrl: string, current: FiniusConfig | null): Promise<NonNullable<FiniusConfig["auth"]>["oauth"] | undefined> {
  const existing = current?.auth?.oauth?.github;
  const enableGithub = ask(
    await confirm({
      message: "Enable GitHub OAuth login for the dashboard?",
      initialValue: !!existing?.enabled
    })
  );
  if (!enableGithub) return undefined;

  const clientId = ask(
    await text({
      message: "GitHub OAuth client ID",
      placeholder: existing?.clientId || "Ov23li...",
      defaultValue: existing?.clientId,
      initialValue: existing?.clientId
    })
  ).trim();
  // An empty submit yields undefined from @clack's password prompt; coalesce so .trim() is safe and an
  // empty entry falls through to the existing secret (the "leave empty to keep existing" affordance).
  const enteredSecret = ask(
    await passwordPrompt({
      message: existing?.clientSecret ? "GitHub OAuth client secret (leave empty to keep existing)" : "GitHub OAuth client secret"
    })
  );
  const clientSecret = (enteredSecret ?? "").trim() || existing?.clientSecret || "";
  const requiredOrg = ask(
    await text({
      message: "Required GitHub organization",
      placeholder: existing?.requiredOrg || "my-org",
      defaultValue: existing?.requiredOrg,
      initialValue: existing?.requiredOrg
    })
  ).trim();

  if (!clientId || !clientSecret || !requiredOrg) {
    log.warn("GitHub OAuth was skipped because the client ID, secret, and organization are all required.");
    return undefined;
  }
  note(`${serverUrl}/api/auth/github/callback`, "GitHub OAuth callback URL");
  return { github: { enabled: true, clientId, clientSecret, requiredOrg } };
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
