// Pricing store: free functions over the Drizzle handle for the `model_prices` table and the
// synthesized-cost recompute. The pure pricing MATH (normalizeLiteLlm/priceFor/computeCostPoints) lives
// in ../pricing.js; this module is only the DB side. Extracted from the storage adapter, which keeps the
// in-memory PriceIndex (refreshed via loadPriceIndex) that the cost hot path reads synchronously.

import { type DrizzleDb } from "./client.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { metricPoints, modelPrices } from "./schema-active.js";
import * as ingest from "./ingest.js";
import { COMPUTED_COST_METRIC, computeCostPoints, indexPrices, type PriceIndex } from "../pricing.js";
import type { MetricPointInput, ModelPrice } from "../types.js";

const PRICE_COLUMNS = {
  model: modelPrices.model,
  provider: modelPrices.provider,
  inputPerToken: modelPrices.inputPerToken,
  outputPerToken: modelPrices.outputPerToken,
  cacheReadPerToken: modelPrices.cacheReadPerToken,
  cacheCreationPerToken: modelPrices.cacheCreationPerToken,
  effectiveDate: modelPrices.effectiveDate
} as const;

// Load model_prices into an in-memory index (for the cost-synthesis hot path) plus the earliest
// effective date we hold (which gates historical-pricing backfill). The adapter caches both.
export async function loadPriceIndex(db: DrizzleDb): Promise<{ index: PriceIndex; earliest: number | null }> {
  const rows = (await db.select(PRICE_COLUMNS).from(modelPrices).execute()) as ModelPrice[];
  const earliest = rows.reduce<number | null>((min, r) => (min == null || r.effectiveDate < min ? r.effectiveDate : min), null);
  return { index: indexPrices(rows), earliest };
}

export async function getPricing(db: DrizzleDb): Promise<ModelPrice[]> {
  return (await db.select(PRICE_COLUMNS).from(modelPrices).orderBy(modelPrices.model, desc(modelPrices.effectiveDate)).execute()) as ModelPrice[];
}

// Upsert dated price rows (newer effective_date wins for a given model). The adapter reloads its index
// afterward (this function does not touch the in-memory index). No transaction (see ingest.ts header):
// each row upsert is independent and idempotent.
export async function importPricing(db: DrizzleDb, prices: ModelPrice[]): Promise<{ imported: number }> {
  for (const p of prices) {
    await db
      .insert(modelPrices)
      .values({
        model: p.model,
        provider: p.provider ?? null,
        inputPerToken: p.inputPerToken,
        outputPerToken: p.outputPerToken,
        cacheReadPerToken: p.cacheReadPerToken,
        cacheCreationPerToken: p.cacheCreationPerToken,
        effectiveDate: p.effectiveDate
      })
      .onConflictDoUpdate({
        target: [modelPrices.model, modelPrices.effectiveDate],
        set: {
          provider: sql`excluded.provider`,
          inputPerToken: sql`excluded.input_per_token`,
          outputPerToken: sql`excluded.output_per_token`,
          cacheReadPerToken: sql`excluded.cache_read_per_token`,
          cacheCreationPerToken: sql`excluded.cache_creation_per_token`
        }
      })
      .execute();
  }
  return { imported: prices.length };
}

// Rebuild the synthesized `finius.cost.computed` points from the token points already in metric_points —
// no transcript re-parse needed. Idempotent: delete then re-derive. Sessions that carry an agent-reported
// cost are skipped so we never stack computed cost on top of real cost. Prices come from the caller's
// in-memory index. Opens its own transaction.
export async function recomputeComputedCost(db: DrizzleDb, priceIndex: PriceIndex): Promise<{ costPoints: number }> {
  await db.delete(metricPoints).where(eq(metricPoints.metricName, COMPUTED_COST_METRIC)).execute();
  // After the delete, every remaining kind='cost' AND signal='jsonl' row is a cost the TRANSCRIPT
  // itself reported — those sessions skip synthesis (don't stack computed cost on real cost). We must
  // NOT key on OTel cost (signal='otlp_metrics'): the live path synthesizes JSONL cost per-transcript
  // regardless of OTel and lets is_primary shadow it, so the comparison/source-filtered view still
  // shows the JSONL figure. Skipping OTel-cost sessions here would delete that shadowed cost and never
  // recreate it — matching the live path means scoping the skip to real jsonl-reported cost only.
  const reported = new Set(
    (
      await db
        .selectDistinct({ id: metricPoints.sessionRowId })
        .from(metricPoints)
        .where(and(eq(metricPoints.kind, "cost"), eq(metricPoints.signal, "jsonl")))
        .execute()
    ).map((r) => r.id)
  );
  const tokenRows = await db
    .select({
      source: metricPoints.source,
      signal: metricPoints.signal,
      sessionId: metricPoints.sessionId,
      sessionRowId: metricPoints.sessionRowId,
      userId: metricPoints.userId,
      userEmail: metricPoints.userEmail,
      userAccountId: metricPoints.userAccountId,
      model: metricPoints.model,
      metricName: metricPoints.metricName,
      tokenType: metricPoints.tokenType,
      value: metricPoints.value,
      timestamp: metricPoints.timestamp
    })
    .from(metricPoints)
    .where(and(eq(metricPoints.signal, "jsonl"), eq(metricPoints.kind, "tokens")))
    .execute();
  const tokenPoints: MetricPointInput[] = tokenRows
    .filter((r) => !reported.has(r.sessionRowId))
    .map((r) => ({
      source: r.source,
      signal: r.signal as MetricPointInput["signal"], // query filters signal = 'jsonl'
      sessionId: r.sessionId,
      userId: r.userId,
      userEmail: r.userEmail,
      userAccountId: r.userAccountId,
      model: r.model,
      metricName: r.metricName,
      kind: "tokens",
      tokenType: r.tokenType,
      value: r.value,
      timestamp: r.timestamp
    }));
  const costPoints = computeCostPoints(tokenPoints, priceIndex);
  for (const point of costPoints) await ingest.insertMetricPoint(db, point, null);
  // The bulk delete+reinsert above changed which primary cost points exist (computed cost can be
  // primary — Codex/manual), so the rollup's cost rows are now stale. Rebuild it wholesale to restore
  // the invariant (rollup == aggregate of is_primary=1 points).
  await ingest.rebuildRollup(db);
  return { costPoints: costPoints.length };
}
