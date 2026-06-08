import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { EventBus } from "../src/server/events";
import { DrizzleStorageAdapter } from "../src/server/storage/adapter";
import { jsonlTranscript } from "./fixtures";

function tmpDbPath() {
  return join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let storage: DrizzleStorageAdapter | null = null;

function makeApp(authSecret?: string) {
  storage = new DrizzleStorageAdapter(tmpDbPath());
  return createApp({ storage, events: new EventBus(), authSecret });
}

function makeGithubApp(authSecret = "secret") {
  storage = new DrizzleStorageAdapter(tmpDbPath());
  return createApp({
    storage,
    events: new EventBus(),
    authSecret,
    oauth: {
      github: {
        enabled: true,
        clientId: "client-id",
        clientSecret: "client-secret",
        requiredOrg: "finius-org",
        callbackUrl: "http://localhost:8787/api/auth/github/callback"
      }
    }
  });
}

afterEach(() => {
  storage?.close();
  storage = null;
});

describe("auth — open mode", () => {
  it("leaves every endpoint open when no password is configured", async () => {
    const app = makeApp();
    expect((await app.request("/api/meta")).status).toBe(200);
    expect((await app.request("/api/metrics/summary")).status).toBe(200);

    const health = await (await app.request("/api/health")).json();
    expect(health.secure).toBe(false);

    // The login endpoint is a no-op when auth isn't enabled.
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "anything" })
    });
    expect(login.status).toBe(400);
  });
});

