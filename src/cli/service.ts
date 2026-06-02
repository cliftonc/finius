import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FINIUS_HOME } from "./config.js";
import { resolveFiniusBin } from "./install.js";
import { banner, pc } from "./ui.js";

// `finius service <install|start|stop|remove>` — manage Finius as a **systemd** service on Linux.
// systemd is Linux-only; on macOS/Windows this command refuses with a pointer to the relevant native
// supervisor. The unit-rendering is a pure function (`renderServiceUnit`) so it stays unit-testable;
// everything that touches the filesystem or shells out to `systemctl` lives in the action runners.

const SERVICE_NAME = "finius";
const SYSTEM_UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

type Scope = "system" | "user";

function userUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

function unitPath(scope: Scope): string {
  return scope === "system" ? SYSTEM_UNIT_PATH : userUnitPath();
}

export type RenderUnitOptions = {
  scope: Scope;
  // Absolute ExecStart command line, e.g. "/usr/local/bin/finius serve --port 8787".
  execStart: string;
  // FINIUS_HOME (where ~/.finius's config/data live) — pinned so the service never depends on how
  // systemd resolves $HOME.
  finiusHome: string;
  // Directory of the node binary launching this CLI, prepended to PATH so the unit's `env node`
  // shebang resolves even when node came from nvm (which systemd's default PATH doesn't include).
  nodeBinDir: string;
  // System scope only: the account to run as. Omitted for a per-user (`--user`) service.
  user?: string;
};

// Build the systemd unit file. Pure: no IO, fully determined by its options (see service.test.ts).
export function renderServiceUnit(o: RenderUnitOptions): string {
  const path = `${o.nodeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const lines = [
    "[Unit]",
    "Description=Finius — local-first AI coding usage & cost tracker",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple"
  ];
  if (o.scope === "system" && o.user) lines.push(`User=${o.user}`);
  lines.push(
    `Environment=FINIUS_HOME=${o.finiusHome}`,
    `Environment=PATH=${path}`,
    `ExecStart=${o.execStart}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    // A user service hangs off the login session's default target; a system service off multi-user.
    o.scope === "user" ? "WantedBy=default.target" : "WantedBy=multi-user.target",
    ""
  );
  return lines.join("\n");
}

