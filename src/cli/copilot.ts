import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { COPILOT_VSCODE_SOURCE as COPILOT_VSCODE_SOURCE_ID } from "../shared/sources.js";
import { walkFiles } from "./backfill.js";

const VSCODE_USER_DIR = join(homedir(), "Library", "Application Support", "Code", "User");
const GLOBAL_EMPTY_WINDOW_SESSIONS = join(VSCODE_USER_DIR, "globalStorage", "emptyWindowChatSessions");
const WORKSPACE_STORAGE_DIR = join(VSCODE_USER_DIR, "workspaceStorage");

export const COPILOT_VSCODE_SOURCE = COPILOT_VSCODE_SOURCE_ID;

export function findCopilotVsCodeTranscripts(): string[] {
  const files = new Set<string>();
  for (const file of walkFiles(GLOBAL_EMPTY_WINDOW_SESSIONS, (name) => name.endsWith(".jsonl"))) files.add(file);
  for (const file of walkFiles(WORKSPACE_STORAGE_DIR, (name) => name.endsWith(".jsonl"))) {
    if (file.includes(`${join("GitHub.copilot-chat", "transcripts")}${"/"}`) || file.includes(`${join("chatSessions")}${"/"}`)) files.add(file);
  }
  return [...files].filter((file) => existsSync(file)).sort();
}

export function copilotSessionIdFromPath(path: string): string | undefined {
  const name = basename(path);
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : undefined;
}
