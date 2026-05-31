# Claude Code telemetry reference

Authoritative catalog of the OpenTelemetry signals Claude Code emits and how Finius ingests them.
Source: https://code.claude.com/docs/en/monitoring-usage (verified against real payloads in `data/`).

## Ingest pipeline

- **Metrics** → `POST /otlp/v1/metrics` → `SqliteStorageAdapter.ingestOtelMetrics`:
  - Full batch stored in `raw_batches.payload_json` (idempotent via `hash` UNIQUE).
  - Every metric data point stored in `raw_events` (signal `otlp_metrics`) via `parseOtelMetricRecords` — **all** metric names, nothing dropped.
  - Aggregated metrics (token/cost/lines/decision/active_time) parsed into `metric_points` via `parseOtelMetricPoints` → `classifyMetric`.
- **Logs/events** → `POST /otlp/v1/logs` → stored in `raw_events` (signal `otlp_logs`). Not parsed into metric_points.
- Parsers in `otel.ts` are pure; storage/aggregation in `storage/sqlite.ts`.

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

## Metrics

| Metric | Unit | Key attributes | Finius `metric_points` mapping |
| --- | --- | --- | --- |
| `claude_code.token.usage` | tokens | `type` = input \| output \| cacheRead \| cacheCreation; `model`, `query_source`, `speed`, `effort`, `agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`, `mcp_tool.name` | kind `tokens`, `token_type` normalized to input/output/`cache_read`/`cache_creation` |
| `claude_code.cost.usage` | USD | `model`, `query_source`, `speed`, `effort`, `agent.name`, `skill.name`, `plugin.name`, … | kind `cost` |
| `claude_code.lines_of_code.count` | count | `type` = added \| removed | kind `lines`, `token_type` = added/removed |
| `claude_code.code_edit_tool.decision` | count | `decision` = accept \| reject; `tool_name` = Edit/Write/NotebookEdit; `source`; `language` | kind `decision`, `token_type` = accept/reject |
| `claude_code.active_time.total` | s | `type` = cli \| user | kind `active_time`, `token_type` = cli/user (stored, not yet charted) |
| `claude_code.session.count` | count | `start_type` = fresh \| resume \| continue | not aggregated (raw_events only) |
| `claude_code.pull_request.count` | count | standard only | not aggregated (raw_events only) |
| `claude_code.commit.count` | count | standard only | not aggregated (raw_events only) |

Note: `code_edit_tool.decision` carries `decision: "reject"` in the schema, but rejections are also
surfaced via `source` values (`user_reject`, `user_abort`). Finius counts `token_type = 'reject'`.

## Surfaced on the dashboard

- KPIs: cost, input, output, **cache write** (cacheCreation), **cache read** (cacheRead), sessions, senders.
- Timeseries (`getTimeseries`): per-bucket cost, input, output, cacheCreation, cacheRead, total tokens,
  linesAdded/Removed, editsAccepted/Rejected.
- Charts: Tokens, Cost, Lines of code (added/removed), Edit decisions (accepted/rejected).

## Events (logs) — captured raw in `raw_events`, not aggregated

`user_prompt`, `tool_result`, `api_request`, `api_error`, `api_request_body`, `api_response_body`,
`tool_decision`, `permission_mode_changed`, `auth`, `mcp_server_connection`, `internal_error`,
`plugin_installed`, `plugin_loaded`, `skill_activated`, `at_mention`, `api_retries_exhausted`,
`hook_registered`, `hook_execution_start`, `hook_execution_complete`, `hook_plugin_metrics`,
`compaction`, `feedback_survey`. (Traces/spans — `llm_request`, `tool`, `hook`, `interaction` — are a
separate beta signal Finius does not currently ingest.)
