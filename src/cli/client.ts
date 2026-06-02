import { createRequire } from "node:module";

// Identifies finius-originated traffic on the wire (so it's filterable at a reverse proxy or in the
// server) — see also the OTLP `X-Finius-Client` headers written by claude-settings.ts / codex-config.ts.
// The transcript-upload POSTs are sent by *our* fetch, so here we can stamp both the header and a real
// User-Agent. Value `hook` marks the upload channel (vs `claude-code`/`codex` for the agents' OTLP).
export const FINIUS_CLIENT_HEADER = "x-finius-client";

const req = createRequire(import.meta.url);

// The published package version, read from package.json (one dir above dist/cli or src/cli). Best-effort
// — a missing/garbled file just yields 0.0.0 rather than throwing in a hook that must never fail.
export function finiusVersion(): string {
  try {
    return (req("../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Headers for finius's transcript-upload requests (`/api/import/{claude-hook,jsonl}`). Always tags the
// request as finius traffic (header + User-Agent) so it's identifiable even in open mode; the bearer
// token is added only in Secure Mode.
export function uploadHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [FINIUS_CLIENT_HEADER]: "hook",
    "user-agent": `finius-hook/${finiusVersion()}`
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return headers;
}
