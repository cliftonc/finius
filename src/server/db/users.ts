// Users registry: free functions over the Drizzle handle for the `users` table — find/upsert/enrich
// and the OAuth account link. Extracted from the storage adapter so the
// metrics/sessions/people read modules (and the adapter's ingest) can share one implementation.
// Every function takes the Drizzle handle (`db`) as its first arg and uses ONLY it (the same shared
// connection the adapter's transactions run on), so an upsert called inside an adapter BEGIN/COMMIT
// and a directory read called outside any transaction both work unchanged.

import { type DrizzleDb } from "./client.js";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { oauthAccounts, users } from "./schema.js";
import type { AuthUser, MetricPointInput, OAuthUserInput } from "../types.js";

// Friendly identity fields resolved from the `users` registry and attached to display rows (People,
// the summary Users breakdown, sessions) so lists can prefer a GitHub login / display name over email.
export type UserIdentityFields = { email: string | null; displayName: string | null; githubLogin: string | null };

// Find-or-enrich the user for an identity, deduping by the strongest available key (email is the
// canonical "same user" key; account_id/user_id/github_login are secondary links). On a hit we
// COALESCE-fill any columns we didn't know before and widen the seen window; otherwise we insert a
// new row. Returns the user row id, or null for a fully-unknown identity.
// v1 note: this enriches an existing row but does NOT retroactively merge two pre-existing rows that
// later prove to be the same person (e.g. an account-only row and an email-only row seen separately).
export function upsertUser(
  db: DrizzleDb,
  id: Pick<MetricPointInput, "userEmail" | "userAccountId" | "userId" | "githubLogin" | "displayName">,
  ts: number
): number | null {
  const email = id.userEmail || null;
  const accountId = id.userAccountId || null;
  const userId = id.userId || null;
  const githubLogin = id.githubLogin || null;
  const displayName = id.displayName || null;
  if (!email && !accountId && !userId && !githubLogin) return null;

  const found =
    (email && findUser(db, "email", email)) ||
    (accountId && findUser(db, "account_id", accountId)) ||
    (userId && findUser(db, "user_id", userId)) ||
    (githubLogin && findUser(db, "github_login", githubLogin)) ||
    null;

  if (found !== null) {
    db.update(users)
      .set({
        email: sql`coalesce(${users.email}, ${email})`,
        accountId: sql`coalesce(${users.accountId}, ${accountId})`,
        userId: sql`coalesce(${users.userId}, ${userId})`,
        githubLogin: sql`coalesce(${users.githubLogin}, ${githubLogin})`,
        displayName: sql`coalesce(${users.displayName}, ${displayName})`,
        firstSeenAt: sql`min(${users.firstSeenAt}, ${ts})`,
        lastSeenAt: sql`max(${users.lastSeenAt}, ${ts})`
      })
      .where(eq(users.id, found))
      .run();
    return found;
  }

  const [row] = db
    .insert(users)
    .values({ email, accountId, userId, githubLogin, displayName, firstSeenAt: ts, lastSeenAt: ts })
    .returning({ id: users.id })
    .all();
  return row.id;
}

export function findUser(db: DrizzleDb, column: "email" | "account_id" | "user_id" | "github_login", value: string): number | null {
  const col = { email: users.email, account_id: users.accountId, user_id: users.userId, github_login: users.githubLogin }[column];
  const row = db.select({ id: users.id }).from(users).where(eq(col, value)).limit(1).get();
  return row ? row.id : null;
}

// First existing user row matching any of the given emails (used to link an OAuth login to the
// person's telemetry identity when their provider primary email isn't the one on their sessions).
export function findUserByAnyEmail(db: DrizzleDb, emails: string[]): number | null {
  for (const email of emails) {
    if (!email) continue;
    const id = findUser(db, "email", email);
    if (id != null) return id;
  }
  return null;
}

