import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorageAdapter } from "../src/server/storage/sqlite";
import { jsonlTranscript, otlpMetricBatch } from "./fixtures";

function tmpDbPath() {
  return join(mkdtempSync(join(tmpdir(), "finius-users-")), "test.sqlite");
}

let storage: SqliteStorageAdapter | null = null;

afterEach(() => {
  storage?.close();
  storage = null;
});

describe("users registry", () => {
  it("attributes a JSONL import to a user and surfaces friendly fields in listPeople", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    await storage.importJsonl("claude-code-jsonl", {
      sessionId: "s1",
      userEmail: "alice@example.com",
      githubLogin: "alice",
      displayName: "Alice A"
    }, jsonlTranscript("s1"));

    const people = await storage.listPeople({});
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      user: "alice@example.com",
      email: "alice@example.com",
      displayName: "Alice A",
      githubLogin: "alice"
    });
  });

  it("dedupes by email across sessions (same email ⇒ one user)", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    await storage.importJsonl("claude-code-jsonl", { sessionId: "s1", userEmail: "bob@example.com", displayName: "Bob" }, jsonlTranscript("s1"));
    // A later session for the same person, this time without a display name — must enrich, not duplicate.
    await storage.importJsonl("claude-code-jsonl", { sessionId: "s2", userEmail: "bob@example.com" }, jsonlTranscript("s2"));

    const people = await storage.listPeople({});
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ user: "bob@example.com", displayName: "Bob", sessions: 2 });
  });

  it("links an account-id-only identity to the email-bearing user (secondary key)", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    // First seen with only an account id (e.g. an early point lacking email)…
    await storage.importJsonl("claude-code-jsonl", { sessionId: "s1", userAccountId: "acct-9" }, jsonlTranscript("s1"));
    // …then a point that carries BOTH email and the same account id should merge into one user.
    await storage.importJsonl("claude-code-jsonl", { sessionId: "s2", userEmail: "carol@example.com", userAccountId: "acct-9" }, jsonlTranscript("s2"));

    const people = await storage.listPeople({});
    // Two identity STRINGS (account id, email) but they resolve to a single registry user enriched with both.
    const emails = people.map((p) => p.email).filter(Boolean);
    expect(new Set(emails)).toEqual(new Set(["carol@example.com"]));
  });

  it("shares one user row between an OTel session and a JSONL session with the same email", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    // otlpMetricBatch carries user.email = dev@example.com on session-a.
    await storage.ingestOtelMetrics(otlpMetricBatch("session-a"));
    await storage.importJsonl("claude-code-jsonl", { sessionId: "s-jsonl", userEmail: "dev@example.com", githubLogin: "devhandle" }, jsonlTranscript("s-jsonl"));

    const people = await storage.listPeople({});
    expect(people).toHaveLength(1);
    // OTel established the email; the JSONL import enriched the same user with the github handle.
    expect(people[0]).toMatchObject({ user: "dev@example.com", githubLogin: "devhandle" });
  });

  it("surfaces the friendly identity (github login/display name) on sessions and the summary breakdown", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    await storage.importJsonl(
      "claude-code-jsonl",
      { sessionId: "s1", userEmail: "alice@example.com", githubLogin: "alice", displayName: "Alice A" },
      jsonlTranscript("s1")
    );

    const sessions = await storage.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ userEmail: "alice@example.com", githubLogin: "alice", displayName: "Alice A" });

    const summary = await storage.getSummary({});
    expect(summary.users).toHaveLength(1);
    expect(summary.users[0]).toMatchObject({
      user: "alice@example.com",
      email: "alice@example.com",
      githubLogin: "alice",
      displayName: "Alice A"
    });
  });

  it("leaves people without any identity as 'unknown' (no user row forced)", async () => {
    storage = new SqliteStorageAdapter(tmpDbPath());
    await storage.importJsonl("manual-jsonl", { sessionId: "s1" }, jsonlTranscript("s1"));

    const people = await storage.listPeople({});
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ user: "unknown", email: null, displayName: null, githubLogin: null });
  });
});
