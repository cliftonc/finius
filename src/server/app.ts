import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "./events.js";
import type { Granularity, StorageAdapter, SummaryFilters } from "./types.js";

const GRANULARITIES: Granularity[] = ["minute", "five_minute", "quarter_hour", "hour", "day", "week"];

type AppOptions = {
  storage: StorageAdapter;
  events: EventBus;
  // Bearer token required to call maintenance endpoints. When unset, those endpoints are disabled
  // (fail closed) rather than left open.
  cronToken?: string;
  // Default retention window (days) for the raw-batch prune endpoint.
  rawRetentionDays?: number;
};

export function createApp({ storage, events, cronToken, rawRetentionDays = 7 }: AppOptions) {
  const app = new Hono();

  app.use("*", cors());

  app.get("/api/health", (c) => c.json({ ok: true, now: Date.now() }));

  // Cron-driven cleanup of old raw_batches. Secured by a bearer token; fails closed when no token
  // is configured. Wire a cron to: curl -X POST -H "Authorization: Bearer $FINIUS_CRON_TOKEN" …
  app.post("/api/maintenance/prune-raw-batches", async (c) => {
    if (!cronToken) return c.json({ error: "maintenance endpoints are disabled (set FINIUS_CRON_TOKEN)" }, 503);
    if (!timingSafeEqualStr(bearerToken(c.req.header("authorization")), cronToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const days = Number(c.req.query("olderThanDays") ?? rawRetentionDays);
    const olderThanDays = Number.isFinite(days) && days >= 0 ? days : rawRetentionDays;
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const result = await storage.pruneRawBatches(cutoff);
    return c.json({ ...result, olderThanDays, cutoff });
  });

  app.post("/otlp/v1/metrics", async (c) => {
    const body = await c.req.json();
    const result = await storage.ingestOtelMetrics(body);
    if (!result.duplicate) events.publish("ingest", { signal: "metrics", ...result });
    return c.json(result);
  });

  app.post("/otlp/v1/logs", async (c) => {
    const body = await c.req.json();
    const result = await storage.ingestOtelLogs(body);
    if (!result.duplicate) events.publish("ingest", { signal: "logs", ...result });
    return c.json(result);
  });

  app.get("/api/metrics/summary", async (c) => c.json(await storage.getSummary(readFilters(c.req.query()))));

  app.get("/api/metrics/timeseries", async (c) => {
    const query = c.req.query();
    return c.json(await storage.getTimeseries({ ...readFilters(query), granularity: readGranularity(query.granularity) }));
  });

  app.get("/api/sessions", async (c) => c.json(await storage.listSessions(readFilters(c.req.query()))));

  app.get("/api/people", async (c) => c.json(await storage.listPeople(readFilters(c.req.query()))));

  app.get("/api/models", async (c) => c.json(await storage.listModels(readFilters(c.req.query()))));

  app.get("/api/meta", async (c) => c.json(await storage.getFilterOptions()));

  app.get("/api/sessions/:id", async (c) => {
    const session = await storage.getSession(Number(c.req.param("id")));
    return session ? c.json(session) : c.json({ error: "Session not found" }, 404);
  });

  app.get("/api/sessions/:id/transcript/info", async (c) => {
    const info = await storage.getSessionTranscriptInfo(Number(c.req.param("id")));
    return info ? c.json(info) : c.json({ error: "No transcript stored for this session" }, 404);
  });

  app.get("/api/sessions/:id/transcript", async (c) => {
    const transcript = await storage.getSessionTranscript(Number(c.req.param("id")));
    if (!transcript) return c.json({ error: "No transcript stored for this session" }, 404);
    return c.body(transcript.content, 200, { "content-type": "application/x-ndjson; charset=utf-8" });
  });

  app.post("/api/import/jsonl", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let content = "";
    let source = "manual-jsonl";
    let sessionId: string | undefined;

    if (contentType.includes("application/json")) {
      const body = (await c.req.json()) as { content?: string; source?: string; sessionId?: string };
      content = body.content ?? "";
      source = body.source ?? source;
      sessionId = body.sessionId;
    } else {
      content = await c.req.text();
    }

    const result = await storage.importJsonl(source, { sessionId }, content);
    if (!result.duplicate) events.publish("ingest", { signal: "jsonl", ...result });
    return c.json(result);
  });

  app.post("/api/import/claude-hook", async (c) => {
    const body = (await c.req.json()) as { session_id?: string; sessionId?: string; transcript_path?: string; cwd?: string };
    const transcriptPath = body.transcript_path;
    if (!transcriptPath) return c.json({ error: "transcript_path is required" }, 400);

    const resolvedPath = resolve(transcriptPath.replace(/^~(?=$|\/)/, homedir()));
    if (!isAllowedTranscriptPath(resolvedPath, body.cwd)) {
      return c.json({ error: "transcript_path is outside allowed local Claude/project directories" }, 403);
    }
    if (!existsSync(resolvedPath)) return c.json({ error: "transcript_path does not exist" }, 404);

    const content = readFileSync(resolvedPath, "utf8");
    const result = await storage.importJsonl(
      "claude-code-jsonl",
      { sessionId: body.session_id ?? body.sessionId ?? undefined },
      content
    );
    if (!result.duplicate) events.publish("ingest", { signal: "claude-hook", ...result });
    return c.json(result);
  });

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const unsubscribe = events.subscribe((event, data) => {
        void stream.writeSSE({ id: String(++id), event, data: JSON.stringify(data) });
      });

      await stream.writeSSE({ id: String(++id), event: "ready", data: JSON.stringify({ ok: true }) });
      const keepAlive = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: JSON.stringify({ now: Date.now() }) });
      }, 25_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(keepAlive);
          unsubscribe();
          resolve();
        });
      });
    })
  );

  return app;
}

function readFilters(query: Record<string, string>): SummaryFilters {
  return {
    from: parseTime(query.from),
    to: parseTime(query.to),
    user: query.user,
    model: query.model,
    source: query.source,
    session: parseId(query.session)
  };
}

function parseId(value?: string) {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function readGranularity(value?: string): Granularity {
  return GRANULARITIES.includes(value as Granularity) ? (value as Granularity) : "hour";
}

function bearerToken(header?: string) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match ? match[1].trim() : "";
}

// Constant-time string compare that doesn't leak length via early return.
function timingSafeEqualStr(a: string, b: string) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseTime(value?: string) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAllowedTranscriptPath(path: string, cwd?: string) {
  const home = homedir();
  const allowedRoots = [resolve(home, ".claude", "projects")];
  if (cwd) allowedRoots.push(resolve(cwd));
  return allowedRoots.some((root) => path === root || path.startsWith(`${root}/`));
}