type Flags = { scope?: Scope; port?: number; host?: string; follow?: boolean; lines?: number };

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user") flags.scope = "user";
    else if (arg === "--system") flags.scope = "system";
    else if ((arg === "--port" || arg === "-p") && argv[i + 1]) flags.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) flags.port = Number(arg.slice("--port=".length));
    else if (arg === "--host" && argv[i + 1]) flags.host = argv[++i];
    else if (arg.startsWith("--host=")) flags.host = arg.slice("--host=".length);
    else if (arg === "--follow" || arg === "-f") flags.follow = true;
    else if ((arg === "--lines" || arg === "-n") && argv[i + 1]) flags.lines = Number(argv[++i]);
    else if (arg.startsWith("--lines=")) flags.lines = Number(arg.slice("--lines=".length));
  }
  return flags;
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function notLinux(): number {
  const native = process.platform === "darwin" ? "launchd (launchctl)" : "the platform's native service manager";
  process.stderr.write(
    `${pc.red("finius service")} manages a ${pc.bold("systemd")} unit, which is ${pc.bold("Linux-only")}.\n` +
      `${pc.dim(`On ${process.platform} run \`finius serve\` directly, or wrap it with ${native}.`)}\n`
  );
  return 1;
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// True once `systemctl` is callable — guards against a non-systemd Linux (e.g. Alpine/OpenRC).
function hasSystemctl(): boolean {
  return canRun("systemctl");
}

// journalctl ships with systemd but check independently — `logs` needs it specifically.
function hasJournalctl(): boolean {
  return canRun("journalctl");
}

function canRun(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Run a command inheriting stdio and return its real exit code (not our ok/fail wrapper). Used for the
// read-only passthroughs (`status`, `logs`) where the child's own exit code is meaningful — e.g.
// `systemctl status` exits 3 when the unit is inactive, which is information, not an error to mask.
function runPassthrough(cmd: string, args: string[]): number {
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
    return 0;
  } catch (err) {
    const code = (err as { status?: number }).status;
    return typeof code === "number" ? code : 1;
  }
}

function systemctl(scope: Scope, args: string[], opts: { capture?: boolean } = {}): { ok: boolean; out: string } {
  const full = scope === "user" ? ["--user", ...args] : args;
  try {
    const out = execFileSync("systemctl", full, { encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "ignore"] : "inherit" });
    return { ok: true, out: out ?? "" };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

// A system unit's files (/etc/systemd/system) and `systemctl` calls need root; instruct rather than
// silently escalate. A --user unit needs neither.
function requirePrivilege(scope: Scope, action: string): boolean {
  if (scope === "user" || isRoot()) return true;
  process.stderr.write(
    `${pc.red(`finius service ${action}`)} on a ${pc.bold("system")} service needs root.\n` +
      `${pc.dim(`Re-run with \`sudo finius service ${action}\`, or use a per-user service: \`finius service ${action} --user\`.`)}\n`
  );
  return false;
}

// Which scope an installed service lives in: an existing --user unit wins, else system. An explicit
// flag always overrides (so start/stop/remove can target the right one).
function detectScope(flags: Flags): Scope {
  if (flags.scope) return flags.scope;
  if (existsSync(userUnitPath())) return "user";
  return "system";
}

function serviceHelp(): string {
  const rows: Array<[string, string]> = [
    ["finius service install", "Write + enable the systemd unit, then start it"],
    ["finius service start", "Start the service"],
    ["finius service stop", "Stop the service"],
    ["finius service status", "Show the unit's current state (systemctl status)"],
    ["finius service logs", "Show recent logs; -f to follow (journalctl)"],
    ["finius service remove", "Stop, disable, and delete the unit"]
  ];
  const width = Math.max(...rows.map(([c]) => c.length));
  const body = rows.map(([c, d]) => `  ${pc.cyan(c.padEnd(width))}  ${pc.dim(d)}`).join("\n");
  return (
    `${pc.bold("finius service")} ${pc.dim("— manage Finius as a Linux systemd service")}\n\n` +
    `${body}\n\n` +
    `${pc.dim("Flags:")}\n` +
    `  ${pc.cyan("--user".padEnd(16))}  ${pc.dim("Per-user service (~/.config/systemd/user, no sudo). Default: system-wide (/etc, needs root).")}\n` +
    `  ${pc.cyan("--port N".padEnd(16))}  ${pc.dim("Bind port baked into ExecStart (install only; else taken from config)")}\n` +
    `  ${pc.cyan("--host H".padEnd(16))}  ${pc.dim("Bind host baked into ExecStart (install only; else taken from config)")}\n` +
    `  ${pc.cyan("-f, --follow".padEnd(16))}  ${pc.dim("Stream logs live (logs only)")}\n` +
    `  ${pc.cyan("-n, --lines N".padEnd(16))}  ${pc.dim("Number of log lines to show (logs only; default 200)")}\n`
  );
}

function runInstall(flags: Flags): number {
  const scope: Scope = flags.scope ?? "system";
  if (!requirePrivilege(scope, "install")) return 1;

  const bin = resolveFiniusBin();
  if (!bin) {
    process.stderr.write(
      `${pc.red("finius isn't installed on a stable PATH")} — a service needs a durable binary, not the npx cache.\n` +
        `${pc.dim("Install it globally first: `npm install -g @cliftonc/finius` (or run `finius setup`), then re-run this.")}\n`
    );
    return 1;
  }

  const serveArgs = ["serve", ...(flags.port ? ["--port", String(flags.port)] : []), ...(flags.host ? ["--host", flags.host] : [])];
  const unit = renderServiceUnit({
    scope,
    execStart: `${bin} ${serveArgs.join(" ")}`,
    finiusHome: FINIUS_HOME,
    nodeBinDir: dirname(process.execPath),
    user: scope === "system" ? currentUser() : undefined
  });

  const path = unitPath(scope);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit, "utf8");
  } catch (err) {
    process.stderr.write(`${pc.red(`Could not write ${path}`)}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stdout.write(`${pc.green("✓")} Wrote unit ${pc.dim(path)}\n`);

  if (!hasSystemctl()) {
    process.stdout.write(
      `${pc.yellow("systemctl not found")} — the unit is written but couldn't be enabled.\n` +
        `${pc.dim("This host may not use systemd. Enable it manually with your init system.")}\n`
    );
    return 0;
  }

  const reload = systemctl(scope, ["daemon-reload"]);
  if (!reload.ok) {
    process.stderr.write(`${pc.red("systemctl daemon-reload failed")}: ${reload.out}\n`);
    return 1;
  }
  const enable = systemctl(scope, ["enable", "--now", SERVICE_NAME]);
  if (!enable.ok) {
    process.stderr.write(`${pc.red("systemctl enable --now failed")}: ${enable.out}\n`);
    return 1;
  }

  process.stdout.write(`${pc.green("✓")} Service ${pc.bold(SERVICE_NAME)} enabled and started (${scope}).\n\n`);
  printStatusHints(scope);
  if (scope === "user") {
    process.stdout.write(
      `${pc.dim("Tip: a --user service stops when you log out. To keep it running across logouts:")}\n` +
        `  ${pc.cyan(`sudo loginctl enable-linger ${currentUser()}`)}\n`
    );
  }
  return 0;
}

