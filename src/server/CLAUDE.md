# Claude Code telemetry reference

Authoritative catalog of the OpenTelemetry signals Claude Code emits and how Finius ingests them.
Source: https://code.claude.com/docs/en/monitoring-usage (verified against real payloads in `data/`).

## Ingest pipeline

- **Metrics** → `POST /otlp/v1/metrics` → `DrizzleStorageAdapter.ingestOtelMetrics`:
  - Batch deduped via `raw_batches.hash` UNIQUE. The full payload is stored in
    `raw_batches.payload_json` only when `FINIUS_RAW_PAYLOADS=retain` (default); `=off` stores the
    hash only. `parseOtelMetricRecords` is still parsed (not persisted) to feed `warnIfCumulative`.
  - Aggregated metrics (token/cost/lines/decision/active_time) parsed into `metric_points` via
    `parseOtelMetricPoints` → `classifyMetric`, and accumulated into the hourly `metric_rollup`
    (`upsertRollup`) inside the same transaction. Non-aggregated metric names are dropped.
- **Logs/events** → `POST /otlp/v1/logs` → deduped in `raw_batches`, then each record is flattened by
  `parseOtelLogRecords` (→ `OtelLogRecord`: eventName/severity/timestamp/sessionId/attributes/body) and
  indexed into the `log_events` table. **Not** parsed into `metric_points`. `GET /api/logs/events` groups
  them by event name with a sample. `eventName` precedence: the **`event.name` attribute FIRST**, then the
  top-level `eventName`, then the loose `lr.name` — Codex's tracing appender pollutes the top-level
  `eventName` with a Rust source location (e.g. `event otel/src/.../session_telemetry.rs:778`) and carries
  the real id (`codex.sse_event`, …) only in the `event.name` attribute, so attribute-first is what keeps
  records labeled right. **Codex's native telemetry is logs-only**, and Finius deliberately does NOT turn
  it into metrics: the `codex.sse_event` stream is a *partial, cost-less subset* of the rollout (only
  `response.completed` events since `[otel]` was enabled; ChatGPT-plan usage reports no cost), whereas the
  Codex **rollout-JSONL** path (`codex-cli-jsonl`, uploaded by the Stop hook) is the complete, cost-bearing
  source. Ingesting the logs as `otlp_metrics` would give the session a preferred (OTel) signal and so
  demote the far more complete JSONL transcript to comparison-only — undercounting tokens and zeroing
  cost. So Codex token/cost come solely from the rollout JSONL; the OTel logs are kept as `log_events`
  for inspection only.
- **Computed cost (`pricing.ts`).** Agents that don't report cost (Codex rollouts; most JSONL Claude
  transcripts) get cost synthesized at ingest: `processImport` calls `computeCostPoints(tokenPoints,
  priceIndex)` when the parse produced no real cost point, emitting `finius.cost.computed` (`kind:"cost"`,
  `unit:"USD"`) points that copy the token point's signal/source/session/model/timestamp — so they
  inherit the same `is_primary` disposition as their tokens (computed JSONL cost is shadowed when the
  session also has authoritative OTel cost; **never double-counted**). Pricing comes from the
  LiteLLM feed, fetched on startup (`startServer`→`syncPricing`; `FINIUS_PRICING_URL`,
  `FINIUS_PRICING_FETCH=off`), stored in `model_prices` (dated rows so historical usage is priced by the
  rate in effect), and loaded into an in-memory `PriceIndex`. `recomputeComputedCost()` rebuilds the
  synthesized points from existing token points (no transcript re-parse), exposed at `POST
  /api/maintenance/recompute-cost` (cron-token guarded) and run after each startup fetch. OTel cost is
  taken as-is (Claude reports `claude_code.cost.usage`); we synthesize only for JSONL.
