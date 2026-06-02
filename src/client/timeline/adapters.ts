import type { BaseMessage } from "./types";
import { parseTranscript as parseClaude } from "./claudeJsonl";
import { isCodexRollout, parseCodexRollout } from "./codexRollout";
import { isCopilotAgent, parseCopilotAgent } from "./copilotAgent";
import { isVscodeChat, parseVscodeChat } from "./vscodeChat";

// One place that knows every transcript shape the timeline can render. Each agent's parser module owns
// its own `detect` + `parse` (so the format knowledge stays in one file); this registry just composes
// them. To add a new coding agent, write its `<agent>.ts` adapter and add one row here.
//
// Order matters: the first adapter whose `detect` matches wins, so put the more specific sniffs first.
// Claude is the historical default and has no reliable positive marker, so it's the final fallback.
export interface TranscriptAdapter {
  id: string;
  detect: (ndjson: string) => boolean;
  parse: (ndjson: string) => BaseMessage[];
}

const ADAPTERS: TranscriptAdapter[] = [
  { id: "codex", detect: isCodexRollout, parse: parseCodexRollout },
  { id: "copilot-agent", detect: isCopilotAgent, parse: parseCopilotAgent },
  { id: "vscode-chat", detect: isVscodeChat, parse: parseVscodeChat }
];

// Pick the adapter by transcript shape and parse to the shared BaseMessage[] timeline model.
export function parseTranscriptToMessages(ndjson: string): BaseMessage[] {
  const adapter = ADAPTERS.find((a) => a.detect(ndjson));
  return adapter ? adapter.parse(ndjson) : parseClaude(ndjson);
}
