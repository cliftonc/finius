# Refactor: Update Parser References In Docs

## Problem

Several docs still refer to `src/server/jsonl.ts`, but the transcript parser has been split into:

- `src/server/claude.ts`
- `src/server/codex.ts`
- `src/server/transcripts.ts`

## Why It Matters

The docs are otherwise useful as architecture notes. Stale file references slow down future contributors and make the parser extension model less clear.

## Files To Update

- `CLAUDE.md`
- `src/server/CLAUDE.md`
- Any inline comments that still mention `jsonl.ts` as the active parser module

## Suggested Wording

Use `transcripts.ts` for dispatch and `claude.ts` / `codex.ts` for parser implementations.

For example:

```text
Transcript parsing is dispatched by `src/server/transcripts.ts`; agent-specific parsers live in
`src/server/claude.ts` and `src/server/codex.ts`.
```
