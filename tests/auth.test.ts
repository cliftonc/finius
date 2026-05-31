import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { EventBus } from "../src/server/events";
import { SqliteStorageAdapter } from "../src/server/storage/sqlite";

function tmpDbPath() {
  return join(mkdtempSync(join(tmpdir(), "finius-")), "test.sqlite");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let storage: SqliteStorageAdapter | null = null;

function makeApp(authSecret?: string) {
  storage = new SqliteStorageAdapter(tmpDbPath());
  return createApp({ storage, events: new EventBus(), authSecret });
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

  it("rejects a wrong password and mints a token + cookie for the right one", async () => {
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
    expect(good.headers.get("set-cookie")).toContain("finius_auth=");

    // The minted token is recorded (hashed) for the admin GUI to list/revoke.
    const tokens = storage!.listAuthTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].label).toBe("test-host");
  });

  it("authenticates via the master password, a Bearer token, and the cookie", async () => {
    const app = makeApp(PASSWORD);

    // Master password presented directly as a Bearer credential.
    expect(
      (await app.request("/api/meta", { headers: { authorization: `Bearer ${PASSWORD}` } })).status
    ).toBe(200);

    // Mint a session token, then use it both as a Bearer header and as the cookie.
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
    expect((await app.request("/api/meta", { headers: { cookie: `finius_auth=${token}` } })).status).toBe(200);
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
