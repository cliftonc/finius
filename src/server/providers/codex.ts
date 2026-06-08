import type { ImportResult, MetricPointInput } from "../types.js";
import type { ParsedTranscript } from "../transcripts.js";
import { numberValue, parseTimestamp, stringValue } from "../jsonl.js";

// Parser for OpenAI Codex "rollout" transcripts (`~/.codex/sessions/**/rollout-*.jsonl`). Each line is
// `{ timestamp, type, payload }`. Token usage rides on `event_msg` lines whose `payload.type` is
// `token_count`, carrying `payload.info.total_token_usage` — a *cumulative, monotonic* running total
// for the session. We emit per-event DELTAS of that cumulative, which sum exactly to the final total
// (verified against real rollouts). `last_token_usage` is NOT used: Codex double-emits it (identical
// adjacent values), so summing it overcounts. Pure / side-effect-free, mirroring claude.ts.
//
// Token fields: `input_tokens` already includes `cached_input_tokens`; `output_tokens` already includes
// `reasoning_output_tokens`. We split fresh input from cache reads so the four token types stay
// disjoint and additive, matching how the Claude parser reports input/output/cache_read. Codex
// rollouts carry no cost, so no cost point is emitted.

type CumulativeTokens = { input: number; output: number; cached: number };

export function parseCodexTranscript(
  source: string,
  sessionHint: Partial<MetricPointInput>,
  lines: string[]
): ParsedTranscript {
  const result: ImportResult = { importedLines: 0, malformedLines: 0, metricPoints: 0, rawEvents: 0 };
  const points: MetricPointInput[] = [];
  const rawEvents: unknown[] = [];

  let sessionId: string | undefined = sessionHint.sessionId ?? undefined;
  let model: string | null = sessionHint.model ?? null;
  const prev: CumulativeTokens = { input: 0, output: 0, cached: 0 };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      result.malformedLines += 1;
      continue;
    }

    result.importedLines += 1;
    result.rawEvents += 1;
    rawEvents.push(event);

    const obj = event as Record<string, unknown>;
    const type = stringValue(obj.type);
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (type === "session_meta") {
      sessionId = stringValue(payload.id) ?? sessionId;
      continue;
    }
    if (type === "turn_context") {
      model = stringValue(payload.model) ?? model;
      continue;
    }
    if (type !== "event_msg" || stringValue(payload.type) !== "token_count") continue;

    const info = payload.info as Record<string, unknown> | undefined;
    const total = info?.total_token_usage as Record<string, unknown> | undefined;
    if (!total) continue;

    const curInput = numberValue(total.input_tokens) ?? 0;
    const curOutput = numberValue(total.output_tokens) ?? 0;
    const curCached = numberValue(total.cached_input_tokens) ?? 0;

    // Cumulative -> delta. Clamp at 0 to guard the (unobserved) case of a non-monotonic reset.
    const dInput = Math.max(0, curInput - prev.input);
    const dOutput = Math.max(0, curOutput - prev.output);
    const dCached = Math.max(0, curCached - prev.cached);
    prev.input = curInput;
    prev.output = curOutput;
    prev.cached = curCached;

    const timestamp = parseTimestamp(obj.timestamp) ?? Date.now();
    const sid = String(sessionId ?? "unknown-session");
    const base = {
      source,
      signal: "jsonl" as const,
      sessionId: sid,
      userId: sessionHint.userId ?? null,
      userEmail: sessionHint.userEmail ?? null,
      userAccountId: sessionHint.userAccountId ?? null,
      githubLogin: sessionHint.githubLogin ?? null,
      displayName: sessionHint.displayName ?? null,
      model,
      timestamp,
      attributes: info ?? obj
    };

    const emit = (tokenType: string, value: number) => {
      if (value <= 0) return;
      points.push({ ...base, metricName: "codex.token.usage", kind: "tokens", tokenType, value, unit: "tokens" });
      result.metricPoints += 1;
    };

    emit("input", Math.max(0, dInput - dCached)); // fresh (non-cached) input
    emit("cache_read", dCached);
    emit("output", dOutput); // includes reasoning tokens

    void model;
  }

  return { result, points, rawEvents };
}
