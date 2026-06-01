import { formatCurrency, formatExact, formatNumber } from "../../format";
import { PROVIDER_COLOR, PROVIDER_LABEL, ProviderLogo, providerForSource, type Provider } from "../ProviderLogo";

// One badge per signal a session carries (OTEL and/or JSONL). Color identifies the provider (Claude
// today, Codex etc. later) — every signal from one provider shares it — so only the OTEL/JSONL label
// distinguishes them.
function SignalBadge({ kind, active, provider = "claude" }: { kind: "otel" | "jsonl"; active: boolean; provider?: Provider }) {
  const label = kind === "otel" ? "OTEL" : "JSONL";
  const color = PROVIDER_COLOR[provider];
  const title = active ? `${label} · shown` : `${label} · present, not shown (OTel wins)`;
  return (
    <span
      title={`${PROVIDER_LABEL[provider]} · ${title}`}
      style={{ backgroundColor: `${color}33`, color }}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
    >
      <ProviderLogo provider={provider} size={11} />
      {label}
    </span>
  );
}

export function SourceBadges({
  hasOtel,
  hasJsonl,
  metricSource,
  source
}: {
  hasOtel: boolean;
  hasJsonl: boolean;
  metricSource: "otel" | "jsonl";
  source: string;
}) {
  const provider = providerForSource(source);
  return (
    <span className="inline-flex items-center gap-1">
      {hasOtel && <SignalBadge kind="otel" active={metricSource === "otel"} provider={provider} />}
      {hasJsonl && <SignalBadge kind="jsonl" active={metricSource === "jsonl"} provider={provider} />}
    </span>
  );
}

// When a session carries both OTel and a transcript, the two ingest paths usually disagree (OTel
// commonly misses requests the transcript captured). Show JSONL's signed delta vs OTel so the gap is
// visible at a glance; hidden when either signal is absent (nothing to compare).
export function TokenDiffBadge({ otel, jsonl }: { otel: number; jsonl: number }) {
  if (otel <= 0 || jsonl <= 0) return null;
  const delta = jsonl - otel;
  if (delta === 0) return null;
  const pct = Math.round((delta / otel) * 100);
  const sign = delta > 0 ? "+" : "−";
  const tone = Math.abs(pct) >= 25 ? "bg-warning/10 text-warning-600" : "bg-default-100 text-default-500";
  return (
    <span
      title={`JSONL ${formatExact(jsonl)} vs OTEL ${formatExact(otel)} tokens (${sign}${formatExact(Math.abs(delta))}, ${sign}${Math.abs(pct)}%)`}
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${tone}`}
    >
      {sign}
      {formatNumber(Math.abs(delta))}
    </span>
  );
}

// Same idea as TokenDiffBadge for cost: OTel reports cost directly while JSONL cost is synthesized from
// pricing, so the two can diverge. Show JSONL's signed delta vs OTel; hidden when either signal lacks a
// cost figure (nothing to compare).
export function CostDiffBadge({ otel, jsonl }: { otel: number; jsonl: number }) {
  if (otel <= 0 || jsonl <= 0) return null;
  const delta = jsonl - otel;
  if (delta === 0) return null;
  const pct = Math.round((delta / otel) * 100);
  const sign = delta > 0 ? "+" : "−";
  const tone = Math.abs(pct) >= 25 ? "bg-warning/10 text-warning-600" : "bg-default-100 text-default-500";
  return (
    <span
      title={`JSONL ${formatCurrency(jsonl)} vs OTEL ${formatCurrency(otel)} (${sign}${formatCurrency(Math.abs(delta))}, ${sign}${Math.abs(pct)}%)`}
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${tone}`}
    >
      {sign}
      {formatCurrency(Math.abs(delta))}
    </span>
  );
}
