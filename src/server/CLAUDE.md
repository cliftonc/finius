# Claude Code telemetry reference

Authoritative catalog of the OpenTelemetry signals Claude Code emits and how Finius ingests them.
Source: https://code.claude.com/docs/en/monitoring-usage (verified against real payloads in `data/`).

## Ingest pipeline

- **Metrics** → `POST /otlp/v1/metrics` → `SqliteStorageAdapter.ingestOtelMetrics`:
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
  source. Ingesting the logs as `otlp_metrics` would flip the session to `metric_source='otel'` and shadow
  the far more complete JSONL — undercounting tokens and zeroing cost. So Codex token/cost come solely from
  the rollout JSONL; the OTel logs are kept as `log_events` for inspection only.
- **Computed cost (`pricing.ts`).** Agents that don't report cost (Codex rollouts; most JSONL Claude
  transcripts) get cost synthesized at ingest: `processImport` calls `computeCostPoints(tokenPoints,
  priceIndex)` when the parse produced no real cost point, emitting `finius.cost.computed` (`kind:"cost"`,
  `unit:"USD"`) points that copy the token point's signal/source/session/model/timestamp — so existing
  `SUM(CASE WHEN kind='cost'…)` and `jsonlWins` handle them unchanged (computed JSONL cost is shadowed
  when the session also has authoritative OTel cost; **never double-counted**). Pricing comes from the
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
  tests, the CLI backfill, and anywhere the `ImportResult` is needed. The JSONL path does **not** feed
  `metric_rollup` and does not use `raw_batches`. `settleIngest()` drains the queue (tests/shutdown).
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
  `metric_source` — the authoritative signal, resolved to `'otel'` whenever OTel has ever been seen,
  else `'jsonl'`. That stored flag **is** the read-time precedence; nothing recomputes "which sessions
  have OTel" at query time.
- **OTel ↔ JSONL precedence (no double counting).** OTel and a transcript for the same session both
  carry token/cost, so they must not be summed. The rollup is **OTel-only**; JSONL is a per-session
  *fallback* folded in at read time: a JSONL point counts only when its session's stored
  `metric_source = 'jsonl'` (`jsonlWins`, a `session_row_id IN (SELECT id FROM sessions WHERE
  metric_source = 'jsonl')` check). Default reads = OTel + JSONL-for-OTel-less-sessions
  (`EFFECTIVE_ROLLUP` = `metric_rollup` UNION the unshadowed JSONL points reshaped as rollup rows).
  An explicit `source` filter bypasses precedence (raw per-source numbers) so you can compare OTel
  (`source=claude-code`) against the transcript (`source=claude-code-jsonl`) for the same session;
  `canUseRollup` routes non-OTel source filters to `metric_points` so shadowed JSONL is still visible.
- Reads: the home view (summary, hour/day/week timeseries, filter options) is served from the
  effective rollup; session-filtered reads, sub-hour timeseries (the live view), and the
  session/people/model drill-downs read `metric_points` with the `jsonlWins` precedence predicate.
  `listSessions`/`getSession` go through one `buildSessions` builder: one row per session exposing
  `metricSource`/`hasOtel`/`hasJsonl`, joining only the authoritative signal's points by default (an
  explicit `source` filter swaps in that source's raw points for comparison). It also returns
  `otelTotalTokens`/`jsonlTotalTokens` — whole-session per-signal token totals via correlated
  subqueries (independent of the join and the model/source filters) so the UI can show the delta when
  both signals exist; they routinely disagree (OTel often misses requests the transcript captured). Distinct counts
  (sessions/users) always come from `metric_points` — they can't be summed across rollup buckets.
- Schema is created clean (no legacy migrations); there is no `PRAGMA user_version` ladder. The old
  per-source session rows and the `raw_events` audit table are gone.
- Maintenance: `POST /api/maintenance/prune-raw-batches` (bearer `FINIUS_CRON_TOKEN`, fails closed)
  deletes `raw_batches` older than `FINIUS_RAW_RETENTION_DAYS` (default 7).
- Transcript parsing is dispatched by `transcripts.ts`; agent-specific parsers live in `claude.ts`
  and `codex.ts`. Parsers stay pure; storage/aggregation lives in `storage/sqlite.ts`, and the blob
  store is `storage/blob.ts`.

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
