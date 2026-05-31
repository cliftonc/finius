import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "./events.js";
import type { Granularity, MetricPointInput, StorageAdapter, SummaryFilters, TranscriptFormat } from "./types.js";

const GRANULARITIES: Granularity[] = ["minute", "five_minute", "quarter_hour", "hour", "day", "week"];

type AppOptions = {
  storage: StorageAdapter;
  events: EventBus;
  // Bearer token required to call maintenance endpoints. When unset, those endpoints are disabled
  // (fail closed) rather than left open.
  cronToken?: string;
  // Default retention window (days) for the raw-batch prune endpoint.
  rawRetentionDays?: number;
  // Master password ("Secure Mode" bootstrap secret). When set, every endpoint except the public
  // ones requires a credential; clients exchange this password for a session token via /api/auth/login.
  // When unset, Finius stays fully open (the default local-first behavior).
  authSecret?: string;
};

export function createApp({ storage, events, cronToken, rawRetentionDays = 7, authSecret }: AppOptions) {
  const app = new Hono();
  const secure = !!authSecret;

  // JSONL uploads are processed on a background queue; publish the SSE 'ingest' event when each
  // queued job actually completes (not when it was accepted).
  storage.setProcessingListener((signal, result) => events.publish("ingest", { signal, ...result }));

  app.use("*", cors());

  // Single pluggable auth gate. In open mode it's a no-op; in Secure Mode it admits only
  // minted+non-revoked session tokens. The master password is a bootstrap secret for /api/auth/login
  // and is never accepted as a runtime API credential.
  const isValidCredential = (cred: string): boolean => {
    if (!cred) return false;
    const row = storage.findAuthToken(sha256(cred));
    return !!row && row.revoked === 0;
  };

  app.use("*", async (c, next) => {
    if (!secure) return next();
    if (!isProtectedPath(c.req.path)) return next();
    const cred = bearerToken(c.req.header("authorization")) || eventSourceToken(c) || "";
    if (isValidCredential(cred)) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  // Public so setup/doctor can probe Secure Mode without a credential, and so the dashboard knows
  // whether to show the login screen.
  app.get("/api/health", (c) => c.json({ ok: true, now: Date.now(), secure }));

  // Exchange the master password for a client session token. Public (it's the bootstrap),
  // constant-time. The minted token is stored hashed in auth_tokens; browsers persist the returned
  // token in localStorage and send it as Authorization: Bearer on API requests.
  app.post("/api/auth/login", async (c) => {
    if (!secure) return c.json({ error: "auth is not enabled on this server" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { password?: string; label?: string };
    if (!timingSafeEqualStr(body.password ?? "", authSecret ?? "")) {
      return c.json({ error: "invalid password" }, 401);
    }
    const token = randomBytes(32).toString("hex");
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 200) : "client";
    storage.createAuthToken(sha256(token), label, Date.now());
    return c.json({ token });
  });

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
    const body = await readOtlpBody(c, "metrics");
    if (body === null) return c.json({ error: "expected an OTLP/JSON body" }, 415);
    const result = await storage.ingestOtelMetrics(body);
    if (!result.duplicate) events.publish("ingest", { signal: "metrics", ...result });
    return c.json(result);
  });

  app.post("/otlp/v1/logs", async (c) => {
    const body = await readOtlpBody(c, "logs");
    if (body === null) return c.json({ error: "expected an OTLP/JSON body" }, 415);
    const result = await storage.ingestOtelLogs(body);
    if (!result.duplicate) events.publish("ingest", { signal: "logs", ...result });
    return c.json(result);
  });

  // Cron-driven recompute of synthesized cost (e.g. after a pricing update). Same bearer guard /
  // fail-closed semantics as prune-raw-batches.
  app.post("/api/maintenance/recompute-cost", async (c) => {
    if (!cronToken) return c.json({ error: "maintenance endpoints are disabled (set FINIUS_CRON_TOKEN)" }, 503);
    if (!timingSafeEqualStr(bearerToken(c.req.header("authorization")), cronToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json(await storage.recomputeComputedCost());
  });

  // Inspection surface for captured OTLP log records (Codex telemetry is logs-only): one entry per
  // distinct event name with a count + a sample, so we can see the real shape before parsing it.
  app.get("/api/logs/events", async (c) => c.json(await storage.getLogEventSummary()));

  // The model pricing currently loaded (for debugging cost computation).
  app.get("/api/pricing", async (c) => c.json(await storage.getPricing()));

  app.get("/api/metrics/summary", async (c) => c.json(await storage.getSummary(readFilters(c.req.query()))));

  app.get("/api/metrics/timeseries", async (c) => {
    const query = c.req.query();
    return c.json(await storage.getTimeseries({ ...readFilters(query), granularity: readGranularity(query.granularity) }));
  });

  app.get("/api/metrics/timeseries/by-model", async (c) => {
    const query = c.req.query();
    return c.json(await storage.getModelTimeseries({ ...readFilters(query), granularity: readGranularity(query.granularity) }));
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
    let format: TranscriptFormat | undefined;

    let identity: ReturnType<typeof identityHint> = {};
    if (contentType.includes("application/json")) {
      const body = (await c.req.json()) as {
        content?: string;
        source?: string;
        sessionId?: string;
        format?: TranscriptFormat;
      } & IdentityBody;
      content = body.content ?? "";
      source = body.source ?? source;
      sessionId = body.sessionId;
      format = body.format;
      identity = identityHint(body);
    } else {
      content = await c.req.text();
    }

    // Persist + queue; the blob is stored immediately and processing happens on the background queue.
    const result = await storage.enqueueImport(source, { sessionId, ...identity }, content, format);
    return c.json(result);
  });

  app.post("/api/import/claude-hook", async (c) => {
    const body = (await c.req.json()) as {
      session_id?: string;
      sessionId?: string;
      transcript_path?: string;
      transcript?: string;
      cwd?: string;
    } & IdentityBody;
    const sessionHint = { sessionId: body.session_id ?? body.sessionId ?? undefined, ...identityHint(body) };

    // Preferred path: the client (e.g. the `finius` CLI hook) sends the transcript inline, so the
    // server never needs to share a filesystem with Claude Code. Works for remote servers too.
    let content = typeof body.transcript === "string" ? body.transcript : undefined;

    // Fallback: read a local transcript file. Only safe when the server runs on the same machine as
    // Claude Code, so it is restricted to known Claude/project directories.
    if (content === undefined) {
      const transcriptPath = body.transcript_path;
      if (!transcriptPath) return c.json({ error: "transcript or transcript_path is required" }, 400);

      const resolvedPath = resolve(transcriptPath.replace(/^~(?=$|\/)/, homedir()));
      if (!isAllowedTranscriptPath(resolvedPath, body.cwd)) {
        return c.json({ error: "transcript_path is outside allowed local Claude/project directories" }, 403);
      }
      if (!existsSync(resolvedPath)) return c.json({ error: "transcript_path does not exist" }, 404);
      content = readFileSync(resolvedPath, "utf8");
    }

    const result = await storage.enqueueImport("claude-code-jsonl", sessionHint, content);
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

// User identity an importing client (the `finius` CLI hook/backfill) attaches to a transcript upload.
// Accepts both snake_case (claude-hook body) and camelCase (jsonl body) so either route can carry it.
type IdentityBody = {
  user_email?: string;
  user_account_id?: string;
  user_id?: string;
  github_login?: string;
  display_name?: string;
  userEmail?: string;
  userAccountId?: string;
  userId?: string;
  githubLogin?: string;
  displayName?: string;
};

function identityHint(body: IdentityBody): Partial<MetricPointInput> {
  return {
    userEmail: body.user_email ?? body.userEmail ?? undefined,
    userAccountId: body.user_account_id ?? body.userAccountId ?? undefined,
    userId: body.user_id ?? body.userId ?? undefined,
    githubLogin: body.github_login ?? body.githubLogin ?? undefined,
    displayName: body.display_name ?? body.displayName ?? undefined
  };
}

function readGranularity(value?: string): Granularity {
  return GRANULARITIES.includes(value as Granularity) ? (value as Granularity) : "hour";
}

function bearerToken(header?: string) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match ? match[1].trim() : "";
}

function eventSourceToken(c: Context) {
  return c.req.path === "/events" ? (c.req.query("token") ?? "") : "";
}

// Reads an OTLP request body as text (so a debug dump can capture the exact bytes the agent sent —
// even non-JSON), optionally captures it, then parses JSON. Returns null when the body isn't valid
// OTLP/JSON (e.g. an agent that sends protobuf). Set FINIUS_DEBUG_OTEL to a file path to append every
// batch as `{kind, at, contentType, raw}` NDJSON — used to discover what a new agent (e.g. Codex)
// actually emits before writing a parser for it.
async function readOtlpBody(c: Context, kind: "metrics" | "logs"): Promise<unknown> {
  const raw = await c.req.text();
  const debugPath = process.env.FINIUS_DEBUG_OTEL;
  if (debugPath) {
    const line = JSON.stringify({ kind, at: Date.now(), contentType: c.req.header("content-type") ?? null, raw });
    try {
      appendFileSync(debugPath, `${line}\n`);
      console.log(`[finius] OTLP ${kind} batch captured -> ${debugPath} (${raw.length} bytes)`);
    } catch (err) {
      console.error(`[finius] OTLP debug capture failed: ${(err as Error).message}`);
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// Which paths the Secure Mode gate guards. Data + ingest + the live stream require a credential;
// everything else (static client assets, index.html, /api/health, /api/auth/login) is public so the
// login page can load and clients can bootstrap. /api/auth/login is under /api/ but allow-listed.
function isProtectedPath(path: string) {
  if (path === "/api/health" || path === "/api/auth/login") return false;
  return path.startsWith("/api/") || path.startsWith("/otlp/") || path === "/events";
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
