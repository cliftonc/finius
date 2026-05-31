# Refactor: Dashboard Setup Script

## Problem

The dashboard setup modal hardcodes telemetry endpoints for `http://localhost:8787` and shows env vars without auth headers.

The CLI already supports configured server URLs and Secure Mode credentials, so the dashboard guidance can drift from the real setup path.

## Why It Matters

Users running on a custom port, remote host, or Secure Mode server can copy instructions that do not work. This is especially confusing because the rest of the app is designed around `finius setup` keeping server URL, auth, and hooks aligned.

## Pragmatic Plan

1. Generate endpoint URLs from `window.location.origin`.
2. Make `finius setup` the primary recommendation in the modal.
3. If Secure Mode is enabled, include `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>` only when the token is available to the client.
4. Otherwise, explain that the CLI-managed setup is required for authenticated telemetry.

## Suggested First Step

Replace hardcoded `localhost:8787` in `SETUP_SCRIPT` with the current origin and update the copy to prefer the CLI path.
