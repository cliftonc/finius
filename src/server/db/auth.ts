// Auth-token CRUD: free functions over the Drizzle handle for the `auth_tokens` table. Extracted
// from the storage adapter; the adapter forwards its auth methods here unchanged. Async via the
// builder `.execute()` so the same code runs on node:sqlite and Postgres.

import { type DrizzleDb } from "./client.js";
import { desc, eq } from "drizzle-orm";
import { authTokens } from "./schema-active.js";
import type { AuthTokenRecord } from "../types.js";

export async function createAuthToken(db: DrizzleDb, tokenHash: string, label: string, now: number, userRowId: number | null = null): Promise<void> {
  await db.insert(authTokens).values({ tokenHash, label, createdAt: now, userRowId }).execute();
}

export async function findAuthToken(db: DrizzleDb, tokenHash: string): Promise<{ id: number; revoked: number; userRowId: number | null } | null> {
  const row = (
    await db
      .select({ id: authTokens.id, revoked: authTokens.revoked, userRowId: authTokens.userRowId })
      .from(authTokens)
      .where(eq(authTokens.tokenHash, tokenHash))
      .limit(1)
      .execute()
  )[0];
  if (!row) return null;
  // Best-effort touch so the admin GUI can show recency; failures here must not block auth.
  try {
    await db.update(authTokens).set({ lastUsedAt: Date.now() }).where(eq(authTokens.id, row.id)).execute();
  } catch {
    /* ignore */
  }
  return row;
}

export async function listAuthTokens(db: DrizzleDb): Promise<AuthTokenRecord[]> {
  return (await db
    .select({
      id: authTokens.id,
      label: authTokens.label,
      createdAt: authTokens.createdAt,
      lastUsedAt: authTokens.lastUsedAt,
      revoked: authTokens.revoked,
      userRowId: authTokens.userRowId
    })
    .from(authTokens)
    .orderBy(desc(authTokens.createdAt))
    .execute()) as AuthTokenRecord[];
}

export async function revokeAuthToken(db: DrizzleDb, id: number): Promise<void> {
  await db.update(authTokens).set({ revoked: 1 }).where(eq(authTokens.id, id)).execute();
}
