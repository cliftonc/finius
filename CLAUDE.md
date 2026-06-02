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
npm run build      # tsc -p tsconfig.build.json -> dist + vite build -> dist/client
npm start          # node dist/server/index.js (serves built client if dist/client exists)
npm test           # vitest run
npm run typecheck  # tsc --noEmit (strict; type-checks src + tests + vite.config.ts)
```

### CLI (`npx finius`)

```bash
npx finius          # setup if unconfigured, else status + help
npx finius setup    # configure server URL + Claude Code OTEL env & upload hook (edits ~/.claude/settings.json)
npx finius serve    # single-process server: API + built dashboard on one port (default 8787)
npx finius service  # install|start|stop|status|logs|remove a Linux systemd unit wrapping `finius serve`
npx finius doctor   # diagnose: config ↔ settings OTEL endpoints ↔ reachable server + hook/PATH
npx finius hook     # internal: invoked by the SessionEnd/PreCompact hooks to upload a transcript
```

`service` (`src/cli/service.ts`) is **Linux/systemd-only** (refuses elsewhere) and wraps `finius serve`
in a unit. `renderServiceUnit` is the pure, unit-tested generator; the action runners do the IO +
`systemctl` calls. Default scope is system (`/etc/systemd/system/finius.service`, needs root — it
instructs `sudo` rather than escalating); `--user` writes `~/.config/systemd/user` and needs no root.
`ExecStart` uses the durable global-bin path (`resolveFiniusBin`, never the npx cache) and pins
`FINIUS_HOME` + a `PATH` that includes this CLI's node dir (so an nvm `env node` shebang resolves under
systemd's minimal env). `--port`/`--host` bake into `ExecStart`; otherwise the bind is taken from
config as usual. `status`/`logs` are read-only passthroughs (`systemctl status` / `journalctl -u
finius`, the latter with `-f`/`-n`) — no privilege gate, since they only show what the caller may
already see.

`serverUrl` is the **public, client-facing** base URL: `setup` writes the OTEL endpoints, upload hook,
and OAuth callback from it, `doctor` checks reachability against it, and `serve` shows it in the
banner. For a localhost/LAN setup `serve` also *derives its bind* from it (an explicit port in the URL
→ that port; loopback host → bind `127.0.0.1`, any other host → `0.0.0.0`) — so the served port and
the telemetry endpoints stay in lock-step, and `doctor` flags any drift (the usual reason telemetry
"doesn't arrive"). Behind a TLS-terminating reverse proxy the public origin (e.g.
`https://finius.cliftonc.nl`, no port) is **not** what the process should bind to, so the optional
`listen: { host?, port? }` config field sets the bind explicitly. `serve` bind precedence — port:
`--port` > `listen.port` > explicit port in `serverUrl` > `8787`; host: `--host` > `FINIUS_HOST` >
`listen.host` > host derived from `serverUrl`. A portless public URL contributes no bind port, so it
falls through to `listen.port` or the `8787` default (proxy forwards `443 → 8787`).

Build emits via `tsconfig.build.json` (`rootDir: src`, excludes `src/client`) so the server lands at
`dist/server/index.js` and the CLI at `dist/cli/index.js` (the `bin`). The plain `tsconfig.json`
stays the editor/typecheck config (wider `include`); don't point the build at it or output nests under
`dist/src`.

Requires Node with the built-in `node:sqlite` module (Node 22.5+; developed on v24).

## Telemetry

Run `./scripts/run-claude.sh` to launch Claude Code with all OTLP env vars pointed at the local
server. See that script for the canonical env-var set, or the README for the manual export commands.

## Architecture

- `src/server/index.ts` — exports `startServer(options)` which wires `SqliteStorageAdapter` +
  `EventBus` into the app, serves the built client (resolved relative to the module so it works under
  `npx`, falling back to `dist/client`), and binds to `127.0.0.1:8787`. Auto-starts only when run
  directly (`node dist/server/index.js`); the CLI's `serve` imports `startServer` instead.
- `src/cli/` — the `finius` CLI (the package `bin`). `index.ts` dispatches; `config.ts` reads/writes
  `~/.finius/config.json`; `setup.ts` is the interactive installer; `install.ts` does the global
  `npm i -g finius` so the bare `finius` command (and the hook) works on PATH; `claude-settings.ts`
  holds the pure (unit-tested) `~/.claude/settings.json` merge helpers; `hook.ts` uploads a transcript
  to `/api/import/claude-hook` (sends contents inline so the server need not share a filesystem);
  `serve.ts` calls `startServer` with data under `~/.finius`; `password.ts` generates the Secure Mode
  word-password (`unique-names-generator` dictionaries + `node:crypto` randomness). The installed hook
  command is `finius hook` when on PATH, else an absolute `node <cli> hook` fallback.
  `identity.ts` holds pure parsers for the local account state — `~/.claude.json` (`oauthAccount`),
  `~/.codex/auth.json` (`id_token` JWT, decoded not verified), `gh api user`, and `git config
  user.email` — plus `resolveIdentity(kind, config, cwd)` (config slot → live account → git). Transcript
  bodies carry no identity, so the hook/backfill resolve one and send `user_email/user_account_id/
  user_id/github_login/display_name` with the upload; `setup` captures+confirms it once into
  `config.identity` (Claude-account-preferred default, `gh` run only here to keep the hook fast).
  Identity config field in `config.json`: `identity` — `{ claude?, codex? }` slots (each `{ email,
  accountId, userId }`) plus shared `githubLogin`/`displayName`. Codex is stored as-is (its real
  ChatGPT account). Auth config fields in `config.json`: `authPassword` (master secret, on the
  server-owner machine) and
  `authToken` (a minted session token, on machines that joined a secure server); `resolveAuthToken`
  returns `authToken ?? authPassword` — the credential the hook/OTEL/doctor send. `setup` detects an
  existing secure server via `/api/health` and either prompts to log in (storing `authToken`) or offers
  to enable auth (generating `authPassword`).