export function getUserById(db: DrizzleDb, id: number): AuthUser | null {
  const row = db
    .select({ id: users.id, email: users.email, displayName: users.displayName, githubLogin: users.githubLogin })
    .from(users)
    .where(eq(users.id, id))
    .get();
  return row ?? null;
}

export function upsertOAuthUser(db: DrizzleDb, input: OAuthUserInput, now: number): AuthUser {
  const existing = db
    .select({ id: users.id })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userRowId))
    .where(and(eq(oauthAccounts.provider, input.provider), eq(oauthAccounts.providerUserId, input.providerUserId)))
    .get();
  // Prefer an already-linked account; otherwise try to attach to an existing telemetry user row by
  // ANY verified email (the GitHub primary often differs from the email seen on sessions). Falling
  // through to upsertUser dedupes by the primary email / github login or creates a fresh row.
  const userRowId =
    existing?.id ??
    findUserByAnyEmail(db, input.emails ?? []) ??
    upsertUser(
      db,
      {
        userEmail: input.email ?? null,
        githubLogin: input.githubLogin ?? null,
        displayName: input.displayName ?? null
      },
      now
    );
  if (userRowId == null) throw new Error("OAuth user has no linkable identity");

  db.run(sql`BEGIN`);
  try {
    db.update(users)
      .set({
        email: sql`coalesce(${users.email}, ${input.email ?? null})`,
        githubLogin: sql`coalesce(${users.githubLogin}, ${input.githubLogin ?? null})`,
        displayName: sql`coalesce(${users.displayName}, ${input.displayName ?? null})`,
        firstSeenAt: sql`min(${users.firstSeenAt}, ${now})`,
        lastSeenAt: sql`max(${users.lastSeenAt}, ${now})`
      })
      .where(eq(users.id, userRowId))
      .run();
    db.insert(oauthAccounts)
      .values({ provider: input.provider, providerUserId: input.providerUserId, userRowId, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [oauthAccounts.provider, oauthAccounts.providerUserId],
        set: { userRowId: sql`excluded.user_row_id`, updatedAt: sql`excluded.updated_at` }
      })
      .run();
    db.run(sql`COMMIT`);
  } catch (error) {
    db.run(sql`ROLLBACK`);
    throw error;
  }

  const user = getUserById(db, userRowId);
  if (!user) throw new Error("OAuth user link failed");
  return user;
}

// Map every identity value (email / account_id / user_id) to its users-registry row, so a People
// group keyed by any of those strings can be resolved to one canonical person for display.
export async function userDirectory(db: DrizzleDb): Promise<Map<string, UserIdentityFields>> {
  const userRows = (await db
    .select({
      email: users.email,
      accountId: users.accountId,
      userId: users.userId,
      displayName: users.displayName,
      githubLogin: users.githubLogin
    })
    .from(users)
    .execute()) as Array<{ email: string | null; accountId: string | null; userId: string | null; displayName: string | null; githubLogin: string | null }>;
  const map = new Map<string, UserIdentityFields>();
  for (const u of userRows) {
    const value = { email: u.email, displayName: u.displayName, githubLogin: u.githubLogin };
    for (const key of [u.email, u.accountId, u.userId, u.githubLogin]) if (key) map.set(key, value);
  }
  return map;
}

// Attach friendly identity fields (email / display name / GitHub login) from the `users` registry to
// rows keyed by their canonical identity string (`user`), so every list can prefer a GitHub login or
// display name over the raw email. Shared by People, the summary Users breakdown, and sessions.
export async function enrichUsers<T extends { user: string }>(db: DrizzleDb, rows: T[]): Promise<Array<T & UserIdentityFields>> {
  const directory = await userDirectory(db);
  return rows.map((row) => {
    const u = directory.get(row.user);
    return {
      ...row,
      email: u?.email ?? null,
      displayName: u?.displayName ?? null,
      githubLogin: u?.githubLogin ?? null
    };
  });
}