- **JSONL transcripts** → `POST /api/import/{jsonl,claude-hook}` → `enqueueImport`: the upload is
  deduped by content sha256, the blob is saved **immediately**, and the parse/metrics/cost work is
  handed to a single in-process background queue (`SerialQueue`, `src/server/queue.ts`) that drains one
  job at a time. The route returns `{ duplicate, queued }` right away; the SSE `ingest` event fires from
  the queue when the job finishes (wired via `setProcessingListener` in `createApp`). The worker runs
  `processImport`: parse → historical-pricing backfill (below) → synthesize cost → insert `metric_points`
  (signal `jsonl`, source `claude-code-jsonl`) + record the `source_files` row, all in one transaction.
  Dedup before the persistent `source_files` row exists uses an in-memory in-flight hash set, so a job
  that fails can be retried. `importJsonl` is the synchronous variant (same `processImport`) used by
  tests, the CLI backfill, and anywhere the `ImportResult` is needed. **Primary** JSONL points feed
  `metric_rollup` like any primary point (Codex/manual transcripts, or a Claude/Copilot transcript whose
  session has no OTel); a shadowed transcript does not. The JSONL path does not use `raw_batches`.
  `settleIngest()` drains the queue (tests/shutdown).
- **Historical pricing backfill (`pricing-backfill.ts`).** During `processImport`, any token-usage day
  earlier than the earliest price we hold triggers a fetch (once per day, ever) of the LiteLLM price file
  **as it existed on that day**, reconstructed from the repo's git history on GitHub
  (`commits?path=…&until=<day>` → raw blob at that SHA → `normalizeLiteLlm` stamped with the commit
  date). Imported via `importPricing`, then `recomputeComputedCost()` re-prices prior imports. The
  fetcher is injected (`setHistoricalPriceFetcher`, default `githubSnapshot`) so storage stays out of the
  network; absent (tests / `FINIUS_PRICING_FETCH=off`) it's a no-op. `FINIUS_GITHUB_TOKEN` raises the
  rate limit.
- **Sessions are one row per UUID, with explicit source state.** The `sessions` table is keyed
  `session_id` UNIQUE (not `(source, session_id)`), so OTel and a transcript for the same session
  share one row. `upsertSession` maintains `has_otel`/`has_jsonl` (sticky OR over the 0/1 flags) and
  `metric_source` (`'otel'` whenever OTel has been seen, else `'jsonl'`). These are now **display
  state only** (returned in `SessionSummary`); read-time precedence is the materialized `is_primary`
  flag below, not a query against `metric_source`.
- **OTel ↔ JSONL precedence is materialized at ingest as `metric_points.is_primary` (no double
  counting).** OTel and a transcript for the same session both carry token/cost, so they must not be
  summed. Each provider has a **preferred signal** (the central registry `src/shared/sources.ts`:
  Claude/Copilot → `otlp_metrics`, Codex/manual → `jsonl`). A point is **primary** (`is_primary = 1`,
  counts toward dashboards) iff its signal is its session's provider's preferred signal, OR its session
  has no point of that preferred signal (the **fallback** — so a transcript-only Claude/Copilot session
  still counts). `insertMetricPoint` computes this from the registry + the session's current signal
  presence and stores it once; when the preferred signal first arrives for a session that only had the
  other signal (e.g. OTel after a backfilled transcript), the previously-promoted points are **demoted**
  to `is_primary = 0` and the rollup is rebuilt for that batch. This is exactly the old `jsonlWins`
  precedence, just materialized so reads are a plain `WHERE is_primary = 1`.
- **The rollup is unified over primary points.** `metric_rollup` (hourly) holds the aggregate of every
  `metric_points WHERE is_primary = 1` — both OTel and primary JSONL — maintained incrementally by
  `upsertRollup` on primary inserts and rebuilt wholesale by `rebuildRollup()` (on a transition, a
  Codex replace-by-session, the cost recompute, or the one-time legacy backfill). Default home-view
  reads (summary, hour/day/week timeseries, filter options) read `metric_rollup` directly. The old
  OTel-only rollup + `EFFECTIVE_ROLLUP` union are gone.
- **Comparison view.** An explicit `source` filter bypasses `is_primary` (raw per-source numbers) so you
  can compare OTel (`source=claude-code`) against the transcript (`source=claude-code-jsonl`) for the
  same session. `canUseRollup` routes ANY explicit source filter (and session/userRowId filters,
  sub-hour grains, non-hour-aligned ranges) to `metric_points`, since the rollup holds only primary
  points.
