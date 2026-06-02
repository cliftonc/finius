import { describe, expect, it } from "vitest";
import {
  type ClaudeSettings,
  TELEMETRY_HOOK_EVENTS,
  withFiniusHook,
  withTelemetryEnv
} from "../src/cli/claude-settings.js";
import { generatePassword } from "../src/cli/password.js";

const HOOK_CMD = '"/usr/bin/node" "/opt/node_modules/finius/dist/cli/index.js" hook';

describe("withTelemetryEnv", () => {
  it("adds OTLP env vars pointing at the server while preserving existing env", () => {
    const settings: ClaudeSettings = { env: { EXISTING: "keep" } };
    withTelemetryEnv(settings, "http://localhost:8787");

    expect(settings.env?.EXISTING).toBe("keep");
    expect(settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    // Pinned so an inherited OTEL_SERVICE_NAME (e.g. the Copilot setup's github-copilot) can't mislabel it.
    expect(settings.env?.OTEL_SERVICE_NAME).toBe("claude-code");
    expect(settings.env?.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe("http://localhost:8787/otlp/v1/metrics");
    expect(settings.env?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("http://localhost:8787/otlp/v1/logs");
    // Generic protocol + fast flush intervals so usage shows up quickly and SDKs that ignore the
    // per-signal protocol keys still send JSON.
    expect(settings.env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
    expect(settings.env?.OTEL_METRIC_EXPORT_INTERVAL).toBe("10000");
    expect(settings.env?.OTEL_LOGS_EXPORT_INTERVAL).toBe("5000");
  });

  it("works when no env block exists yet and leaves other keys untouched", () => {
    const settings: ClaudeSettings = { model: "opus" };
    withTelemetryEnv(settings, "http://example.com:9999");

    expect(settings.model).toBe("opus");
    expect(settings.env?.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe("http://example.com:9999/otlp/v1/metrics");
  });

  it("always tags traffic with X-Finius-Client and appends the Authorization header in Secure Mode", () => {
    const settings: ClaudeSettings = {};
    withTelemetryEnv(settings, "http://localhost:8787", "abc123");
    expect(settings.env?.OTEL_EXPORTER_OTLP_HEADERS).toBe("X-Finius-Client=claude-code,Authorization=Bearer abc123");
  });

  it("keeps the X-Finius-Client marker (and clears a stale token) when no token is given", () => {
    const settings: ClaudeSettings = { env: { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer old" } };
    withTelemetryEnv(settings, "http://localhost:8787");
    expect(settings.env?.OTEL_EXPORTER_OTLP_HEADERS).toBe("X-Finius-Client=claude-code");
  });
});

describe("generatePassword", () => {
  it("produces three hyphen-joined lowercase words", () => {
    const pw = generatePassword();
    expect(pw).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  it("is not constant across calls", () => {
    const set = new Set(Array.from({ length: 8 }, () => generatePassword()));
    expect(set.size).toBeGreaterThan(1);
  });
});

describe("withFiniusHook", () => {
  it("installs the hook for every telemetry event", () => {
    const settings: ClaudeSettings = {};
    withFiniusHook(settings, HOOK_CMD);

    for (const event of TELEMETRY_HOOK_EVENTS) {
      const groups = settings.hooks?.[event] ?? [];
      expect(groups).toHaveLength(1);
      expect(groups[0].hooks[0]).toMatchObject({ type: "command", command: HOOK_CMD });
    }
  });

  it("preserves unrelated hooks and replaces a stale finius hook", () => {
    const settings: ClaudeSettings = {
      hooks: {
        SessionEnd: [
          { hooks: [{ type: "command", command: "echo unrelated" }] },
          { hooks: [{ type: "command", command: "node /old/finius/index.js hook" }] }
        ]
      }
    };
    withFiniusHook(settings, HOOK_CMD);

    const groups = settings.hooks?.SessionEnd ?? [];
    expect(groups).toHaveLength(2); // unrelated + the single new finius hook
    expect(groups.some((g) => g.hooks.some((h) => h.command === "echo unrelated"))).toBe(true);
    expect(groups.some((g) => g.hooks.some((h) => h.command.includes("/old/finius")))).toBe(false);
    expect(groups.filter((g) => g.hooks.some((h) => h.command.includes("finius")))).toHaveLength(1);
  });

  it("is idempotent across repeated runs", () => {
    const settings: ClaudeSettings = {};
    withFiniusHook(settings, HOOK_CMD);
    withFiniusHook(settings, HOOK_CMD);
    withFiniusHook(settings, HOOK_CMD);

    for (const event of TELEMETRY_HOOK_EVENTS) {
      expect(settings.hooks?.[event]).toHaveLength(1);
    }
  });

  it("dedupes the bare `finius hook` command too (global-install path)", () => {
    const settings: ClaudeSettings = {};
    withFiniusHook(settings, "finius hook");
    withFiniusHook(settings, "finius hook");

    for (const event of TELEMETRY_HOOK_EVENTS) {
      const groups = settings.hooks?.[event] ?? [];
      expect(groups).toHaveLength(1);
      expect(groups[0].hooks[0].command).toBe("finius hook");
    }
  });
});
