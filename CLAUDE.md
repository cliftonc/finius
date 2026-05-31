# Finius

Local-first Claude Code usage tracker. A Hono server ingests OTLP HTTP/JSON metrics & logs and
JSONL transcripts into SQLite; a React + Vite dashboard renders cost/token/session breakdowns with
live SSE updates.

## Commands

```bash
npm install
npm run dev        # server (tsx watch) + client (vite) via concurrently
npm run dev:server # API only — http://127.0.0.1:8787
npm run dev:client # UI only  — http://127.0.0.1:5173 (proxies /api, /otlp, /events to :8787)
npm run build      # tsc -> dist + vite build -> dist/client
npm start          # node dist/server/index.js (serves built client if dist/client exists)
npm test           # vitest run
npm run typecheck  # tsc --noEmit (strict)
```

Requires Node with the built-in `node:sqlite` module (Node 22.5+; developed on v24).

## Telemetry

Run `./scripts/run-claude.sh` to launch Claude Code with all OTLP env vars pointed at the local
server. See that script for the canonical env-var set, or the README for the manual export commands.

## Architecture

- `src/server/index.ts` — entry point. Wires `SqliteStorageAdapter` + `EventBus` into the app,
  serves the built client from `dist/client` when present, binds to `127.0.0.1:8787`.
- `src/server/app.ts` — Hono routes: `/otlp/v1/{metrics,logs}` ingest, `/api/metrics/{summary,timeseries}`,
  `/api/sessions[/:id]`, `/api/people`, `/api/models`, `/api/meta` (filter options), `/api/import/{jsonl,claude-hook}`,
  and the `/events` SSE stream. All list/metric routes accept the same filters (`from`, `to`, `source`,
  `user`, `model`, `session`) parsed by `readFilters`.
- `src/server/storage/sqlite.ts` — the `StorageAdapter` implementation. Owns the schema (`migrate()`),
  batch-level idempotency (`raw_batches.hash` UNIQUE), session upsert, and all aggregation SQL.
- `src/server/otel.ts` — pure parsers: OTLP protobuf-JSON → `MetricPointInput[]`, attribute decoding,
  `stableHash`, token-type normalization.
- `src/server/jsonl.ts` — pure parser: transcript lines → metric points (usage + cost extraction).
- `src/server/events.ts` — in-process pub/sub `EventBus` backing the SSE stream.
- `src/server/types.ts` — shared types and the `StorageAdapter` interface.
- `src/client/` — React app. `api.ts` is the typed fetch layer; `ui/App.tsx` is the whole dashboard.
  View + filter state lives in the URL query string (`useUrlState`); Home/Sessions/People/Models tabs
  share one filter set, and clicking a session/person/model row (or a Home breakdown row) drills into
  the Home view by setting the matching filter — the drill-down page is just `HomeView` re-filtered.

Data lives in `data/finius.sqlite` (override with `FINIUS_DB_PATH`).

## Conventions

- ESM throughout (`"type": "module"`); server imports use `.js` extensions on relative paths so the
  emitted JS resolves — keep this when adding files.
- Storage logic goes behind the `StorageAdapter` interface; keep parsers in `otel.ts`/`jsonl.ts` pure
  and side-effect-free so they stay unit-testable.
- Ingest paths are idempotent via `raw_batches.hash`; preserve the `{ duplicate: true }` short-circuit
  when adding new ingest sources.
- Tests use real on-disk SQLite in a tmp dir (see `tests/fixtures.ts`); favor that over mocking.
