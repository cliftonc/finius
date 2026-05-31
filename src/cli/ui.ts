import { cancel, isCancel } from "@clack/prompts";
import { banner, panel, pc } from "../branding.js";

// CLI-facing presentation: the shared brand banner (re-exported from ../branding) plus a guard that
// turns @clack/prompts' cancel sentinel (Ctrl-C / ESC) into a clean exit, so callers can treat prompt
// results as plain values.

// Unwrap a @clack/prompts result, aborting the whole command if the user cancelled. This lets the
// call sites read `const url = ask(await text(...))` without sprinkling isCancel checks everywhere.
export function ask<T>(value: T | symbol, message = "Cancelled."): T {
  if (isCancel(value)) {
    cancel(message);
    process.exit(1);
  }
  return value as T;
}

export { banner, panel, pc };
