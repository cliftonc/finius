import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// `npx @cliftonc/finius` runs the CLI from an ephemeral cache (~/.npm/_npx/<hash>/) and PREPENDS that
// cache's node_modules/.bin to the child's PATH. A naive `command -v finius` therefore resolves to the
// throwaway npx shim and reports finius as "on PATH" even though nothing durable is installed — and the
// shim vanishes the moment npx exits. Anything under an `_npx` cache must not count as a real install.
const NPX_CACHE = /[\\/]_npx[\\/]/;

// Resolve where `finius` lives on PATH (first match), or null if it isn't resolvable.
function resolveFinius(): string | null {
  const probe = process.platform === "win32" ? "where finius" : "command -v finius";
  try {
    const out = execSync(probe, { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
    return out || null;
  } catch {
    return null;
  }
}

// Is a *durable* `finius` resolvable on PATH? (i.e. a real install, not the ephemeral npx shim.)
export function isFiniusOnPath(): boolean {
  const resolved = resolveFinius();
  return resolved != null && !NPX_CACHE.test(resolved);
}

// The npm global bin directory (where `npm i -g` drops the `finius` symlink/shim).
function globalBinDir(): string | null {
  try {
    const prefix = execSync("npm prefix -g", { encoding: "utf8" }).trim();
    if (!prefix) return null;
    // Windows places bins directly under the prefix; POSIX under <prefix>/bin.
    return process.platform === "win32" ? prefix : join(prefix, "bin");
  } catch {
    return null;
  }
}

// Is finius installed in the npm global prefix? This is the reliable signal during an `npx` run: the
// npx shim shadows the global one in PATH order, so a path probe can't see the global install we just
// made — but its presence in the global bin dir is what survives once npx exits.
export function isFiniusGloballyInstalled(): boolean {
  const dir = globalBinDir();
  if (!dir) return false;
  const bin = process.platform === "win32" ? "finius.cmd" : "finius";
  return existsSync(join(dir, bin));
}

// Install finius globally so the bare `finius` command works everywhere (including from Claude Code
// hooks). Returns true once finius is in the npm global prefix. Output is streamed so the user sees
// npm's progress. (We check the global prefix rather than PATH because, under npx, the npx shim
// shadows the freshly-installed global binary — a PATH probe would falsely report failure.)
export function installGlobally(): boolean {
  try {
    execSync("npm install -g @cliftonc/finius", { stdio: "inherit" });
  } catch {
    return false;
  }
  return isFiniusGloballyInstalled();
}
