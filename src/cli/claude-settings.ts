// Pure helpers for merging Finius configuration into Claude Code's ~/.claude/settings.json.
// Kept side-effect-free (no fs) so they're easy to unit test; setup.ts handles the actual read/write.

export type HookCommand = { type: "command"; command: string; timeout?: number };
export type HookGroup = { matcher?: string; hooks: HookCommand[] };
export type ClaudeSettings = {
  env?: Record<string, string>;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
};

// Hook events that upload the session transcript. SessionEnd covers /clear and exit; PreCompact
// captures the full transcript before a compaction shrinks the context window.
export const TELEMETRY_HOOK_EVENTS = ["SessionEnd", "PreCompact"] as const;
export const HOOK_TIMEOUT_SECONDS = 60;

// Substring used to recognize (and replace) a previously-installed Finius hook. The package is named
// "finius" and is virtually always installed under a path containing it, so this reliably matches our
// own hook command without touching unrelated user hooks.
const FINIUS_MARKER = "finius";

// Point Claude Code's OTLP exporters at the given Finius server. Preserves any existing env vars.
// When `authToken` is set (Secure Mode), also send it on every OTLP export via the standard
// Authorization header; when absent, strip any header we previously wrote so toggling auth off cleans
// up. Tokens are URL-safe hex, so the single space in "Bearer " is the only special char and the OTel
// JS header parser (comma/equals-delimited key=value) preserves it.
export function withTelemetryEnv(settings: ClaudeSettings, serverUrl: string, authToken?: string): ClaudeSettings {
  settings.env = {
    ...settings.env,
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    // Finius ingests OTLP/JSON. Set both the generic and per-signal protocol keys — some OTel SDK
    // versions only read the generic one, and its default (http/protobuf) would be rejected.
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${serverUrl}/otlp/v1/metrics`,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${serverUrl}/otlp/v1/logs`,
    // Flush quickly so usage shows up in seconds rather than the 60s/5s defaults.
    OTEL_METRIC_EXPORT_INTERVAL: "10000",
    OTEL_LOGS_EXPORT_INTERVAL: "5000"
  };
  if (authToken) {
    settings.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${authToken}`;
  } else {
    delete settings.env.OTEL_EXPORTER_OTLP_HEADERS;
  }
  return settings;
}

// Install the Finius transcript-upload hook for each telemetry event. Any prior Finius hook group is
// dropped first so re-running setup never duplicates the entry; unrelated user hooks are preserved.
export function withFiniusHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const group: HookGroup = { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] };
  const hooks = settings.hooks ?? (settings.hooks = {});
  for (const event of TELEMETRY_HOOK_EVENTS) {
    const kept = (hooks[event] ?? []).filter((g) => !isFiniusGroup(g));
    hooks[event] = [...kept, group];
  }
  return settings;
}

function isFiniusGroup(group: HookGroup): boolean {
  return group.hooks?.some((h) => h.command?.includes(FINIUS_MARKER)) ?? false;
}
