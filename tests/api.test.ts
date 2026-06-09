import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { EventBus } from "../src/server/events";
import { DrizzleStorageAdapter } from "../src/server/storage/adapter";
import { copilotTraceBatch, otlpMetricBatch } from "./fixtures";

const require = createRequire(import.meta.url);
const { ServiceClientType, getExportRequestProto } = require("@opentelemetry/otlp-proto-exporter-base") as {
  ServiceClientType: { SPANS: number };
  getExportRequestProto: (type: number) => { encode: (value: unknown) => { finish: () => Uint8Array } };
};

let storage: DrizzleStorageAdapter | null = null;

afterEach(() => {
  storage?.close();
  storage = null;
});

describe("API", () => {
  it("creates sessions and emits ingest events after OTLP metrics", async () => {
    storage = await DrizzleStorageAdapter.open(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    const events = new EventBus();
    const seen: unknown[] = [];
    events.subscribe((event, data) => seen.push({ event, data }));
    const app = createApp({ storage, events });

    const response = await app.request("/otlp/v1/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(otlpMetricBatch())
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ duplicate: false, points: 3 });
    expect(seen).toHaveLength(1);

    const sessions = await app.request("/api/sessions");
    expect(await sessions.json()).toHaveLength(1);
  });

  it("accepts OTLP/protobuf trace requests", async () => {
    storage = await DrizzleStorageAdapter.open(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    const app = createApp({ storage, events: new EventBus() });
    const proto = getExportRequestProto(ServiceClientType.SPANS);
    const body = Buffer.from(proto.encode(copilotTraceBatch()).finish());

    const response = await app.request("/otlp/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: false, spans: 2 });
    const summary = await (await app.request("/api/metrics/summary?source=github-copilot")).json();
    expect(summary).toMatchObject({ inputTokens: 1000, outputTokens: 250, cacheReadTokens: 100 });
  });

  it("uses Finius identity headers when Copilot traces omit user identity", async () => {
    storage = await DrizzleStorageAdapter.open(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    const app = createApp({ storage, events: new EventBus() });

    const response = await app.request("/otlp/v1/traces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-finius-user-email": encodeURIComponent("dev@example.com"),
        "x-finius-github-login": "devhandle",
        "x-finius-display-name": encodeURIComponent("Dev User")
      },
      body: JSON.stringify(copilotTraceBatch("header-user-session"))
    });

    expect(response.status).toBe(200);
    const sessions = (await (await app.request("/api/sessions")).json()) as Array<{ userEmail: string | null; githubLogin: string | null; displayName: string | null }>;
    expect(sessions[0]).toMatchObject({
      userEmail: "dev@example.com",
      githubLogin: "devhandle",
      displayName: "Dev User"
    });
  });

  it("returns stable empty dashboard responses", async () => {
    storage = await DrizzleStorageAdapter.open(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    const app = createApp({ storage, events: new EventBus() });

    const summary = await (await app.request("/api/metrics/summary")).json();
    const timeseries = await (await app.request("/api/metrics/timeseries")).json();

    expect(summary).toMatchObject({ totalCost: 0, totalTokens: 0, sessionCount: 0 });
    expect(timeseries).toEqual([]);
  });

  it("imports a transcript file and serves it back over the API", async () => {
    storage = await DrizzleStorageAdapter.open(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    const app = createApp({ storage, events: new EventBus() });
    const content = '{"session_id":"s1","message":{"usage":{"input_tokens":10,"output_tokens":2}}}';

    const imported = await app.request("/api/import/jsonl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, source: "manual-jsonl", sessionId: "s1" })
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ queued: true });

    // Uploads are processed on a background queue; wait for it to drain before reading back.
    await storage.settleIngest();

    const sessions = (await (await app.request("/api/sessions")).json()) as Array<{ id: number; sessionId: string }>;
    const session = sessions.find((s) => s.sessionId === "s1")!;

    const info = await app.request(`/api/sessions/${session.id}/transcript/info`);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ source: "manual-jsonl", lineCount: 1 });

    const transcript = await app.request(`/api/sessions/${session.id}/transcript`);
    expect(transcript.status).toBe(200);
    expect(await transcript.text()).toBe(content);

    // A session with no stored transcript returns 404 for both endpoints.
    expect((await app.request("/api/sessions/999999/transcript")).status).toBe(404);
    expect((await app.request("/api/sessions/999999/transcript/info")).status).toBe(404);
  });

  it("guards the prune endpoint with a bearer token and fails closed without one", async () => {
    storage = await DrizzleStorageAdapter.open(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));

    // No token configured -> endpoint disabled.
    const closed = createApp({ storage, events: new EventBus() });
    expect((await closed.request("/api/maintenance/prune-raw-batches", { method: "POST" })).status).toBe(503);

    // Token configured -> requires a matching bearer.
    const app = createApp({ storage, events: new EventBus(), cronToken: "secret" });
    expect((await app.request("/api/maintenance/prune-raw-batches", { method: "POST" })).status).toBe(401);
    const bad = await app.request("/api/maintenance/prune-raw-batches", {
      method: "POST",
      headers: { authorization: "Bearer wrong" }
    });
    expect(bad.status).toBe(401);
    const ok = await app.request("/api/maintenance/prune-raw-batches?olderThanDays=0", {
      method: "POST",
      headers: { authorization: "Bearer secret" }
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ deleted: expect.any(Number), olderThanDays: 0 });
  });

  it("prunes only raw batches older than the cutoff", async () => {
    storage = await DrizzleStorageAdapter.open(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));

    // Nothing is older than 7 days, so a default prune deletes nothing.
    const keep = await storage.pruneRawBatches(Date.now() - 7 * 86_400_000);
    expect(keep.deleted).toBe(0);

    // Everything is older than "now", so a zero-day cutoff deletes the batch we just ingested.
    const drop = await storage.pruneRawBatches(Date.now() + 1);
    expect(drop.deleted).toBe(1);
  });
});
