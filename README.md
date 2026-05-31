# Finius

Local-first Claude Code usage tracker. A [Hono](https://hono.dev) server ingests OTLP HTTP/JSON
metrics & logs (and JSONL transcripts) into SQLite; a React + Vite dashboard renders cost, token,
session, person, and model breakdowns with live SSE updates.

## How to run it

### Prerequisites

- Node **22.5+** (uses the built-in `node:sqlite` module; developed on Node 24).

### 1. Install & start

```bash
npm install
npm run dev
```

`npm run dev` runs the API and UI together (via `concurrently`):

- **UI** → http://localhost:5173 (Vite dev server; proxies `/api`, `/otlp`, `/events` to the API)
- **API** → http://localhost:8787

Run them separately if you prefer: `npm run dev:server` (API only) or `npm run dev:client` (UI only).

### 2. Point Claude Code at the server

In the shell where you launch Claude Code, use the bundled helper — it checks the server is up,
exports the OTLP env vars, then runs `claude`:

```bash
./scripts/run-claude.sh                 # forwards any extra args to `claude`
```

Or export the variables manually:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:8787/otlp/v1/metrics
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:8787/otlp/v1/logs
claude
```

Run a Claude Code session and the dashboard updates live (SSE) as telemetry arrives.

### 3. (Optional) production build

```bash
npm run build   # tsc -> dist + vite build -> dist/client
npm start       # node dist/server/index.js, serves the built UI from dist/client on :8787
```

When a build exists, `npm start` serves the UI and API from the single port http://localhost:8787.

## Using the dashboard

- **Home** — KPIs (cost, tokens, cache, lines, edits, sessions, people), tokens/cost/lines/edits
  charts over time, plus Models / Users / Sources breakdowns.
- **Sessions**, **People**, **Models** — lists ranked by recency / cost. Click any row (or any Home
  breakdown row) to drill into the Home view filtered to that session, person, or model.
- **Filters** — time range, source, user, and model selects apply everywhere. All view and filter
  state lives in the URL query string, so any view is shareable/bookmarkable and back/forward works.

## Importing transcripts

Besides live OTLP telemetry, you can backfill from JSONL transcripts:

- `POST /api/import/jsonl` — body `{ content, source?, sessionId? }` (or raw JSONL text).
- `POST /api/import/claude-hook` — body `{ transcript_path, session_id?, cwd? }`; reads a local
  Claude Code transcript file (restricted to `~/.claude/projects` or the given `cwd`).

Imports are idempotent — re-sending the same data is detected and skipped.

## Storage

Data is stored in `data/finius.sqlite` by default. Override with `FINIUS_DB_PATH=/path/to/db.sqlite`.
Override the API port with `PORT`.

## Other commands

```bash
npm test         # vitest run
npm run typecheck # tsc --noEmit (strict)
```
