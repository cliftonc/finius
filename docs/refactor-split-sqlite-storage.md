# Refactor: Split SQLite Storage Adapter

## Problem

`src/server/storage/sqlite.ts` is the persistence facade and also owns schema creation, ingest, transcript processing, pricing, rollups, summaries, sessions, users, auth tokens, and SQL helper utilities.

The adapter is still understandable, but it is becoming the entire persistence layer in one file.

## Why It Matters

Storage is the highest-risk part of the app. As more agents, metrics, auth/admin features, and maintenance operations are added, unrelated changes will keep landing in the same large file.

## Pragmatic Target

Keep `SqliteStorageAdapter` as the public facade, but move cohesive internals into smaller modules:

```text
src/server/storage/
  sqlite.ts
  schema.ts
  imports.ts
  pricing-store.ts
  users.ts
  auth-tokens.ts
  query-helpers.ts
  queries/
    summary.ts
    timeseries.ts
    sessions.ts
    people.ts
    models.ts
```

## Suggested First Step

Start with pure or nearly pure extractions:

1. Move `GRANULARITY_MS`, `pointWhere`, `rollupWhere`, `canUseRollup`, and `EFFECTIVE_ROLLUP` into `query-helpers.ts`.
2. Move schema setup and migrations into `schema.ts`.
3. Move auth token methods into `auth-tokens.ts`.

Avoid changing SQL behavior during the split. Run storage tests after each extraction.
