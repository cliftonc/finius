# Refactor: Shared API Types

## Problem

The server DTOs are defined in `src/server/types.ts`, while the client repeats matching types in `src/client/api.ts`.

This is manual contract duplication. Adding or renaming fields requires editing both sides, and TypeScript cannot catch drift between the API producer and consumer.

## Why It Matters

The API surface is growing: sessions, users, models, transcripts, auth, pricing, logs, and metric summaries. Manual duplication will become more expensive as those response shapes evolve.

## Pragmatic Plan

1. Create `src/shared/api-types.ts`.
2. Move public API response and filter types there:
   - `Summary`
   - `TimeseriesPoint`
   - `ModelTimeseriesPoint`
   - `SessionSummary`
   - `PersonSummary`
   - `ModelSummary`
   - `FilterOptions`
   - `TranscriptInfo`
   - `Granularity`
3. Import those types from both `src/server/types.ts` and `src/client/api.ts`.
4. Keep storage-only and ingest-only types in `src/server/types.ts`.

## Notes

Use type-only imports from the client so there is no runtime coupling between browser code and server modules.
