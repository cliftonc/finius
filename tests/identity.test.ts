import { describe, expect, it } from "vitest";
import type { FiniusConfig } from "../src/cli/config";
import {
  decodeJwtPayload,
  githubIdentity,
  parseClaudeAccount,
  parseCodexAuth,
  resolveIdentity
} from "../src/cli/identity";

// Build an unsigned JWT (header.payload.sig) whose payload is the given claims, matching the shape
// Codex stores in ~/.codex/auth.json (we only ever read the payload, never verify).
function jwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "RS256", typ: "JWT" })}.${seg(claims)}.signature`;
}

describe("identity parsers", () => {
  it("parses the Claude account from ~/.claude.json", () => {
    const raw = JSON.stringify({
      userID: "hash-1",
      oauthAccount: { emailAddress: "alice@example.com", accountUuid: "uuid-1", displayName: "Alice" }
    });
    expect(parseClaudeAccount(raw)).toEqual({
      email: "alice@example.com",
      accountId: "uuid-1",
      userId: "hash-1",
      displayName: "Alice",
      source: "claude"
    });
  });

  it("returns null when ~/.claude.json has no account identity", () => {
    expect(parseClaudeAccount(JSON.stringify({ numStartups: 3 }))).toBeNull();
    expect(parseClaudeAccount("not json")).toBeNull();
  });

  it("parses the Codex account, decoding the id_token JWT for the email", () => {
    const raw = JSON.stringify({
      tokens: { account_id: "acc-1", id_token: jwt({ email: "bob+chatgpt@example.com", name: "Bob" }) }
    });
    expect(parseCodexAuth(raw)).toEqual({
      email: "bob+chatgpt@example.com",
      accountId: "acc-1",
      displayName: "Bob",
      source: "codex"
    });
  });

  it("keeps the Codex +alias email as-is (no normalization)", () => {
    const raw = JSON.stringify({ tokens: { id_token: jwt({ email: "x+chatgpt@gmail.com" }) } });
    expect(parseCodexAuth(raw)?.email).toBe("x+chatgpt@gmail.com");
  });

  it("decodeJwtPayload returns claims or null", () => {
    expect(decodeJwtPayload(jwt({ email: "z@z.com" }))).toMatchObject({ email: "z@z.com" });
    expect(decodeJwtPayload("garbage")).toBeNull(); // single segment
    expect(decodeJwtPayload("only.two")).toBeNull(); // payload segment isn't valid JSON
  });

  it("builds a github identity from gh fields", () => {
    expect(githubIdentity("cliftonc", "Clifton Cunningham", "c@c.com")).toEqual({
      githubLogin: "cliftonc",
      displayName: "Clifton Cunningham",
      email: "c@c.com",
      source: "github"
    });
    expect(githubIdentity(undefined, undefined, undefined)).toBeNull();
  });
});

describe("resolveIdentity", () => {
  const config: FiniusConfig = {
    serverUrl: "http://localhost:8787",
    identity: {
      claude: { email: "alice@example.com", accountId: "uuid-1", userId: "hash-1" },
      codex: { email: "alice+chatgpt@example.com", accountId: "acc-1" },
      githubLogin: "alice",
      displayName: "Alice"
    }
  };

  it("prefers the stored config slot and layers on the shared github fields", () => {
    expect(resolveIdentity("claude", config)).toMatchObject({
      email: "alice@example.com",
      accountId: "uuid-1",
      userId: "hash-1",
      githubLogin: "alice",
      displayName: "Alice",
      source: "config"
    });
  });

  it("uses the codex slot (as-is) for codex uploads", () => {
    expect(resolveIdentity("codex", config)).toMatchObject({
      email: "alice+chatgpt@example.com",
      accountId: "acc-1",
      githubLogin: "alice",
      source: "config"
    });
  });

  it("returns a github-only identity when nothing else resolves", () => {
    const ghOnly: FiniusConfig = { serverUrl: "x", identity: { githubLogin: "ghost", displayName: "Ghost" } };
    // No config slot and (in CI) no Claude account / git email — falls through to the shared github fields.
    const resolved = resolveIdentity("claude", ghOnly, "/nonexistent-dir-xyz");
    expect(resolved?.githubLogin).toBe("ghost");
  });
});