describe("auth — secure mode", () => {
  const PASSWORD = "blue-happy-otter";

  it("reports secure mode on the public health endpoint", async () => {
    const app = makeApp(PASSWORD);
    const health = await (await app.request("/api/health")).json();
    expect(health.secure).toBe(true);
  });

  it("401s protected endpoints without a credential", async () => {
    const app = makeApp(PASSWORD);
    expect((await app.request("/api/meta")).status).toBe(401);
    expect((await app.request("/api/metrics/summary")).status).toBe(401);
    expect((await app.request("/otlp/v1/metrics", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app.request("/events")).status).toBe(401);
  });

  it("keeps health and login public", async () => {
    const app = makeApp(PASSWORD);
    expect((await app.request("/api/health")).status).toBe(200);
    // login is reachable (wrong password still returns a 401 from the handler, not the gate)
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" })
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong password and mints a token for the right one", async () => {
    const app = makeApp(PASSWORD);

    const bad = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" })
    });
    expect(bad.status).toBe(401);

    const good = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD, label: "test-host" })
    });
    expect(good.status).toBe(200);
    const body = await good.json();
    expect(typeof body.token).toBe("string");
    expect(good.headers.get("set-cookie")).toBeNull();

    // The minted token is recorded (hashed) for the admin GUI to list/revoke.
    const tokens = storage!.listAuthTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].label).toBe("test-host");
  });

  it("only accepts minted tokens on protected endpoints", async () => {
    const app = makeApp(PASSWORD);

    // The master password is only accepted by /api/auth/login, never as a runtime API credential.
    expect(
      (await app.request("/api/meta", { headers: { authorization: `Bearer ${PASSWORD}` } })).status
    ).toBe(401);

    // Mint a session token, then use it as a Bearer header.
    const token = (
      await (
        await app.request("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: PASSWORD })
        })
      ).json()
    ).token as string;

    expect((await app.request("/api/meta", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    // A minted token is also accepted via the finius_auth cookie (the GitHub browser-login transport);
    // a bogus cookie value is not.
    expect((await app.request("/api/meta", { headers: { cookie: `finius_auth=${token}` } })).status).toBe(200);
    expect((await app.request("/api/meta", { headers: { cookie: "finius_auth=not-a-real-token" } })).status).toBe(401);
  });

  it("401s a revoked token", async () => {
    const app = makeApp(PASSWORD);
    const token = (
      await (
        await app.request("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: PASSWORD })
        })
      ).json()
    ).token as string;

    const row = storage!.findAuthToken(sha256(token));
    expect(row).not.toBeNull();
    storage!.revokeAuthToken(row!.id);

    expect((await app.request("/api/meta", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});

describe("auth — github oauth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lists GitHub only when OAuth config is complete", async () => {
    const open = makeApp("secret");
    expect(await (await open.request("/api/auth/providers")).json()).toMatchObject({
      password: { enabled: true },
      github: { enabled: false }
    });
    storage?.close();

    const app = makeGithubApp();
    const providers = await (await app.request("/api/auth/providers")).json();
    expect(providers).toMatchObject({
      password: { enabled: false },
      github: { enabled: true, requiredOrg: "finius-org", loginUrl: "/api/auth/github" }
    });
  });

  it("disables browser password login when GitHub OAuth is enabled but keeps non-browser token exchange", async () => {
    const app = makeGithubApp("secret");
    const browser = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret", label: "browser" })
    });
    expect(browser.status).toBe(400);

    const cli = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret", label: "test-host" })
    });
    expect(cli.status).toBe(200);
  });

  it("redirects to GitHub and sets a state cookie", async () => {
    const app = makeGithubApp();
    const res = await app.request("/api/auth/github", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://github.com/login/oauth/authorize?");
    expect(res.headers.get("location")).toContain("scope=read%3Auser+user%3Aemail+read%3Aorg");
    expect(res.headers.get("set-cookie")).toContain("finius_oauth_state=");
  });

  it("rejects callback requests with missing or invalid state", async () => {
    const app = makeGithubApp();
    expect((await app.request("/api/auth/github/callback?code=abc&state=bad")).status).toBe(400);
    expect((await app.request("/api/auth/github/callback?code=abc&state=bad", { headers: { cookie: "finius_oauth_state=other" } })).status).toBe(400);
  });

  it("explains GitHub App installation callbacks are not OAuth login callbacks", async () => {
    const app = makeGithubApp();
    const res = await app.request("/api/auth/github/callback?code=abc&installation_id=123&setup_action=install");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "github app installation callback received; configure a GitHub OAuth App authorization callback URL instead"
    });
  });

  it("accepts callback state even when the browser drops the state cookie across localhost aliases", async () => {
    const app = makeGithubApp();
    mockGithub(true);
    const start = await app.request("/api/auth/github", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    expect(state).toBeTruthy();

    const res = await app.request(`/api/auth/github/callback?code=abc&state=${encodeURIComponent(state!)}`, {
      redirect: "manual"
    });
    expect(res.status).toBe(302);
    // Browser flow: token is delivered as an HttpOnly cookie, not in the URL.
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("finius_auth=");
  });

  it("preserves the CLI return URL from GitHub state when the state cookie is present", async () => {
    const app = makeGithubApp();
    mockGithub(true);
    const returnTo = "http://127.0.0.1:49152/callback";
    const start = await app.request(`/api/auth/github?return_to=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;

    const res = await app.request(`/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `finius_oauth_state=${state}` },
      redirect: "manual"
    });
    expect(res.status).toBe(302);
    const redirected = new URL(res.headers.get("location")!);
    expect(`${redirected.origin}${redirected.pathname}`).toBe(returnTo);
    expect(redirected.searchParams.get("token")).toBeTruthy();
  });

  it("rejects GitHub users outside the required organization", async () => {
    const app = makeGithubApp();
    mockGithub(false);
    const state = await startGithubLogin(app);
    const res = await app.request(`/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `finius_oauth_state=${state}` }
    });
    expect(res.status).toBe(403);
  });

  it("links a GitHub org member to a user, mints a user token, and returns /me", async () => {
    const app = makeGithubApp();
    await storage!.importJsonl("claude-code-jsonl", { sessionId: "s1", userEmail: "octo@example.com" }, jsonlTranscript("s1"));
    await storage!.importJsonl("claude-code-jsonl", { sessionId: "s2", userEmail: "other@example.com" }, jsonlTranscript("s2"));
    mockGithub(true);

    const state = await startGithubLogin(app);
    const res = await app.request(`/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `finius_oauth_state=${state}` },
      redirect: "manual"
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const token = authTokenFromCookie(res);
    expect(token).toBeTruthy();

    const me = await (
      await app.request("/api/auth/me", { headers: { authorization: `Bearer ${token}` } })
    ).json();
    expect(me.user).toMatchObject({ email: "octo@example.com", githubLogin: "octocat", displayName: "Octo Cat" });

    const tokenRow = storage!.findAuthToken(sha256(token));
    expect(tokenRow?.userRowId).toBe(me.user.id);

    // The cookie alone (no Authorization header) authenticates subsequent requests.
    const mine = await (
      await app.request("/api/sessions?mine=1", { headers: { cookie: `finius_auth=${token}` } })
    ).json();
    expect(mine.map((s: { userEmail: string | null }) => s.userEmail)).toEqual(["octo@example.com"]);
  });

  it("accepts private org membership from the authenticated-user endpoint", async () => {
    const app = makeGithubApp();
    mockGithub(true, { selfMembership: true });
    const start = await app.request("/api/auth/github", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;

    const res = await app.request(`/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      redirect: "manual"
    });
    expect(res.status).toBe(302);
  });

  it("secures the server with GitHub OAuth even when no master password is set", async () => {
    storage = new DrizzleStorageAdapter(tmpDbPath());
    const app = createApp({
      storage,
      events: new EventBus(),
      oauth: {
        github: {
          enabled: true,
          clientId: "client-id",
          clientSecret: "client-secret",
          requiredOrg: "finius-org",
          callbackUrl: "http://localhost:8787/api/auth/github/callback"
        }
      }
    });
    // The gate is active even without a password: protected endpoints require a credential.
    expect((await app.request("/api/meta")).status).toBe(401);
    // Health advertises secure mode so the dashboard shows the login screen.
    expect(await (await app.request("/api/health")).json()).toMatchObject({ secure: true });
    // Password login is disabled (no master password): an empty password must NOT mint a token.
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "", label: "cli" })
    });
    expect(login.status).toBe(400);
  });

  it("links sessions to the GitHub user by a verified secondary email when the primary differs", async () => {
    const app = makeGithubApp();
    await storage!.importJsonl("claude-code-jsonl", { sessionId: "s1", userEmail: "work@example.com" }, jsonlTranscript("s1"));
    await storage!.importJsonl("claude-code-jsonl", { sessionId: "s2", userEmail: "stranger@example.com" }, jsonlTranscript("s2"));
    // GitHub primary is personal@…, but work@example.com is also verified — so the login should link
    // to the existing user row that owns the work@example.com session.
    mockGithub(true, {
      emails: [
        { email: "personal@example.com", primary: true, verified: true },
        { email: "work@example.com", primary: false, verified: true }
      ]
    });

    const state = await startGithubLogin(app);
    const res = await app.request(`/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `finius_oauth_state=${state}` },
      redirect: "manual"
    });
    expect(res.status).toBe(302);
    const token = authTokenFromCookie(res);

    const mine = await (await app.request("/api/sessions?mine=1", { headers: { authorization: `Bearer ${token}` } })).json();
    expect(mine.map((s: { userEmail: string | null }) => s.userEmail)).toEqual(["work@example.com"]);
  });

  it("logout revokes the session token and clears the cookie", async () => {
    const app = makeGithubApp();
    mockGithub(true);
    const state = await startGithubLogin(app);
    const cb = await app.request(`/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `finius_oauth_state=${state}` },
      redirect: "manual"
    });
    const token = authTokenFromCookie(cb);
    expect((await app.request("/api/meta", { headers: { cookie: `finius_auth=${token}` } })).status).toBe(200);

    const out = await app.request("/api/auth/logout", { method: "POST", headers: { cookie: `finius_auth=${token}` } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("finius_auth=;");

    // The token is revoked, so the cookie no longer authenticates.
    expect((await app.request("/api/meta", { headers: { cookie: `finius_auth=${token}` } })).status).toBe(401);
  });
});

// Begin a real OAuth login and return the signed `state` the server minted (and set as a cookie).
async function startGithubLogin(app: ReturnType<typeof createApp>, query = ""): Promise<string> {
  const start = await app.request(`/api/auth/github${query}`, { redirect: "manual" });
  return new URL(start.headers.get("location")!).searchParams.get("state")!;
}

// Pull the finius_auth token out of a callback response's Set-Cookie header (browser login flow).
function authTokenFromCookie(res: Response): string {
  const match = /finius_auth=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  return match ? match[1] : "";
}

type EmailRow = { email: string; primary?: boolean; verified?: boolean };

function mockGithub(
  member: boolean,
  options: { selfMembership?: boolean; id?: number; login?: string; name?: string; emails?: EmailRow[] } = {}
) {
  const login = options.login ?? "octocat";
  const name = options.name ?? "Octo Cat";
  const emails = options.emails ?? [{ email: "octo@example.com", primary: true, verified: true }];
  globalThis.fetch = (async (input: string | URL | Request) => {
    // arctic passes a Request to fetch (not a URL string), so read .url rather than String(input).
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gh-token", token_type: "bearer", scope: "" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: options.id ?? 123, login, name, email: null });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json(emails);
    }
    if (url.includes("/user/memberships/orgs/finius-org")) {
      return options.selfMembership && member ? Response.json({ state: "active" }) : new Response("{}", { status: 404 });
    }
    if (url.includes(`/orgs/finius-org/memberships/${login}`)) {
      return member ? Response.json({ state: "active" }) : new Response("{}", { status: 404 });
    }
    return new Response("unexpected url", { status: 500 });
  }) as typeof fetch;
}
