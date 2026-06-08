import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { GitHub } from "arctic";
import { CLAUDE_JSONL_SOURCE, MANUAL_JSONL_SOURCE } from "../shared/sources.js";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "./events.js";
import { OtlpDecodeError, decodeOtlpBody, type OtlpSignal } from "./otlp-decode.js";
import type { Granularity, MetricPointInput, StorageAdapter, SummaryFilters, TelemetryIdentity, TranscriptFormat } from "./types.js";

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
  oauth?: {
    github?: {
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
      requiredOrg?: string;
      callbackUrl?: string;
    };
  };
};

export function createApp({ storage, events, cronToken, rawRetentionDays = 7, authSecret, oauth }: AppOptions) {
  const app = new Hono();
  const github = oauth?.github;
  const githubEnabled = !!(github?.enabled && github.clientId && github.clientSecret && github.requiredOrg && github.callbackUrl);
  // Secure Mode is active when EITHER a master password is set OR GitHub OAuth is configured. OAuth
  // alone must lock the server (otherwise the login button would be decorative and every endpoint open).
  const secure = !!authSecret || githubEnabled;
  // arctic builds the authorize URL + exchanges the code; we keep our own state cookie and the
  // profile/org-membership fetch (arctic doesn't model GitHub's user/org endpoints).
  const githubClient = githubEnabled && github ? new GitHub(github.clientId!, github.clientSecret!, github.callbackUrl!) : null;

  // JSONL uploads are processed on a background queue; publish the SSE 'ingest' event when each
  // queued job actually completes (not when it was accepted).
  storage.setProcessingListener((signal, result) => events.publish("ingest", { signal, ...result }));

  app.use("*", cors());

  // Single pluggable auth gate. In open mode it's a no-op; in Secure Mode it admits only
  // minted+non-revoked session tokens. The master password is a bootstrap secret for /api/auth/login
  // and is never accepted as a runtime API credential.
  const authForCredential = (cred: string): { tokenId: number; userRowId: number | null } | null => {
    if (!cred) return null;
    const row = storage.findAuthToken(sha256(cred));
    return row && row.revoked === 0 ? { tokenId: row.id, userRowId: row.userRowId } : null;
  };

  app.use("*", async (c, next) => {
    if (!secure) return next();
    if (!isProtectedPath(c.req.path)) return next();
    const cred = bearerToken(c.req.header("authorization")) || cookieValue(c.req.header("cookie"), "finius_auth") || eventSourceToken(c) || "";
    if (authForCredential(cred)) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  // Public so setup/doctor can probe Secure Mode without a credential, and so the dashboard knows
  // whether to show the login screen.
  app.get("/api/health", (c) => c.json({ ok: true, now: Date.now(), secure }));

  app.get("/api/auth/providers", (c) =>
    c.json({
      password: { enabled: !githubEnabled },
      github: githubEnabled
        ? {
            enabled: true,
            requiredOrg: github?.requiredOrg,
            loginUrl: "/api/auth/github"
          }
        : { enabled: false }
    })
  );

  app.get("/api/auth/me", (c) => {
    const auth = currentAuth(c, storage);
    if (!auth?.userRowId) return c.json({ user: null });
    const user = storage.getUserById(auth.userRowId);
    return c.json({ user });
  });

  // Exchange the master password for a client session token. Public (it's the bootstrap),
  // constant-time. The minted token is stored hashed in auth_tokens; browsers persist the returned
  // token in localStorage and send it as Authorization: Bearer on API requests.
  app.post("/api/auth/login", async (c) => {
    if (!secure) return c.json({ error: "auth is not enabled on this server" }, 400);
    // No master password means password login is disabled (GitHub-only mode). Bail before the
    // constant-time compare, which would otherwise match an empty password against an empty secret.
    if (!authSecret) return c.json({ error: "password login is not enabled on this server" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { password?: string; label?: string };
    if (githubEnabled && body.label === "browser") {
      return c.json({ error: "password login is disabled; use GitHub" }, 400);
    }
    if (!timingSafeEqualStr(body.password ?? "", authSecret ?? "")) {
      return c.json({ error: "invalid password" }, 401);
    }
    const token = randomBytes(32).toString("hex");
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 200) : "client";
    storage.createAuthToken(sha256(token), label, Date.now());
    return c.json({ token });
  });

  // Revoke the presented session token and clear the cookie. Public: it only ever invalidates the
  // caller's own credential, and the cookie is HttpOnly so the browser can't clear it on its own.
  app.post("/api/auth/logout", (c) => {
    const cred = bearerToken(c.req.header("authorization")) || cookieValue(c.req.header("cookie"), "finius_auth") || "";
    if (cred) {
      const row = storage.findAuthToken(sha256(cred));
      if (row) storage.revokeAuthToken(row.id);
    }
    c.header("set-cookie", clearAuthCookie());
    return c.json({ ok: true });
  });

  app.get("/api/auth/github", (c) => {
    if (!githubEnabled || !github || !githubClient) return c.json({ error: "github oauth is not configured" }, 404);
    const returnTo = validLoopbackReturnTo(c.req.query("return_to"));
    const state = createOAuthState(github.clientSecret!, returnTo);
    const url = githubClient.createAuthorizationURL(state, ["read:user", "user:email", "read:org"]);
    c.header("set-cookie", oauthStateCookie(state, github.callbackUrl!));
    return c.redirect(url.toString());
  });

  app.get("/api/auth/github/callback", async (c) => {
    if (!githubEnabled || !github) return c.json({ error: "github oauth is not configured" }, 404);
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const installationId = c.req.query("installation_id");
    const setupAction = c.req.query("setup_action");
    c.header("set-cookie", clearOAuthStateCookie());
    if (installationId || setupAction) {
      console.warn(
        `[finius] github callback received GitHub App installation params installation_id=${installationId ?? ""} setup_action=${setupAction ?? ""}; expected OAuth App callback with code+state`
      );
      return c.json(
        {
          error: "github app installation callback received; configure a GitHub OAuth App authorization callback URL instead"
        },
        400
      );
    }
    const stateResult = parseOAuthState(state, github.clientSecret!, cookieValue(c.req.header("cookie"), "finius_oauth_state"));
    if (!code || !stateResult.valid) {
      console.warn(`[finius] github oauth callback rejected invalid state has_code=${!!code} has_state=${!!state}`);
      return c.json({ error: "invalid oauth state" }, 400);
    }

    try {
      const tokens = await githubClient!.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();
      const profile = await fetchGithubProfile(accessToken);
      const member = await isGithubOrgMember(accessToken, github.requiredOrg!, profile.login);
      if (!member) {
        console.warn(`[finius] github oauth rejected login=${profile.login} required_org=${github.requiredOrg}: membership not active or not visible to OAuth app`);
        return c.json({ error: "github organization membership required" }, 403);
      }

      const user = storage.upsertOAuthUser(
        {
          provider: "github",
          providerUserId: String(profile.id),
          email: profile.email,
          // All verified GitHub emails — lets the storage layer link this login to an existing
          // telemetry user row even when the GitHub *primary* email differs from the session identity.
          emails: profile.emails,
          githubLogin: profile.login,
          displayName: profile.name
        },
        Date.now()
      );
      const browserToken = randomBytes(32).toString("hex");
      storage.createAuthToken(sha256(browserToken), `github:${profile.login}`, Date.now(), user.id);
      // CLI loopback flow: the local listener has no cookie jar, so hand it the token via the URL.
      if (stateResult.returnTo) return c.redirect(appendToken(stateResult.returnTo, browserToken));
      // Browser flow: keep the token out of the URL/history. Set it as an HttpOnly cookie and bounce
      // to the dashboard — same-origin fetch sends the cookie automatically and the gate accepts it.
      c.header("set-cookie", authCookie(browserToken, github.callbackUrl!), { append: true });
      return c.redirect("/");
    } catch (error) {
      console.warn(`[finius] github oauth failed: ${(error as Error).message}`);
      return c.json({ error: (error as Error).message || "github oauth failed" }, 400);
    }
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
    if (body instanceof OtlpDecodeError) return c.json({ error: body.message }, body.status as 400 | 415);
    const result = await storage.ingestOtelMetrics(body, telemetryIdentity(c, storage));
    if (!result.duplicate) events.publish("ingest", { signal: "metrics", ...result });
    return c.json(result);
  });

  app.post("/otlp/v1/logs", async (c) => {
    const body = await readOtlpBody(c, "logs");
    if (body instanceof OtlpDecodeError) return c.json({ error: body.message }, body.status as 400 | 415);
    const result = await storage.ingestOtelLogs(body);
    if (!result.duplicate) events.publish("ingest", { signal: "logs", ...result });
    return c.json(result);
  });

  app.post("/otlp/v1/traces", async (c) => {
    const body = await readOtlpBody(c, "traces");
    if (body instanceof OtlpDecodeError) return c.json({ error: body.message }, body.status as 400 | 415);
    const result = await storage.ingestOtelTraces(body, telemetryIdentity(c, storage));
    if (!result.duplicate) events.publish("ingest", { signal: "traces", ...result });
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

  app.get("/api/metrics/summary", async (c) => c.json(await storage.getSummary(readFilters(c.req.query(), meFilter(c, storage)))));

  app.get("/api/metrics/timeseries", async (c) => {
    const query = c.req.query();
    return c.json(await storage.getTimeseries({ ...readFilters(query, meFilter(c, storage)), granularity: readGranularity(query.granularity) }));
  });

  app.get("/api/metrics/timeseries/by-model", async (c) => {
    const query = c.req.query();
    return c.json(await storage.getModelTimeseries({ ...readFilters(query, meFilter(c, storage)), granularity: readGranularity(query.granularity) }));
  });

  app.get("/api/sessions", async (c) => c.json(await storage.listSessions(readFilters(c.req.query(), meFilter(c, storage)))));

  app.get("/api/people", async (c) => c.json(await storage.listPeople(readFilters(c.req.query(), meFilter(c, storage)))));

  app.get("/api/models", async (c) => c.json(await storage.listModels(readFilters(c.req.query(), meFilter(c, storage)))));

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
    let content: string;
    let source = MANUAL_JSONL_SOURCE;
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

    const result = await storage.enqueueImport(CLAUDE_JSONL_SOURCE, sessionHint, content);
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

function readFilters(query: Record<string, string>, me?: CurrentUser): SummaryFilters {
  const mine = query.mine === "1" || query.mine === "true";
  return {
    from: parseTime(query.from),
    to: parseTime(query.to),
    user: query.user,
    // -1 when "mine" is requested but the caller has no linked user row, so the filter matches nothing
    // (rather than silently dropping the constraint and showing everyone's data).
    userRowId: mine ? me?.userRowId ?? -1 : undefined,
    // Also match the current user's email identity: a person's GitHub user row and their telemetry
    // user row don't always merge (e.g. OTEL sessions carry no GitHub login), so user_row_id alone can
    // miss sessions that are unmistakably theirs by email.
    userRowIdEmail: mine ? me?.email ?? undefined : undefined,
    model: query.model,
    source: query.source,
    session: parseId(query.session)
  };
}

type CurrentUser = { userRowId: number | null; email: string | null };

// Resolve the signed-in user (row id + email) for "mine" filtering. Null when unauthenticated or the
// token isn't linked to a user (e.g. a password/owner token).
function meFilter(c: Context, storage: StorageAdapter): CurrentUser | undefined {
  const auth = currentAuth(c, storage);
  if (!auth) return undefined;
  const user = auth.userRowId ? storage.getUserById(auth.userRowId) : null;
  return { userRowId: auth.userRowId, email: user?.email ?? null };
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

function currentAuth(c: Context, storage: StorageAdapter): { tokenId: number; userRowId: number | null } | null {
  const cred = bearerToken(c.req.header("authorization")) || cookieValue(c.req.header("cookie"), "finius_auth") || eventSourceToken(c);
  if (!cred) return null;
  const row = storage.findAuthToken(sha256(cred));
  return row && row.revoked === 0 ? { tokenId: row.id, userRowId: row.userRowId } : null;
}

function telemetryIdentity(c: Context, storage: StorageAdapter): TelemetryIdentity | undefined {
  const fromHeaders: TelemetryIdentity = {
    userEmail: decodedHeader(c, "x-finius-user-email"),
    userId: decodedHeader(c, "x-finius-user-id"),
    userAccountId: decodedHeader(c, "x-finius-user-account-id"),
    githubLogin: decodedHeader(c, "x-finius-github-login"),
    displayName: decodedHeader(c, "x-finius-display-name")
  };
  if (Object.values(fromHeaders).some(Boolean)) return fromHeaders;

  const auth = currentAuth(c, storage);
  const user = auth?.userRowId ? storage.getUserById(auth.userRowId) : null;
  if (!user) return undefined;
  return {
    userEmail: user.email,
    githubLogin: user.githubLogin,
    displayName: user.displayName
  };
}

function decodedHeader(c: Context, name: string): string | undefined {
  const value = c.req.header(name);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function oauthStateCookie(state: string, callbackUrl: string) {
  const secure = callbackUrl.startsWith("https://") ? "; Secure" : "";
  return `finius_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
}

// The session cookie set after a successful browser GitHub login. HttpOnly so page scripts can't read
// the token; SameSite=Lax so it rides the top-level redirect back from GitHub. 30-day lifetime.
function authCookie(token: string, callbackUrl: string) {
  const secure = callbackUrl.startsWith("https://") ? "; Secure" : "";
  return `finius_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${secure}`;
}

function clearAuthCookie() {
  return "finius_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

function createOAuthState(secret: string, returnTo?: string) {
  const payload = Buffer.from(
    JSON.stringify({
      n: randomBytes(24).toString("hex"),
      i: Date.now(),
      ...(returnTo ? { r: returnTo } : {})
    }),
    "utf8"
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

// State is a single self-validating token: `base64url(payload).hmac`. The HMAC (keyed on the client
// secret) proves the server minted it, and the embedded timestamp bounds its lifetime — so a callback
// validates statelessly even when the state cookie is lost (the 127.0.0.1↔localhost alias drops it).
function parseOAuthState(state: string, secret: string, cookieState: string): { valid: boolean; returnTo?: string } {
  if (!state) return { valid: false };
  const dot = state.indexOf(".");
  const payload = dot === -1 ? "" : state.slice(0, dot);
  const sig = dot === -1 ? "" : state.slice(dot + 1);
  if (!payload || !/^[a-f0-9]{64}$/i.test(sig)) return { valid: false };
  if (!timingSafeEqualStr(sig, createHmac("sha256", secret).update(payload).digest("hex"))) return { valid: false };
  const decoded = decodeOAuthStatePayload(payload);
  if (!decoded || Date.now() - decoded.i > 10 * 60_000) return { valid: false };
  // Defense in depth: when the browser DID keep the state cookie, require it to match (per-session
  // binding). A missing cookie is tolerated — the signature already establishes provenance.
  if (cookieState && !timingSafeEqualStr(state, cookieState)) return { valid: false };
  return { valid: true, returnTo: validLoopbackReturnTo(decoded.r) };
}

function decodeOAuthStatePayload(payload: string): { i: number; r?: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { i?: unknown; r?: unknown };
    return typeof decoded.i === "number" ? { i: decoded.i, r: typeof decoded.r === "string" ? decoded.r : undefined } : null;
  } catch {
    return null;
  }
}

function validLoopbackReturnTo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return undefined;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return undefined;
    if (!url.port) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function appendToken(returnTo: string, token: string) {
  const url = new URL(returnTo);
  url.searchParams.set("token", token);
  return url.toString();
}

function clearOAuthStateCookie() {
  return "finius_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

function cookieValue(header: string | undefined, name: string): string {
  const cookies = (header ?? "").split(";").map((part) => part.trim());
  const prefix = `${name}=`;
  return cookies.find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? "";
}

type GithubProfile = { id: number | string; login: string; name: string | null; email: string | null; emails: string[] };

async function fetchGithubProfile(token: string): Promise<GithubProfile> {
  const userRes = await githubFetch("https://api.github.com/user", token);
  const user = (await userRes.json()) as Omit<GithubProfile, "emails">;
  if (!user.id || !user.login) throw new Error("github profile is missing an id or login");

  // Always pull the verified-emails list: it's how we link this login to an existing telemetry user
  // row even when the public/primary profile email differs from the session's recorded identity.
  const emailsRes = await githubFetch("https://api.github.com/user/emails", token);
  const rows = (await emailsRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
  const verified = rows.filter((e) => e.verified && e.email).map((e) => e.email as string);
  const primary = rows.find((e) => e.primary && e.verified && e.email)?.email ?? verified[0] ?? user.email ?? null;
  const emails = verified.length ? verified : user.email ? [user.email] : [];
  return { ...user, email: primary, emails };
}

async function isGithubOrgMember(token: string, org: string, login: string): Promise<boolean> {
  const self = await fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, {
    headers: githubHeaders(token)
  });
  if (self.ok) {
    const body = (await self.json()) as { state?: string };
    return body.state === "active";
  }
  console.warn(`[finius] github org check self endpoint org=${org} login=${login} status=${self.status}`);
  if (self.status !== 404 && self.status !== 403) throw new Error(`github org membership check failed (${self.status})`);

  const byLogin = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`, {
    headers: githubHeaders(token)
  });
  if (byLogin.status === 404 || byLogin.status === 403) {
    console.warn(`[finius] github org check login endpoint org=${org} login=${login} status=${byLogin.status}`);
    return false;
  }
  if (!byLogin.ok) throw new Error(`github org membership check failed (${byLogin.status})`);
  const body = (await byLogin.json()) as { state?: string };
  return body.state === "active";
}

async function githubFetch(url: string, token: string): Promise<Response> {
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) throw new Error(`github api request failed (${res.status})`);
  return res;
}

function githubHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "finius"
  };
}

// Reads an OTLP request body as bytes, optionally captures a base64 debug dump, then decodes JSON or
// protobuf OTLP. Set FINIUS_DEBUG_OTEL to append `{kind, at, contentType, rawBase64}` NDJSON.
async function readOtlpBody(c: Context, kind: OtlpSignal): Promise<unknown | OtlpDecodeError> {
  const raw = Buffer.from(await c.req.arrayBuffer());
  const debugPath = process.env.FINIUS_DEBUG_OTEL;
  if (debugPath) {
    const line = JSON.stringify({ kind, at: Date.now(), contentType: c.req.header("content-type") ?? null, rawBase64: raw.toString("base64") });
    try {
      appendFileSync(debugPath, `${line}\n`);
      console.log(`[finius] OTLP ${kind} batch captured -> ${debugPath} (${raw.length} bytes)`);
    } catch (err) {
      console.error(`[finius] OTLP debug capture failed: ${(err as Error).message}`);
    }
  }
  try {
    return decodeOtlpBody(raw, kind, c.req.header("content-type"), c.req.header("content-encoding"));
  } catch (error) {
    if (error instanceof OtlpDecodeError) return error;
    return new OtlpDecodeError((error as Error).message, 400);
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// Which paths the Secure Mode gate guards. Data + ingest + the live stream require a credential;
// everything else (static client assets, index.html, /api/health, /api/auth/login) is public so the
// login page can load and clients can bootstrap. /api/auth/login is under /api/ but allow-listed.
function isProtectedPath(path: string) {
  if (
    path === "/api/health" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout" ||
    path === "/api/auth/providers" ||
    path === "/api/auth/github" ||
    path === "/api/auth/github/callback"
  ) {
    return false;
  }
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
