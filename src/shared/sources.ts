// Central provider/source registry — the single source of truth for every source string finius
// emits or stores, plus each provider's preferred signal (the precedence input). Shared by both
// src/server and src/cli (like src/shared/api-types.ts). Source strings here are persisted in
// existing DBs and asserted in tests, so they must never change — this only centralizes them.

export type ProviderId = "claude" | "copilot" | "codex" | "manual";
export type Signal = "otlp_metrics" | "jsonl";

export const PROVIDERS: Record<ProviderId, { preferredSignal: Signal }> = {
  claude: { preferredSignal: "otlp_metrics" },
  copilot: { preferredSignal: "otlp_metrics" },
  codex: { preferredSignal: "jsonl" }, // Codex OTel is logs-only, never aggregated
  manual: { preferredSignal: "jsonl" }
};

type SourceEntry = {
  id: string;
  provider: ProviderId;
  signal: Signal;
  serviceNames?: readonly string[];
};

// A source is `primary` (counts toward dashboards) iff its signal === its provider's preferredSignal.
export const SOURCES = [
  // Claude
  { id: "claude-code", provider: "claude", signal: "otlp_metrics", serviceNames: ["claude-code"] }, // primary
  { id: "claude-code-jsonl", provider: "claude", signal: "jsonl" }, // comparison
  // Copilot: github-copilot = the Copilot CLI; copilot-chat = VS Code Chat OTel; the *-jsonl = VS Code Chat transcript
  { id: "github-copilot", provider: "copilot", signal: "otlp_metrics", serviceNames: ["github-copilot", "github.copilot"] }, // primary (CLI)
  { id: "copilot-chat", provider: "copilot", signal: "otlp_metrics", serviceNames: ["copilot-chat", "github.copilot-chat"] }, // primary (VS Code OTel)
  { id: "copilot-vscode-jsonl", provider: "copilot", signal: "jsonl" }, // comparison (VS Code transcript)
  // Codex (OTel is logs-only → never aggregated, so JSONL is preferred)
  { id: "codex-cli-jsonl", provider: "codex", signal: "jsonl" }, // primary
  // Ad-hoc uploads
  { id: "manual-jsonl", provider: "manual", signal: "jsonl" } // primary
] as const satisfies readonly SourceEntry[];

export type SourceId = (typeof SOURCES)[number]["id"];

// Named constants for the common source ids (the registry table above stays the source of truth).
export const CLAUDE_OTEL_SOURCE = "claude-code";
export const CLAUDE_JSONL_SOURCE = "claude-code-jsonl";
export const COPILOT_CLI_SOURCE = "github-copilot";
export const COPILOT_CHAT_SOURCE = "copilot-chat";
export const COPILOT_VSCODE_SOURCE = "copilot-vscode-jsonl";
export const CODEX_SOURCE = "codex-cli-jsonl";
export const MANUAL_JSONL_SOURCE = "manual-jsonl";

// Resolves an OTLP `service.name` to a source id via the registry's serviceNames aliases. Falls
// back to the Claude OTel source (the historical default in sourceFromAttributes).
export function sourceFromServiceName(serviceName: string | null | undefined): string {
  if (serviceName) {
    for (const source of SOURCES as readonly SourceEntry[]) {
      if (source.serviceNames?.includes(serviceName)) return source.id;
    }
  }
  return CLAUDE_OTEL_SOURCE;
}

// The provider that owns a source id; unknown ids fall back to "manual".
export function providerOfSource(sourceId: string): ProviderId {
  for (const source of SOURCES) {
    if (source.id === sourceId) return source.provider;
  }
  return "manual";
}

// True iff the source's signal is its provider's preferred signal (i.e. it counts toward
// dashboards). Unknown sources are treated as primary. (Used by a later step; defined now.)
export function isPrimarySource(sourceId: string): boolean {
  for (const source of SOURCES) {
    if (source.id === sourceId) return source.signal === PROVIDERS[source.provider].preferredSignal;
  }
  return true;
}
