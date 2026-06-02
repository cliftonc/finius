# Finius quick-start

Finius is a local-first Claude Code / Codex usage tracker: a single process ingests OpenTelemetry
metrics + JSONL transcripts into SQLite and serves a dashboard. This guide walks three setups:

1. [Local, single machine](#1-local-single-machine-no-auth) — no auth, fastest path.
2. [Team deployment](#2-team-deployment-on-a-server) — a shared server behind a real domain + TLS.
3. [GitHub OAuth login](#3-github-oauth-login) — gate the dashboard by GitHub org membership.

Requires **Node 22.5+** (Finius uses the built-in `node:sqlite`; developed on Node 24).

---

## 1. Local, single machine (no auth)

The default. Everything runs on `127.0.0.1`, so there's nothing to lock down.

### Step 1 — Run setup

```bash
npx @cliftonc/finius
```

The first run installs `finius` globally and walks you through setup. Answer the prompts:

| Prompt | Answer |
| --- | --- |
| **Finius server URL** | `http://localhost:8787` (the default — just press enter) |
| **Require authentication to view/ingest?** | **No** (local-only; nothing else can reach `127.0.0.1`) |
| **Your email for attribution** | Accept the detected email (so sessions are attributed to you) |
| **Add OpenTelemetry env vars / install the hook?** | **Yes** to both — this is what makes Claude Code report usage |
| **Import your existing sessions now?** | Optional — backfills past transcripts |

Setup writes config to `~/.finius/config.json` and adds the OTEL env vars + the upload hook to
`~/.claude/settings.json`.

### Step 2 — Start the server

```bash
finius serve
```

This serves the API **and** the dashboard on one port:

```
● Finius is live · http://localhost:8787
  Auth   open (no auth)
```

Open **http://localhost:8787** in your browser.

### Step 3 — Run a Claude Code session

**Restart any open Claude Code sessions** (env vars are read at launch), then just use Claude Code
normally. Usage streams to the dashboard live (it updates over SSE — no refresh needed).

> Already had Claude Code open, or want a one-off without editing your settings? Use the bundled
> launcher, which exports the telemetry env vars for a single run:
> ```bash
> ./scripts/run-claude.sh
> ```

### Verify

```bash
finius doctor   # checks config ↔ settings ↔ server reachability + the hook/PATH
```

If usage isn't showing up, `doctor` is the first stop — the usual cause is the served port and the
telemetry endpoints having drifted apart.

### Useful local config

All optional — set as environment variables before `finius serve`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FINIUS_DB_PATH` | `~/.finius/data/finius.sqlite` | SQLite location |
| `FINIUS_BLOB_DIR` | `~/.finius/transcripts` | imported transcript storage |
| `--port N` / `PORT` | `8787` (or the explicit port in `serverUrl`) | bind port |
| `--host H` / `FINIUS_HOST` | derived from `serverUrl` (loopback → `127.0.0.1`, else `0.0.0.0`) | bind host |
| `FINIUS_RAW_PAYLOADS` | `retain` | set `off` to store only batch hashes |
| `FINIUS_PRICING_FETCH` | `on` | set `off` to stay fully offline (uses cached prices) |

---

## 2. Team deployment on a server

Run one Finius instance on a host, put it behind a reverse proxy that terminates TLS, and point
everyone's Claude Code at the public domain. Finius itself stays bound to `127.0.0.1` — only the
proxy is exposed.

### Step 1 — Choose authentication

A public server **must** be secured (otherwise anyone can read your usage and POST telemetry). Two
options:

- **Shared password (Secure Mode)** — a generated word-password (e.g. `blue-happy-otter`). Simplest;
  good for a small trusted team. Covered here.
- **GitHub OAuth (org-gated)** — members sign in with GitHub, no shared secret to circulate. See
  [section 3](#3-github-oauth-login).

### Step 2 — Configure + run on the server

On the server, run setup and point it at the **public URL** you'll serve. `serverUrl` is the
**client-facing** address — Finius derives the telemetry endpoints, the OAuth callback, and the cookie
`Secure` flag from it. It is *not* the address Finius binds to: behind a TLS-terminating proxy the
public origin is `https://…` on 443, which the proxy owns, not Finius.

```bash
npx @cliftonc/finius setup https://finius.example.com
```

- **Require authentication?** → **Yes**. Setup generates and prints a password — **save it now**; it's
  how teammates and the dashboard log in.
- The password is stored as `authPassword` in `~/.finius/config.json` on this (owner) machine.

Then start the server, **binding to localhost** on a plain local port (the proxy reaches it; nothing
else should). Because the public `serverUrl` carries no port, `finius serve` defaults the bind to
`8787` — set the host so Finius isn't exposed directly:

```bash
FINIUS_HOST=127.0.0.1 finius serve
```

> The bind is decoupled from the public `serverUrl`. A port-less `https://` URL **no longer** resolves
> to 443 — `finius serve` defaults to `8787` and the proxy forwards `443 → 8787`. To pin the bind
> persistently (instead of via flags/env on every launch), add a `listen` block to
> `~/.finius/config.json`:
>
> ```json
> {
>   "serverUrl": "https://finius.example.com",
>   "listen": { "host": "127.0.0.1", "port": 8787 }
> }
> ```
>
> Bind precedence — port: `--port` > `listen.port` > explicit port in `serverUrl` > `8787`; host:
> `--host` > `FINIUS_HOST` > `listen.host` > host derived from `serverUrl`.

To survive reboots, run it under systemd. Finius ships a helper that writes, enables, and starts the
unit for you (Linux only):

```bash
finius service install        # system unit at /etc/systemd/system (needs root; use sudo)
# or, no root needed:
finius service install --user # ~/.config/systemd/user (then `loginctl enable-linger <you>`)
```

`install` enables + starts it immediately; `finius service start|stop|remove` manage it afterward. The
unit runs `finius serve` (bind taken from your `listen`/`serverUrl` config — keep `FINIUS_HOST` at
`127.0.0.1`, or pass `--port`/`--host` to `install` to bake them in), pins `FINIUS_HOME`, and fixes up
`PATH` so an nvm-installed node resolves. Check it with `systemctl status finius` /
`journalctl -u finius -f`.

> Prefer to hand-write the unit (or inject `FINIUS_AUTH_PASSWORD` via the environment rather than the
> config file)? A minimal `[Service]` is just `ExecStart=/usr/local/bin/finius serve`,
> `Environment=FINIUS_HOST=127.0.0.1`, `User=<you>`, `Restart=on-failure`.

### Step 3 — Route a domain + terminate SSL in front

Point a DNS record (`finius.example.com`) at the server, get a cert (e.g. Let's Encrypt / Caddy /
your load balancer), and terminate TLS in the proxy. Finius speaks plain HTTP on `127.0.0.1:8787`.

**nginx** example — note the SSE-friendly settings on `/events` and `/otlp` (buffering **off**, long
read timeout, HTTP/1.1). Without these the live stream and telemetry can stall:

```nginx
server {
    listen 443 ssl;
    server_name finius.example.com;

    ssl_certificate     /etc/letsencrypt/live/finius.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/finius.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

        # Required for the SSE live stream (/events) and streaming ingest (/otlp):
        proxy_buffering    off;
        proxy_read_timeout 1h;
    }
}
# Redirect http → https
server {
    listen 80;
    server_name finius.example.com;
    return 301 https://$host$request_uri;
}
```

**Caddy** does the same in two lines (and gets you a cert automatically):

```
finius.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Visit `https://finius.example.com` — you should get the login screen.

### Step 4 — Each teammate joins

On every machine that runs Claude Code, point setup at the same public URL:

```bash
npx @cliftonc/finius setup https://finius.example.com
```

Setup detects the server is secured and prompts for the password (or a browser login). On success it
saves a **per-machine session token** (`authToken`) — not the master password — and wires that token
into Claude Code's `OTEL_EXPORTER_OTLP_HEADERS` so their telemetry is accepted. They restart Claude
Code and they're reporting.

> **TLS is required end-to-end here.** Session tokens travel in request headers; only expose Finius
> over `https://`. Keep `FINIUS_HOST=127.0.0.1` so the only public surface is the TLS-terminating proxy.

---

## 3. GitHub OAuth login

Instead of a shared password, let teammates sign in with GitHub and gate access by **membership of a
GitHub organization**. Finius mints a normal session for anyone who authenticates **and** is an active
member of your org. This is "GitHub-only Secure Mode" — the dashboard shows a single *Sign in with
GitHub* button (no password field), and enabling it locks the server on its own.

### Step 1 — Create a GitHub **OAuth App** (not a GitHub App)

This matters: Finius uses the OAuth **authorization-code** flow. A *GitHub App* is a different product
(it sends `installation_id` / `setup_action` callbacks, which Finius detects and rejects with a hint).
You want an **OAuth App**.

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
   (For an org-owned app instead: **Org → Settings → Developer settings → OAuth Apps**.)
2. Fill in:
   - **Application name**: `Finius`
   - **Homepage URL**: `https://finius.example.com`
   - **Authorization callback URL**: `https://finius.example.com/api/auth/github/callback`
     *(must match exactly — `finius setup` prints this string for you)*
3. **Register application**, copy the **Client ID**, then **Generate a new client secret** and copy it.

> **Org visibility:** Finius requests the `read:org` scope to confirm membership. If your organization
> restricts third-party OAuth app access (**Org → Settings → Third-party access**), an org owner must
> approve the Finius OAuth app — otherwise the membership check can't see private membership and login
> is denied. The check accepts a member whose org membership state is **active**.

### Step 2 — Enable it in `finius setup`

Run setup on the **server** (OAuth is configured when setting up a not-yet-running local server):

```bash
npx @cliftonc/finius setup https://finius.example.com
```

- At **Require authentication?** you can answer **No** — GitHub OAuth secures the server by itself.
- At **Enable GitHub OAuth login for the dashboard?** → **Yes**, then provide:
  - **GitHub OAuth client ID**
  - **GitHub OAuth client secret**
  - **Required GitHub organization** (the org login, e.g. `my-org`)
- Setup echoes the callback URL to register (step 1) and, since there's no password to exchange,
  generates an **owner token** so this machine's own hook/OTEL uploads keep working.

This is stored in `~/.finius/config.json`:

```jsonc
{
  "serverUrl": "https://finius.example.com",
  "authToken": "…",                 // this server/owner machine's CLI credential
  "auth": {
    "oauth": {
      "github": {
        "enabled": true,
        "clientId": "Ov23li…",
        "clientSecret": "…",
        "requiredOrg": "my-org"
      }
    }
  }
}
```

Start it the same way as section 2 (`FINIUS_HOST=127.0.0.1 finius serve`, or a `listen` block in the
config) behind your TLS proxy. The startup panel will read:

```
Auth   secure mode · GitHub OAuth, org: my-org
```

### Step 3 — How people sign in

- **Dashboard:** open `https://finius.example.com` → **Sign in with GitHub** → authorize. If you're an
  active member of the required org, Finius sets an HttpOnly session cookie and drops you on the
  dashboard. Non-members are turned away. (Use the **Mine** toggle to filter to your own usage.)
- **Their Claude Code telemetry (CLI):** on each teammate's machine,
  `npx @cliftonc/finius setup https://finius.example.com` detects the secure server and prints a login
  URL to open in the browser; it then waits, and completing the GitHub sign-in hands a per-machine
  token back to the CLI (via a local loopback callback), which it wires into Claude Code's telemetry
  headers. No shared secret needed.

### Notes

- **HTTPS is required.** OAuth callbacks and the session cookie (`Secure`, `HttpOnly`, `SameSite=Lax`)
  assume the browser talks to Finius over `https://` — which the public domain in `serverUrl` provides.
- **Rotating the secret:** re-run `finius setup`, paste a new client secret (leave blank to keep the
  current one), and restart `finius serve`.
- **Logging out** revokes that session token server-side and clears the cookie.
```
