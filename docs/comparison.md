# How Finius compares

There's a healthy ecosystem of Claude Code / Codex / Copilot usage trackers. This page maps the
landscape and is honest about where Finius is strong, where other tools are stronger, and which
gaps are worth knowing about.

The single biggest differentiator between these tools is **how they get their data** — it determines
accuracy, which agents they support, whether they work for subscription vs API users, and whether
they can aggregate usage across multiple people and machines.

## Archetypes

| # | Pattern | How it works | Examples |
|---|---------|--------------|----------|
| 1 | **Local log-parser** | Reads the JSONL each agent writes to disk (`~/.claude`, `~/.codex`, VS Code workspace storage) | [ccusage](https://github.com/ryoppippi/ccusage), [phuryn/claude-usage](https://github.com/phuryn/claude-usage), [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) |
| 2 | **Proxy** | Intercepts the API traffic; most accurate, but you route through it | [ccflare](https://github.com/snipeship/ccflare) |
| 3 | **OTEL ingest server** | Agent pushes OpenTelemetry to a collector + store + UI you run | **Finius**, the [Grafana stack](#the-grafana--otel-stack-route), [OpenObserve](#openobserve), OTel→SQLite→React clones |
| 4 | **Vendor metrics API** | Pull aggregated org stats from the provider | [microsoft/copilot-metrics-dashboard](https://github.com/microsoft/copilot-metrics-dashboard) |
| 5 | **Editor extension** | Runs inside the editor, reads that editor's logs | [pvjagtap/github-copilot-usage-dashboard](https://github.com/pvjagtap/github-copilot-usage-dashboard) |

**Finius is the rare tool that straddles archetypes 1 + 3** — it ingests both live OpenTelemetry
*and* hook-uploaded JSONL transcripts — and points them at a multi-user server.

## At a glance

| | Finius | ccusage | phuryn/claude-usage | CC-Usage-Monitor | ccflare | Grafana / OpenObserve | copilot-metrics-dashboard | pvjagtap ext |
|---|---|---|---|---|---|---|---|---|
| **Pattern** | OTEL + JSONL | JSONL | JSONL | JSONL | Proxy | OTEL | Vendor API | Editor + OTEL |
| **Agents** | CC, Codex, Copilot | 10+ | Claude | Claude | CC, Codex | Claude (CC) | Copilot | Copilot |
| **UI** | Web + live SSE | CLI | Web (Chart.js) | Terminal TUI | Web + TUI | Grafana / OO dashboards | Web (Azure) | VS Code panel |
| **Persistent server** | ✅ | ❌ | ✅ local | ❌ | ✅ | ✅ stack | ✅ | ❌ in-editor |
| **Multi-user / team** | ✅ People view | ❌ | ❌ | ❌ | ~ | ~ shared collector | ✅ seats | ❌ |
| **Cross-machine push** | ✅ hooks + OTEL | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| **Per-session detail** | ✅ | ✅ | ✅ | partial | ✅ | ❌ metrics-only | ❌ | ✅ |
| **Cost source** | tokens × price | tokens × price | tokens × price | tokens × price | real traffic | tokens × price | n/a (adoption) | **exact AIU** |
| **Auth / remote host** | ✅ Secure Mode | n/a | ❌ | n/a | ~ | DIY | ✅ Azure auth | n/a |
| **Setup effort** | medium | trivial | trivial | trivial | medium | heavy | heavy | medium |

## The tools

### [ccusage](https://github.com/ryoppippi/ccusage)
The community default (~5k★). A local CLI that parses JSONL session logs and prints daily / weekly /
monthly / per-session / 5-hour-block reports, plus a `--live` monitor, JSON output, and an MCP
server mode. Broadest agent coverage by far — Claude Code, Codex, OpenCode, Amp, Droid, Copilot CLI,
Gemini CLI and more. Zero upload, single machine, no persistent dashboard or team rollup. Cost is
estimated from token counts × model pricing.
**Stronger than Finius at:** agent breadth and zero-friction personal checks (`npx ccusage`).

### [phuryn/claude-usage](https://github.com/phuryn/claude-usage)
"Claude Code Usage Dashboard" (Python stdlib, ~1.7k★) — architecturally the closest single-agent
analog to Finius's transcript path. Scans `~/.claude/projects/*.jsonl` → SQLite (`~/.claude/usage.db`)
→ a single-page Chart.js dashboard on `localhost:8080` with 30s auto-refresh, model filtering, and
bookmarkable URLs. Incremental scan via path+mtime. Captures CLI + VS Code extension + dispatched
sessions (not Cowork — server-side, no local JSONL). Cost from Anthropic API pricing.
Local, single-machine, single-user; no OTEL, no auth, no Codex/Copilot, no team aggregation.

### [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)
Real-time terminal TUI (Python / PyPI `claude-monitor`) focused on rate-limit survival: burn rate,
predictions, "you'll hit your 5-hour window at HH:MM," warnings. Local, single-user, no web/OTEL/team
rollup. Complements ccusage rather than competing.
**Stronger than Finius at:** predictive burn-rate / limit alerts (Finius is analytical, not alerting).

### [ccflare](https://github.com/snipeship/ccflare)
A multi-provider native **proxy** (Bun/TS, ~985★). Routes Anthropic *and* OpenAI/Codex by URL
prefix, load-balances across multiple accounts with failover when one is rate-limited, supports
OAuth + API-key accounts, and ships a TUI + web dashboard on `:8080` with full request history,
rate-limit state, and usage analytics. Because it sees real traffic, accounting is request-accurate.
Cost: you must route the agent through it (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`); local /
single-operator.
**Stronger than Finius at:** request-level accuracy and multi-account rotation.

### [microsoft/copilot-metrics-dashboard](https://github.com/microsoft/copilot-metrics-dashboard)
An org/enterprise **adoption** accelerator (Next.js, ~192★). Pulls the GitHub Copilot Metrics API +
User Management API → acceptance rate, active users, adoption rate, seat info, breakdowns by language
/ editor / team. Deploys to Azure (App Service + Functions + Cosmos DB + Key Vault). This answers
"are my seats being used?", **not** "what did each session cost?" — a different question from Finius.
No tokens-per-session, Copilot-only, requires org-admin token, cloud-hosted.

### [pvjagtap/github-copilot-usage-dashboard](https://github.com/pvjagtap/github-copilot-usage-dashboard)
A Copilot-specific **VS Code extension** (TS). Reads VS Code `chatSessions` JSONL + Copilot
`debug-logs/main.jsonl` (which carries `copilotUsageNanoAiu` — *exact* API billing, not an estimate)
+ transcripts, **plus a built-in live OTLP HTTP receiver on `:14318`** that it auto-configures
Copilot to export to. Tracks the AI Credits (AIC) billing model, budget projections, per-model credit
costs, session browser, subagent/tool calls, and daily charts. Local, single-workspace, single-user,
Copilot-only, lives inside VS Code.
**Stronger than Finius at:** exact Copilot billing data and in-editor convenience.

### The Grafana / OTEL stack route
Not one tool but a pattern: Claude Code emits OTEL → OTLP collector → **Prometheus** (metrics) +
**Loki** (events) → **Grafana** dashboards. Turnkey community repos exist:
[rommelporras/claude-code-monitoring](https://github.com/rommelporras/claude-code-monitoring) and
[paulrobello/claude-code-metrics-stack](https://github.com/paulrobello/claude-code-metrics-stack)
(docker-compose stacks), [rockdarko/claude-code-metrics-prometheus](https://github.com/rockdarko/claude-code-metrics-prometheus)
(importable dashboards), [centminmod/claude-code-opentelemetry-setup](https://github.com/centminmod/claude-code-opentelemetry-setup)
(setup guide, ~123★). Infinitely flexible, industrial-grade, genuinely multi-user if everyone exports
to the same collector — but heavy (3–4 services), generic panels rather than purpose-built
session/people/model drill-downs, **metrics-only (no transcript ingestion)**, and assembly-required.

### [OpenObserve](https://github.com/openobserve/openobserve)
OpenObserve is an open-source (Rust) single-binary
observability platform — logs, metrics, and traces in one, stored on local disk or S3-compatible
object storage, with a built-in UI, alerts, and native OTLP ingestion. Pointing Claude Code's OTEL
env vars at its OTLP endpoint gives you the same capability as the Grafana stack but with one binary
instead of 3–4 services and cheaper retention (see
[this walkthrough](https://medium.com/devops-ai/openobserve-claude-code-end-to-end-ai-observability-984afcaeba36)).
A full observability platform, team-capable, integrates with the rest of your infra — but, like the
Grafana route, it is a generic OTEL *sink*: metrics + logs only, no transcripts, and you build the
cost/session dashboards yourself.

There are also early OTel→SQLite→React near-clones of Finius's exact architecture —
[aarogyarijal/cc-analytics](https://github.com/aarogyarijal/cc-analytics) and
[McCavity/claude-code-dashboard](https://github.com/McCavity/claude-code-dashboard) — single-user and
immature today, but the most direct architectural competition.

## Where Finius fits

**Defensible niche.** Finius is the only tool that is *simultaneously*:

- **multi-agent** (Claude Code + Codex + Copilot in one pane),
- **dual-ingest** — live OpenTelemetry **and** full hook-uploaded transcripts, and
- a **multi-user, cross-machine, self-hosted server** with auth (Secure Mode).

No single competitor occupies all three. The structural advantage over the entire OTEL-sink column
(Grafana, OpenObserve, Prometheus) is the **second ingestion path**: those tools see Claude Code's
metrics and log-events but never its transcripts, so they can't offer per-session full-fidelity views
without bolting on a separate pipeline. Finius's hook-uploaded JSONL gives that for free.

**Honest exposure.** A team already running OpenObserve or Grafana for general observability has a
"good enough" cost view without adding another server. ccusage beats Finius on friction and agent
breadth. ccflare and pvjagtap's extension have *real* billing data where Finius estimates from
token × price. Finius's strongest pitch is to people who **don't** already run an observability stack
and want cost/usage/people answers without building dashboards.

**Gaps worth closing.**

1. **Exact billing data** — ingest real billing fields where available (Copilot's `copilotUsageNanoAiu`,
   Anthropic usage on transcripts) instead of estimating from token × price.
2. **Predictive rate-limit / burn-rate alerts** — Finius has the data but doesn't warn (the
   Claude-Code-Usage-Monitor niche).
3. **A zero-server `npx finius report` quick mode** to match ccusage's friction.
4. **Broader agent coverage** (Gemini CLI, OpenCode, Amp) to match ccusage.

---

*Last reviewed June 2026. Star counts and feature sets move quickly — treat specifics as a snapshot.*
