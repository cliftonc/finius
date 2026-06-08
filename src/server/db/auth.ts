// Auth-token CRUD: free functions over the Drizzle handle for the `auth_tokens` table. Extracted
// from the storage adapter; the adapter forwards its auth methods here unchanged.

import { type DrizzleDb } from "./client.js";
import { desc, eq } from "drizzle-orm";
import { authTokens } from "./schema.js";
import type { AuthTokenRecord } from "../types.js";

export function createAuthToken(db: DrizzleDb, tokenHash: string, label: string, now: number, userRowId: number | null = null): void {
  db.insert(authTokens).values({ tokenHash, label, createdAt: now, userRowId }).run();
}

export function findAuthToken(db: DrizzleDb, tokenHash: string): { id: number; revoked: number; userRowId: number | null } | null {
  const row = db
    .select({ id: authTokens.id, revoked: authTokens.revoked, userRowId: authTokens.userRowId })
    .from(authTokens)
    .where(eq(authTokens.tokenHash, tokenHash))
    .get();
  if (!row) return null;
  // Best-effort touch so the admin GUI can show recency; failures here must not block auth.
  try {
    db.update(authTokens).set({ lastUsedAt: Date.now() }).where(eq(authTokens.id, row.id)).run();
  } catch {
    /* ignore */
  }
  return row;
}

export function listAuthTokens(db: DrizzleDb): AuthTokenRecord[] {
  return db
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
    .all() as AuthTokenRecord[];
}

export function revokeAuthToken(db: DrizzleDb, id: number): void {
  db.update(authTokens).set({ revoked: 1 }).where(eq(authTokens.id, id)).run();
}
