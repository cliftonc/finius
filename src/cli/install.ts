import { execSync } from "node:child_process";

// Is the `finius` command resolvable on PATH? (i.e. installed globally, not just running via npx)
export function isFiniusOnPath(): boolean {
  const probe = process.platform === "win32" ? "where finius" : "command -v finius";
  try {
    execSync(probe, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Install finius globally so the bare `finius` command works everywhere (including from Claude Code
// hooks). Returns true once `finius` is on PATH. Output is streamed so the user sees npm's progress.
export function installGlobally(): boolean {
  try {
    execSync("npm install -g @cliftonc/finius", { stdio: "inherit" });
  } catch {
    return false;
  }
  return isFiniusOnPath();
}
