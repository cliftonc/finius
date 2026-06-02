import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { intro, log, outro } from "@clack/prompts";
import { type ClaudeSettings, TELEMETRY_HOOK_EVENTS } from "./claude-settings.js";
import { CONFIG_PATH, loadConfig, normalizeUrl, resolveAuthToken } from "./config.js";
import { isFiniusOnPath } from "./install.js";
import { banner, pc } from "./ui.js";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const VSCODE_SETTINGS_PATH = join(homedir(), "Library", "Application Support", "Code", "User", "settings.json");

// `finius doctor` — checks that the three things that must agree actually do: the configured server
// URL, the OTEL endpoints in Claude Code's settings, and a reachable healthy server. Prints a
// checklist and exits non-zero if anything is broken.
export async function runDoctor(): Promise<number> {
  let problems = 0;
  const ok = (label: string) => log.success(label);
  const warn = (label: string, hint?: string) => {
    log.warn(`${label}${hint ? `\n${pc.dim(`→ ${hint}`)}` : ""}`);
  };
  const bad = (label: string, hint?: string) => {
    problems++;
    log.error(`${label}${hint ? `\n${pc.dim(`→ ${hint}`)}` : ""}`);
  };
  const section = (title: string, detail?: string) => log.message(pc.bold(title) + (detail ? pc.dim(`  ${detail}`) : ""));

  banner("doctor");
  intro(pc.bgCyan(pc.black(" Diagnostics ")));

  // --- Config -----------------------------------------------------------------
  section("Config", CONFIG_PATH);
  const config = loadConfig();
  const serverUrl = config?.serverUrl;
  if (serverUrl) ok(`serverUrl = ${serverUrl}`);
  else bad("no config found", "run `finius setup`");
  const serverOrigin = serverUrl ? originOf(serverUrl) : null;

  // --- Claude Code telemetry --------------------------------------------------
  section("Claude Code telemetry", CLAUDE_SETTINGS_PATH);
  const settings = readSettings();
  if (!settings) {
    bad("settings.json missing or invalid JSON", "run `finius setup`");
  } else {
    const env = settings.env ?? {};
    if (env.CLAUDE_CODE_ENABLE_TELEMETRY === "1") ok("CLAUDE_CODE_ENABLE_TELEMETRY = 1");
    else bad("telemetry not enabled (CLAUDE_CODE_ENABLE_TELEMETRY != 1)", "run `finius setup`");

    const metrics = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    const logs = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    metrics ? ok(`metrics endpoint → ${metrics}`) : bad("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT not set");
    logs ? ok(`logs endpoint    → ${logs}`) : bad("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT not set");

    // The classic failure: endpoints point at a different origin than the server we serve/configure.
    for (const ep of [metrics, logs].filter(Boolean) as string[]) {
      const epOrigin = originOf(ep);
      if (serverOrigin && epOrigin && epOrigin !== serverOrigin) {
        bad(
          `endpoint ${epOrigin} does not match serverUrl ${serverOrigin}`,
          "re-run `finius setup` so the endpoints and the served port agree"
        );
      }
    }

    const protocol = env.OTEL_EXPORTER_OTLP_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL;
    if (protocol === "http/json" || protocol === "http/protobuf") ok(`protocol = ${protocol}`);
    else warn(`protocol = ${protocol ?? "(unset → defaults to http/protobuf)"}`, "Finius accepts http/json and http/protobuf");

    // Hook
    const eventsWithHook = TELEMETRY_HOOK_EVENTS.filter((e) =>
      (settings.hooks?.[e] ?? []).some((g) => g.hooks?.some((h) => h.command?.includes("finius")))
    );
    if (eventsWithHook.length === TELEMETRY_HOOK_EVENTS.length) ok(`hook installed for ${eventsWithHook.join(" + ")}`);
    else if (eventsWithHook.length > 0) warn(`hook only on ${eventsWithHook.join(", ")}`, "re-run `finius setup`");
    else bad("transcript-upload hook not installed", "run `finius setup`");
  }

  // --- GitHub Copilot telemetry ----------------------------------------------
  section("GitHub Copilot telemetry", VSCODE_SETTINGS_PATH);
  const vsCodeSettings = readJson(VSCODE_SETTINGS_PATH);
  if (!vsCodeSettings) {
    warn("VS Code settings.json missing or invalid", "run `finius setup` after installing VS Code Copilot");
  } else if (vsCodeSettings["github.copilot.chat.otel.enabled"] === true) {
    ok("github.copilot.chat.otel.enabled = true");
    const endpoint = typeof vsCodeSettings["github.copilot.chat.otel.otlpEndpoint"] === "string"
      ? vsCodeSettings["github.copilot.chat.otel.otlpEndpoint"]
      : "";
    endpoint ? ok(`VS Code OTLP endpoint → ${endpoint}`) : bad("github.copilot.chat.otel.otlpEndpoint not set");
    const epOrigin = originOf(endpoint);
    if (serverOrigin && epOrigin && epOrigin !== serverOrigin) {
      bad(`VS Code Copilot endpoint ${epOrigin} does not match serverUrl ${serverOrigin}`, "re-run `finius setup`");
    }
  } else {
    warn("VS Code Copilot OTel not enabled", "run `finius setup` to enable live Copilot traces");
  }

  // --- CLI --------------------------------------------------------------------
  section("CLI");
  if (isFiniusOnPath()) ok("`finius` is on PATH");
  else warn("`finius` not on PATH", "install globally with `npm i -g finius` so hooks can run it");

  // --- Server -----------------------------------------------------------------
  section("Server");
  if (serverUrl) {
    const health = await probeHealth(`${serverUrl}/api/health`);
    if (health.status === 200) {
      ok(`reachable at ${serverUrl} (/api/health 200)`);

      // --- Auth (Secure Mode) -------------------------------------------------
      const credential = resolveAuthToken(config);
      if (health.secure) {
        ok("server is in Secure Mode (auth required)");
        if (!credential) {
          bad("server requires auth but no credential is configured", "run `finius setup` to log in");
        } else {
          // Verify the credential actually authenticates against a protected endpoint.
          const authed = await probe(`${serverUrl}/api/meta`, credential);
          if (authed === 200) ok("configured credential authenticates");
          else if (authed === 401) bad("configured credential was rejected (401)", "re-run `finius setup` to refresh it");
          else warn(`couldn't verify credential (/api/meta ${authed})`);
        }
      } else {
        ok("server is open (no auth)");
        if (credential) warn("a credential is configured but the server isn't in Secure Mode", "harmless, but you can clear it");
      }
    } else {
      bad(`not reachable at ${serverUrl} (${health.status})`, "start it with `finius serve`");
    }
  }

  // --- Reminders --------------------------------------------------------------
  log.message(
    pc.bold("Reminders") +
      "\n" +
      pc.dim(
        "• Restart Claude Code after changing settings — env is read at startup.\n" +
          "• Telemetry settings apply to the local CLI, not Claude Code on the web.\n" +
          "• Metrics flush ~10s, events ~5s; give a new session a moment to report."
      )
  );

  outro(problems === 0 ? pc.green("All good.") : pc.red(`${problems} problem(s) found.`));
  return problems === 0 ? 0 : 1;
}

function readSettings(): ClaudeSettings | null {
  return readJson(CLAUDE_SETTINGS_PATH) as ClaudeSettings | null;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    const u = new URL(normalizeUrl(url) || url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function probe(url: string, credential?: string): Promise<number | string> {
  try {
    const headers = credential ? { authorization: `Bearer ${credential}` } : undefined;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) });
    return res.status;
  } catch (err) {
    return (err as Error).name === "TimeoutError" ? "timeout" : "no response";
  }
}

async function probeHealth(url: string): Promise<{ status: number | string; secure: boolean }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const body = res.ok ? ((await res.json().catch(() => ({}))) as { secure?: boolean }) : {};
    return { status: res.status, secure: !!body.secure };
  } catch (err) {
    return { status: (err as Error).name === "TimeoutError" ? "timeout" : "no response", secure: false };
  }
}
