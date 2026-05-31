# Finius

Local-first Claude Code usage tracker for OTLP HTTP JSON metrics and JSONL transcript imports.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173 for the UI. The API listens on http://localhost:8787.

## Claude Code telemetry

Start Claude Code with:

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

Data is stored in `data/finius.sqlite` by default. Override with `FINIUS_DB_PATH=/path/to/db.sqlite`.