function runStart(flags: Flags): number {
  const scope = detectScope(flags);
  if (!requirePrivilege(scope, "start")) return 1;
  if (!hasSystemctl()) return noSystemctl();
  const res = systemctl(scope, ["start", SERVICE_NAME]);
  if (!res.ok) return fail("start", res.out);
  process.stdout.write(`${pc.green("✓")} Started ${pc.bold(SERVICE_NAME)} (${scope}).\n`);
  return 0;
}

function runStop(flags: Flags): number {
  const scope = detectScope(flags);
  if (!requirePrivilege(scope, "stop")) return 1;
  if (!hasSystemctl()) return noSystemctl();
  const res = systemctl(scope, ["stop", SERVICE_NAME]);
  if (!res.ok) return fail("stop", res.out);
  process.stdout.write(`${pc.green("✓")} Stopped ${pc.bold(SERVICE_NAME)} (${scope}).\n`);
  return 0;
}

function runRemove(flags: Flags): number {
  const scope = detectScope(flags);
  if (!requirePrivilege(scope, "remove")) return 1;
  const path = unitPath(scope);
  if (!existsSync(path)) {
    process.stdout.write(`${pc.dim(`No ${scope} unit at ${path} — nothing to remove.`)}\n`);
    return 0;
  }
  // disable --now stops + disables in one step; ignore failure (the unit may already be stopped) and
  // proceed to delete the file so removal is idempotent.
  if (hasSystemctl()) systemctl(scope, ["disable", "--now", SERVICE_NAME]);
  try {
    rmSync(path);
  } catch (err) {
    process.stderr.write(`${pc.red(`Could not delete ${path}`)}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (hasSystemctl()) systemctl(scope, ["daemon-reload"]);
  process.stdout.write(`${pc.green("✓")} Removed ${pc.bold(SERVICE_NAME)} (${scope}) and deleted ${pc.dim(path)}.\n`);
  return 0;
}

// Read-only: show the unit's current state. No privilege gate — systemctl shows what the caller may
// see. `--no-pager` so it never blocks on a pager in a non-tty (e.g. CI, ssh -T).
function runStatus(flags: Flags): number {
  const scope = detectScope(flags);
  if (!hasSystemctl()) return noSystemctl();
  const args = [...(scope === "user" ? ["--user"] : []), "--no-pager", "status", SERVICE_NAME];
  return runPassthrough("systemctl", args);
}

// Read-only: tail the journal. Defaults to the last N lines (`--no-pager`); `-f`/`--follow` streams
// until Ctrl-C. Reading a *system* unit's journal may need membership in `systemd-journal`/`adm` (or
// root) — journalctl prints its own notice if the caller can't see everything, so we don't gate it.
function runLogs(flags: Flags): number {
  const scope = detectScope(flags);
  if (!hasJournalctl()) {
    process.stderr.write(`${pc.red("journalctl not found")} — this host doesn't appear to run systemd.\n`);
    return 1;
  }
  const base = [...(scope === "user" ? ["--user"] : []), "-u", SERVICE_NAME];
  const tail = flags.follow ? ["-f"] : ["-n", String(flags.lines ?? 200), "--no-pager"];
  return runPassthrough("journalctl", [...base, ...tail]);
}

function printStatusHints(scope: Scope): void {
  const u = scope === "user" ? " --user" : "";
  process.stdout.write(
    `${pc.dim("Check it:")}\n` +
      `  ${pc.cyan(`finius service status${u}`)}\n` +
      `  ${pc.cyan(`finius service logs -f${u}`)}\n\n`
  );
}

function currentUser(): string {
  return process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || "root";
}

function noSystemctl(): number {
  process.stderr.write(`${pc.red("systemctl not found")} — this host doesn't appear to run systemd.\n`);
  return 1;
}

function fail(action: string, detail: string): number {
  process.stderr.write(`${pc.red(`systemctl ${action} failed`)}: ${detail}\n`);
  return 1;
}

export async function runService(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "help" || action === "--help" || action === "-h") {
    banner("service");
    process.stdout.write(`\n${serviceHelp()}`);
    return action ? 0 : 1;
  }
  if (!isLinux()) return notLinux();

  const flags = parseFlags(rest);
  switch (action) {
    case "install":
      return runInstall(flags);
    case "start":
      return runStart(flags);
    case "stop":
      return runStop(flags);
    case "status":
      return runStatus(flags);
    case "logs":
      return runLogs(flags);
    case "remove":
    case "uninstall":
      return runRemove(flags);
    default:
      process.stderr.write(`${pc.red(`Unknown service action: ${action}`)}\n\n${serviceHelp()}`);
      return 1;
  }
}
