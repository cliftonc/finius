// Pure helpers for merging Finius config into OpenAI Codex's ~/.codex/config.toml. Like
// claude-settings.ts these are side-effect-free (no fs) so they unit-test cleanly; codex.ts does the
// read/write. Codex's config is TOML and we ship no TOML parser, so Finius owns a single clearly
// delimited block appended at EOF — valid TOML because it only opens fresh top-level tables. Re-running
// setup replaces that block in place; existing user tables are never touched, and we refuse to add a
// table the user already defines (so we can never produce a duplicate-key parse error).

export const CODEX_HOOK_EVENT = "Stop";
const BLOCK_BEGIN = "# >>> finius (managed — safe to delete this whole block) >>>";
const BLOCK_END = "# <<< finius (managed) <<<";

export type CodexBlockOptions = {
  // `finius codex-hook` command to run on the Codex Stop hook (transcript upload).
  hookCommand?: string;
  // OTLP/JSON logs endpoint for Codex's [otel] exporter (Codex's native telemetry is logs-only).
  otlpLogsEndpoint?: string;
  // When the Finius server runs in Secure Mode, the bearer token the exporter must send. Codex's
  // otlp-http exporter supports a `headers` table, so we emit `Authorization = "Bearer <token>"`
  // alongside the endpoint (mirrors the OTEL_EXPORTER_OTLP_HEADERS we set for Claude Code).
  authToken?: string;
};

export type CodexMergeResult = {
  toml: string;
  changed: boolean;
  addedHook: boolean;
  addedOtel: boolean;
  // True when we declined to add because the user already defines that table themselves.
  skippedHook: boolean;
  skippedOtel: boolean;
};

export function withFiniusCodexBlock(toml: string, opts: CodexBlockOptions): CodexMergeResult {
  const outside = stripFiniusBlock(toml);
  const hasUserHooks = /^\s*\[\[?\s*hooks(\.|\s*\])/m.test(outside);
  const hasUserOtel = /^\s*\[\s*otel\s*\]/m.test(outside);

  const wantHook = !!opts.hookCommand;
  const wantOtel = !!opts.otlpLogsEndpoint;
  const addedHook = wantHook && !hasUserHooks;
  const addedOtel = wantOtel && !hasUserOtel;

  const parts: string[] = [];
  if (addedHook) {
    parts.push(
      `[[hooks.${CODEX_HOOK_EVENT}]]`,
      `[[hooks.${CODEX_HOOK_EVENT}.hooks]]`,
      `type = "command"`,
      `command = ${tomlString(opts.hookCommand as string)}`,
      ""
    );
  }
  if (addedOtel) {
    // Always carry X-Finius-Client=codex so finius's OTLP traffic is identifiable on the wire; add the
    // bearer token only in Secure Mode. (X-Finius-Client is a valid TOML bare key — letters + dashes.)
    const headerEntries = [`X-Finius-Client = ${tomlString("codex")}`];
    if (opts.authToken) headerEntries.push(`Authorization = ${tomlString(`Bearer ${opts.authToken}`)}`);
    const headers = `, headers = { ${headerEntries.join(", ")} }`;
    parts.push(
      "[otel]",
      `environment = "finius"`,
      "log_user_prompt = false",
      `exporter = { otlp-http = { endpoint = ${tomlString(opts.otlpLogsEndpoint as string)}, protocol = "json"${headers} } }`,
      ""
    );
  }

  const result: CodexMergeResult = {
    toml: outside,
    changed: outside !== toml,
    addedHook,
    addedOtel,
    skippedHook: wantHook && hasUserHooks,
    skippedOtel: wantOtel && hasUserOtel
  };
  if (parts.length === 0) return result;

  const block = [BLOCK_BEGIN, ...parts, BLOCK_END].join("\n");
  const base = outside.replace(/\s*$/, "");
  result.toml = base.length ? `${base}\n\n${block}\n` : `${block}\n`;
  result.changed = true;
  return result;
}

// Remove a previously-written Finius block (between the markers), leaving the rest untouched.
export function stripFiniusBlock(toml: string): string {
  const begin = toml.indexOf(BLOCK_BEGIN);
  if (begin === -1) return toml;
  const endIdx = toml.indexOf(BLOCK_END, begin);
  const before = toml.slice(0, begin).replace(/\s*$/, "");
  const after = endIdx === -1 ? "" : toml.slice(endIdx + BLOCK_END.length).replace(/^\s*\n/, "");
  const joined = after ? `${before}\n${after}` : `${before}\n`;
  return joined.replace(/\n{3,}/g, "\n\n");
}

export function hasFiniusCodexBlock(toml: string): boolean {
  return toml.includes(BLOCK_BEGIN);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
