#!/usr/bin/env bash
#
# Launch Claude Code with OpenTelemetry pointed at the local Finius server.
#
# Usage:
#   ./scripts/run-claude.sh [claude args...]
#
# Any extra arguments are forwarded to `claude`, e.g.:
#   ./scripts/run-claude.sh "summarize this repo"
#
# Override the server location with FINIUS_HOST / FINIUS_PORT before invoking.

set -euo pipefail

FINIUS_HOST="${FINIUS_HOST:-localhost}"
FINIUS_PORT="${FINIUS_PORT:-8787}"
BASE_URL="http://${FINIUS_HOST}:${FINIUS_PORT}"

# --- Preflight: is the Finius server up? ------------------------------------
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS --max-time 2 "${BASE_URL}/api/health" >/dev/null 2>&1; then
    echo "⚠️  Finius server not reachable at ${BASE_URL}" >&2
    echo "    Start it first with:  npm run dev   (or  npm run dev:server)" >&2
    echo "    Continuing anyway — telemetry will be dropped until it's up." >&2
    echo >&2
  else
    echo "✅ Finius server is up at ${BASE_URL}"
  fi
fi

# --- Telemetry configuration ------------------------------------------------
# See https://docs.claude.com/en/docs/claude-code/monitoring-usage
export CLAUDE_CODE_ENABLE_TELEMETRY=1

export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp

export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json

export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="${BASE_URL}/otlp/v1/metrics"
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="${BASE_URL}/otlp/v1/logs"

# Short export intervals (ms) so metrics/logs show up quickly while testing.
# Defaults are 60s/5s; tighten them here. Override via env if you want.
export OTEL_METRIC_EXPORT_INTERVAL="${OTEL_METRIC_EXPORT_INTERVAL:-5000}"
export OTEL_LOGS_EXPORT_INTERVAL="${OTEL_LOGS_EXPORT_INTERVAL:-2000}"

echo "📡 Telemetry → ${BASE_URL}/otlp/v1/{metrics,logs}"
echo "   metric interval ${OTEL_METRIC_EXPORT_INTERVAL}ms · logs interval ${OTEL_LOGS_EXPORT_INTERVAL}ms"
echo

# --- Launch -----------------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  echo "❌ 'claude' CLI not found on PATH." >&2
  exit 1
fi

exec claude "$@"
