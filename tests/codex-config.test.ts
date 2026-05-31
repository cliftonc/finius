import { describe, expect, it } from "vitest";
import { hasFiniusCodexBlock, stripFiniusBlock, withFiniusCodexBlock } from "../src/cli/codex-config.js";

const EXISTING = `model = "gpt-5.5"
notify = ["x", "turn-ended"]

[projects."/Users/me/app"]
trust_level = "trusted"
`;

describe("withFiniusCodexBlock", () => {
  it("appends a managed block with the Stop hook and [otel] exporter", () => {
    const { toml, addedHook, addedOtel, changed } = withFiniusCodexBlock(EXISTING, {
      hookCommand: "finius codex-hook",
      otlpLogsEndpoint: "http://localhost:8787/otlp/v1/logs"
    });
    expect(changed).toBe(true);
    expect(addedHook).toBe(true);
    expect(addedOtel).toBe(true);
    expect(toml).toContain("[[hooks.Stop]]");
    expect(toml).toContain("[[hooks.Stop.hooks]]");
    expect(toml).toContain('command = "finius codex-hook"');
    expect(toml).toContain("[otel]");
    expect(toml).toContain('endpoint = "http://localhost:8787/otlp/v1/logs"');
    // preserves the user's existing config
    expect(toml).toContain('model = "gpt-5.5"');
    expect(toml).toContain('[projects."/Users/me/app"]');
    expect(hasFiniusCodexBlock(toml)).toBe(true);
  });

  it("adds an Authorization header to the exporter when an auth token is given (Secure Mode)", () => {
    const { toml } = withFiniusCodexBlock(EXISTING, {
      otlpLogsEndpoint: "http://localhost:8787/otlp/v1/logs",
      authToken: "deadbeef-token"
    });
    expect(toml).toContain('headers = { Authorization = "Bearer deadbeef-token" }');
    expect(toml).toContain('endpoint = "http://localhost:8787/otlp/v1/logs"');
  });

  it("omits the headers table entirely when no auth token is given (open mode)", () => {
    const { toml } = withFiniusCodexBlock(EXISTING, {
      otlpLogsEndpoint: "http://localhost:8787/otlp/v1/logs"
    });
    expect(toml).not.toContain("headers");
    expect(toml).toContain('protocol = "json" } }');
  });

  it("is idempotent — re-applying replaces the block rather than duplicating it", () => {
    const once = withFiniusCodexBlock(EXISTING, { hookCommand: "finius codex-hook" }).toml;
    const twice = withFiniusCodexBlock(once, { hookCommand: "finius codex-hook" }).toml;
    expect(twice).toBe(once);
    expect((twice.match(/\[\[hooks\.Stop\]\]/g) ?? []).length).toBe(1);
  });

  it("refuses to add tables the user already defines", () => {
    const withOtel = `${EXISTING}\n[otel]\nenvironment = "prod"\n`;
    const result = withFiniusCodexBlock(withOtel, {
      hookCommand: "finius codex-hook",
      otlpLogsEndpoint: "http://localhost:8787/otlp/v1/logs"
    });
    expect(result.addedOtel).toBe(false);
    expect(result.skippedOtel).toBe(true);
    expect(result.addedHook).toBe(true);
    // the user's own [otel] is untouched and not duplicated
    expect((result.toml.match(/\[otel\]/g) ?? []).length).toBe(1);
    expect(result.toml).toContain('environment = "prod"');
  });

  it("stripFiniusBlock removes the managed block and leaves user config intact", () => {
    const added = withFiniusCodexBlock(EXISTING, { hookCommand: "finius codex-hook" }).toml;
    const stripped = stripFiniusBlock(added);
    expect(hasFiniusCodexBlock(stripped)).toBe(false);
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).not.toContain("[[hooks.Stop]]");
  });
});