- Reads: session-filtered reads, sub-hour timeseries (the live view), and the session/people/model
  drill-downs read `metric_points` with the `is_primary = 1` predicate (`pointWhere` in
  `db/fragments.ts`). `listSessions`/`getSession` go through one `buildSessions` builder: one row per
  session exposing `metricSource`/`hasOtel`/`hasJsonl`, joining only `is_primary` points by default (an
  explicit `source` filter swaps in that source's raw points for comparison). It also returns
  `otelTotalTokens`/`jsonlTotalTokens` — whole-session per-signal token totals via correlated subqueries
  (independent of the join and the model/source filters) so the UI can show the delta when both signals
  exist; they routinely disagree (OTel often misses requests the transcript captured). Distinct counts
  (sessions/users) always come from `metric_points` — they can't be summed across rollup buckets.
- **Schema & migrations (Drizzle).** The schema is a Drizzle definition (`db/schema.ts`); the
  drizzle-kit migration under `db/migrations/` is the source of truth, applied at startup by
  `db/client.ts`'s `runMigrations` (called from the adapter constructor). A populated DB already in the
  wild is **adopted, not re-created**: the shim adds any missing columns (`user_row_id`, `is_primary`)
  before the (idempotent `IF NOT EXISTS`) baseline runs, backfilling `is_primary` as materialized
  `jsonlWins` (`signal='jsonl' AND metric_source='otel' → 0`) and rebuilding the rollup once. New schema
  changes go through drizzle-kit migrations. Uses `drizzle-orm@1.0.0-rc.3`'s `drizzle-orm/node-sqlite`
  driver over the built-in `DatabaseSync` (zero native deps). `tests/schema-parity.test.ts` guards the
  schema against drift. The old per-source session rows and the `raw_events` audit table are gone.
- Maintenance: `POST /api/maintenance/prune-raw-batches` (bearer `FINIUS_CRON_TOKEN`, fails closed)
  deletes `raw_batches` older than `FINIUS_RAW_RETENTION_DAYS` (default 7).
- **Per-provider domains.** Each agent has one module under `providers/` owning ALL of its parsing —
  `providers/claude.ts` (`parseClaudeTranscript` + the Claude OTLP-metric parser `parseOtelMetricPoints`
  / `classifyMetric` / `normalizeTokenType`), `providers/codex.ts` (`parseCodexTranscript`),
  `providers/copilot.ts` (`parseCopilotTranscript` + the Copilot OTLP-trace token parser
  `parseOtelTracePoints` / `otelTraceSessionDiagnostics` and the `isVsCodeCopilotSpan` session-id
  precedence). Only the **shared, reusable** OTLP helpers stay in `otel.ts` (generic decode/flatten/hash,
  `preferredIdentity`, `warnIfCumulative`, and the vendor-neutral `gen_ai.*` `tokenEntries`/
  `selectedTokenSpans`); shared JSONL value coercions live in `jsonl.ts`. Transcript parsing is dispatched
  by `transcripts.ts`. Adding a provider is one `providers/<x>.ts` file + one `src/shared/sources.ts`
  entry + one `transcripts.ts` switch arm. Parsers stay pure.
- **The storage adapter is a thin DB-neutral facade.** `DrizzleStorageAdapter` (`storage/adapter.ts`,
  the blob store is `storage/blob.ts`) owns only ingest orchestration, pricing, and the in-memory state
  (price index, blob, the `SerialQueue`, the in-flight dedup set); every DB access is a free function in
  the `db/` layer that it delegates to. SQLite is the only concrete binding (`db/client.ts`'s `connect` +
  `runMigrations`, and the `db/dialect.ts` SQL seam); the orchestration is otherwise database-neutral over
  the Drizzle handle, so a future Postgres backing is a new connect path + PG dialect, not an adapter
  rewrite. The `db/` modules (all free functions taking the Drizzle handle first): `ingest.ts`
  (`insertMetricPoint`/`upsertSession`/`upsertRollup`/`rebuildRollup`/`ingestMetricPoints` + raw-batch,
  log, source-file, prune helpers — the write side), `pricing-store.ts` (`model_prices` access +
  `recomputeComputedCost`), `metrics.ts` (summary/timeseries/breakdowns), `sessions.ts` (`buildSessions`),
  `people.ts` (people/models/filter options/log events), `users.ts` (the identity registry), `auth.ts`,
  with `db/fragments.ts` (composable `sql` WHERE fragments) and `db/dialect.ts` (the Postgres seam:
  `GROUP_CONCAT`/`json_extract`/time-bucketing live there, so a future Postgres dialect swaps one file).

## Temporality (important)

`claude_code.token.usage` and the other counters are exported with **DELTA** temporality
(`aggregationTemporality: 1`) — Claude Code's default (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`).
Each data point is the increment for that export window, **not** a cumulative running total, so Finius
**sums** data points. This is correct. `warnIfCumulative` logs once if a `cumulative` backend is ever
detected (which would overcount). Cache-read totals legitimately reach millions because prompt caching
re-reads the cached prefix on every request.

## Standard attributes (on every metric & event)

`session.id`, `app.version`, `app.entrypoint`, `organization.id`, `user.account_uuid`,
`user.account_id`, `user.id` (anonymous device id), `user.email`, `terminal.type`.
Finius identity precedence: `user.email` → `user.account_id` → `user.id` → `unknown`.

JSONL/rollout transcripts carry **no** identity in their bodies, so the `finius` CLI resolves one on
the client (Claude/Codex account, `gh`, or git — see `src/cli/identity.ts`) and sends it with the
upload; the import routes thread it onto the `sessionHint`. The server `users` table is the canonical
per-person registry, deduped by email, populated from both OTel and JSONL identities.

## Metrics

| Metric | Unit | Key attributes | Finius `metric_points` mapping |
| --- | --- | --- | --- |
| `claude_code.token.usage` | tokens | `type` = input \| output \| cacheRead \| cacheCreation; `model`, `query_source`, `speed`, `effort`, `agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`, `mcp_tool.name` | kind `tokens`, `token_type` normalized to input/output/`cache_read`/`cache_creation` |
| `claude_code.cost.usage` | USD | `model`, `query_source`, `speed`, `effort`, `agent.name`, `skill.name`, `plugin.name`, … | kind `cost` |
| `claude_code.lines_of_code.count` | count | `type` = added \| removed | kind `lines`, `token_type` = added/removed |
| `claude_code.code_edit_tool.decision` | count | `decision` = accept \| reject; `tool_name` = Edit/Write/NotebookEdit; `source`; `language` | kind `decision`, `token_type` = accept/reject |
| `claude_code.active_time.total` | s | `type` = cli \| user | kind `active_time`, `token_type` = cli/user (stored, not yet charted) |
| `claude_code.session.count` | count | `start_type` = fresh \| resume \| continue | kind `session`, `token_type` = start_type |
| `claude_code.pull_request.count` | count | standard only | kind `pull_request` |
| `claude_code.commit.count` | count | standard only | kind `commit` |

Note: `code_edit_tool.decision` carries `decision: "reject"` in the schema, but rejections are also
surfaced via `source` values (`user_reject`, `user_abort`). Finius counts `token_type = 'reject'`.

## Surfaced on the dashboard

- KPIs: cost, input, output, **cache write** (cacheCreation), **cache read** (cacheRead), sessions, senders.
- Timeseries (`getTimeseries`): per-bucket cost, input, output, cacheCreation, cacheRead, total tokens,
  linesAdded/Removed, editsAccepted/Rejected.
- Charts: Tokens, Cost, Lines of code (added/removed), Edit decisions (accepted/rejected).

## Events (logs) — counted only, not aggregated or stored per-record

`user_prompt`, `tool_result`, `api_request`, `api_error`, `api_request_body`, `api_response_body`,
`tool_decision`, `permission_mode_changed`, `auth`, `mcp_server_connection`, `internal_error`,
`plugin_installed`, `plugin_loaded`, `skill_activated`, `at_mention`, `api_retries_exhausted`,
`hook_registered`, `hook_execution_start`, `hook_execution_complete`, `hook_plugin_metrics`,
`compaction`, `feedback_survey`. (Traces/spans — `llm_request`, `tool`, `hook`, `interaction` — are a
separate beta signal Finius does not currently ingest.)
