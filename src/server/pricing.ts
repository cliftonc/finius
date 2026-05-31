import type { MetricPointInput, ModelPrice } from "./types.js";

// Pure pricing helpers: normalize an external price feed (LiteLLM) into our ModelPrice rows, match a
// reported model id to a price, and synthesize cost metric points from token points. Side-effect-free
// so it unit-tests cleanly and is shared by the ingest path and the recompute/backfill path.
//
// The metric name used for cost we compute ourselves. It stays kind:"cost" so every existing
// `SUM(CASE WHEN kind='cost' ...)` picks it up, but is distinguishable from an agent-reported cost
// (Claude's `claude_code.cost.usage`) in the source-filtered comparison views.
export const COMPUTED_COST_METRIC = "finius.cost.computed";

// LiteLLM's model_prices_and_context_window.json: a top-level object keyed by model id, each value a
// record of per-token costs. We only need the four token-type rates + the provider tag.
type LiteLlmEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
};

// Token type (our metric_points.token_type) → the ModelPrice rate field it's priced by. Anything not
// listed here (e.g. the "total" fallback) is intentionally unpriced so we never double-count.
const RATE_BY_TOKEN_TYPE: Record<string, keyof Pick<ModelPrice, "inputPerToken" | "outputPerToken" | "cacheReadPerToken" | "cacheCreationPerToken">> = {
  input: "inputPerToken",
  output: "outputPerToken",
  cache_read: "cacheReadPerToken",
  cache_creation: "cacheCreationPerToken"
};

export function normalizeLiteLlm(json: unknown, effectiveDate = 0): ModelPrice[] {
  if (!json || typeof json !== "object") return [];
  const prices: ModelPrice[] = [];
  for (const [model, raw] of Object.entries(json as Record<string, unknown>)) {
    if (model === "sample_spec" || !raw || typeof raw !== "object") continue;
    const entry = raw as LiteLlmEntry;
    const input = numberOr0(entry.input_cost_per_token);
    const output = numberOr0(entry.output_cost_per_token);
    const cacheRead = numberOr0(entry.cache_read_input_token_cost);
    const cacheCreation = numberOr0(entry.cache_creation_input_token_cost);
    // Skip entries with no usable token rates (LiteLLM also lists embedding/audio/etc. models).
    if (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) continue;
    prices.push({
      model,
      provider: typeof entry.litellm_provider === "string" ? entry.litellm_provider : inferProvider(model),
      inputPerToken: input,
      outputPerToken: output,
      // LiteLLM omits cache-read for many models; fall back to the input rate so cache reads aren't free.
      cacheReadPerToken: cacheRead || input,
      cacheCreationPerToken: cacheCreation || input,
      effectiveDate
    });
  }
  return prices;
}

// Index prices by a normalized model key → rows sorted newest-effectiveDate-first, so priceFor can
// pick the rate in effect at a given time with a single linear scan.
export type PriceIndex = Map<string, ModelPrice[]>;

export function indexPrices(prices: ModelPrice[]): PriceIndex {
  const index: PriceIndex = new Map();
  const add = (key: string, price: ModelPrice) => {
    const list = index.get(key);
    if (list) list.push(price);
    else index.set(key, [price]);
  };
  for (const price of prices) {
    const key = normalizeKey(price.model);
    add(key, price);
    // Also alias under the date-stripped key so a dated feed entry (claude-...-20250929) still
    // matches an undated reported id, and vice versa.
    const undated = key.replace(/-\d{8}$/, "");
    if (undated !== key) add(undated, price);
  }
  for (const list of index.values()) list.sort((a, b) => b.effectiveDate - a.effectiveDate);
  return index;
}

// Resolve a reported model id to its candidate price rows. Tries the exact (normalized) id, then the
// id with any trailing `-YYYYMMDD` date suffix stripped (Claude ships dated and undated variants).
function matchKeys(model: string): string[] {
  const exact = normalizeKey(model);
  const undated = exact.replace(/-\d{8}$/, "");
  return undated !== exact ? [exact, undated] : [exact];
}

export function priceFor(model: string | null | undefined, timestamp: number, index: PriceIndex): ModelPrice | undefined {
  if (!model) return undefined;
  for (const key of matchKeys(model)) {
    const list = index.get(key);
    if (!list || list.length === 0) continue;
    // Rows are sorted newest-first; take the newest whose effectiveDate is at or before the usage.
    const inEffect = list.find((p) => p.effectiveDate <= timestamp);
    return inEffect ?? list[list.length - 1]; // else the oldest known rate (better than $0)
  }
  return undefined;
}

// Turn token points into synthesized cost points. One cost point per priced token point, copying the
// source/signal/session/model/timestamp so the existing aggregation + jsonlWins precedence treat the
// cost exactly like its tokens (and shadow it when the session has authoritative ingested cost).
export function computeCostPoints(tokenPoints: MetricPointInput[], index: PriceIndex): MetricPointInput[] {
  const points: MetricPointInput[] = [];
  for (const point of tokenPoints) {
    if (point.kind !== "tokens" || !point.tokenType) continue;
    const rateField = RATE_BY_TOKEN_TYPE[point.tokenType];
    if (!rateField) continue;
    const price = priceFor(point.model, point.timestamp, index);
    if (!price) continue;
    const cost = point.value * price[rateField];
    if (!(cost > 0)) continue;
    points.push({
      source: point.source,
      signal: point.signal,
      sessionId: point.sessionId,
      userId: point.userId ?? null,
      userEmail: point.userEmail ?? null,
      userAccountId: point.userAccountId ?? null,
      model: point.model ?? null,
      metricName: COMPUTED_COST_METRIC,
      kind: "cost",
      tokenType: null,
      value: cost,
      unit: "USD",
      timestamp: point.timestamp
    });
  }
  return points;
}

function normalizeKey(model: string): string {
  // Drop a vendor prefix LiteLLM sometimes carries (e.g. "anthropic/claude-...", "openai/gpt-...").
  const slash = model.lastIndexOf("/");
  return (slash === -1 ? model : model.slice(slash + 1)).toLowerCase();
}

function inferProvider(model: string): string | null {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.includes("codex")) return "openai";
  return null;
}

function numberOr0(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