- `src/server/app.ts` — Hono routes: `/otlp/v1/{metrics,logs}` ingest, `/api/metrics/{summary,timeseries}`,
  `/api/sessions[/:id]` (+ `/:id/transcript[/info]`), `/api/people`, `/api/models`, `/api/meta` (filter
  options), `/api/import/{jsonl,claude-hook}`, `/api/auth/login`, `/api/maintenance/prune-raw-batches`
  (bearer-token, fails closed), and the `/events` SSE stream. All list/metric routes accept the same
  filters (`from`, `to`, `source`, `user`, `model`, `session`) parsed by `readFilters`.
- **Auth ("Secure Mode").** When `authSecret` is set (`finius setup`'s generated word-password, saved as
  `authPassword` in `~/.finius/config.json`, passed through by `serve`, or `FINIUS_AUTH_PASSWORD`), a
  single `app.use("*")` gate guards every endpoint except the public ones (`/api/health`, which reports
  `{ secure }`; `/api/auth/login`; static client assets). It admits a request carrying the master
  password **or** a non-revoked minted session token (`isValidCredential`) via `Authorization: Bearer`
  or the `finius_auth` cookie. `POST /api/auth/login` exchanges the password for a token, stores its
  sha256 in `auth_tokens` (so a future admin GUI can list/revoke) and sets the cookie. New login methods
  (GitHub, etc.) extend `isValidCredential` — no route changes. When `authSecret` is unset Finius stays
  fully open (default). The browser shows a `LoginScreen` (App.tsx) on any 401; the CLI hook + OTEL
  exporter send the token (the latter via `OTEL_EXPORTER_OTLP_HEADERS`).
- `src/server/storage/sqlite.ts` — the `StorageAdapter` implementation. Owns the schema (`migrate()`),
  batch-level idempotency (`raw_batches.hash` UNIQUE), session upsert, the `users` registry, the hourly
  `metric_rollup`
  (`upsertRollup`, built once by `migrateRollup()` and maintained on ingest), and all aggregation SQL.
  Reads route to the rollup when possible (`canUseRollup`/`rollupWhere`) and fall back to
  `metric_points` for session filters, sub-hour timeseries, and distinct counts. The `users` table is
  one row per person, deduped by email (account_id/user_id/github_login as secondary link keys),
  populated from any identity seen (OTel or JSONL) via `upsertUser` in `upsertSession` and back-filled
  once from `sessions` (`migrateUsers`); `sessions.user_row_id` points at it and `listPeople` enriches
  each row with `displayName`/`githubLogin`/`email` from it (JS-side join, filter semantics unchanged).
- `src/server/storage/blob.ts` — `BlobStore` interface + `LocalBlobStore`; holds imported transcript
  files (content-addressed by sha256), linked to sessions via the `source_files` table.
- `src/server/otel.ts` — pure parsers: OTLP protobuf-JSON → `MetricPointInput[]`, attribute decoding,
  `stableHash`, `preferredIdentity`, token-type normalization.
- `src/server/transcripts.ts` dispatches transcript parsing; agent-specific parsers live in
  `src/server/claude.ts` and `src/server/codex.ts`.
- `src/server/events.ts` — in-process pub/sub `EventBus` backing the SSE stream.
- `src/server/types.ts` — shared types and the `StorageAdapter` interface.
- `src/client/` — React app. `api.ts` is the typed fetch layer; `ui/App.tsx` is the whole dashboard.
  View + filter state lives in the URL query string (`useUrlState`); Home/Sessions/People/Models tabs
  share one filter set, and clicking a session/person/model row (or a Home breakdown row) drills into
  the Home view by setting the matching filter — the drill-down page is just `HomeView` re-filtered.

Data lives in `data/finius.sqlite` (override with `FINIUS_DB_PATH`); imported transcripts live under
`<db-dir>/transcripts` (override with `FINIUS_BLOB_DIR`). Env knobs: `FINIUS_RAW_PAYLOADS`
(`retain`|`off`), `FINIUS_RAW_RETENTION_DAYS` (default 7), `FINIUS_CRON_TOKEN` (enables the prune
endpoint), `FINIUS_AUTH_PASSWORD` (enables Secure Mode; normally set via `finius setup`'s `authPassword`).

## Conventions

- ESM throughout (`"type": "module"`); server imports use `.js` extensions on relative paths so the
  emitted JS resolves — keep this when adding files.
- Storage logic goes behind the `StorageAdapter` interface; keep parsers in `otel.ts`, `claude.ts`,
  and `codex.ts` pure and side-effect-free so they stay unit-testable.
- Ingest paths are idempotent via `raw_batches.hash`; preserve the `{ duplicate: true }` short-circuit
  when adding new ingest sources.
- Tests use real on-disk SQLite in a tmp dir (see `tests/fixtures.ts`); favor that over mocking.
