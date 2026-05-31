import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { EventBus } from "../src/server/events";
import { SqliteStorageAdapter } from "../src/server/storage/sqlite";
import { otlpMetricBatch } from "./fixtures";

let storage: SqliteStorageAdapter | null = null;

afterEach(() => {
  storage?.close();
  storage = null;
});

describe("API", () => {
  it("creates sessions and emits ingest events after OTLP metrics", async () => {
    storage = new SqliteStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
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

  it("returns stable empty dashboard responses", async () => {
    storage = new SqliteStorageAdapter(join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite"));
    const app = createApp({ storage, events: new EventBus() });

    const summary = await (await app.request("/api/metrics/summary")).json();
    const timeseries = await (await app.request("/api/metrics/timeseries")).json();

    expect(summary).toMatchObject({ totalCost: 0, totalTokens: 0, sessionCount: 0 });
    expect(timeseries).toEqual([]);
  });
});
