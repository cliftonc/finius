// Pricing store: free functions over the Drizzle handle for the `model_prices` table and the
// synthesized-cost recompute. The pure pricing MATH (normalizeLiteLlm/priceFor/computeCostPoints) lives
// in ../pricing.js; this module is only the DB side. Extracted from the storage adapter, which keeps the
// in-memory PriceIndex (refreshed via loadPriceIndex) that the cost hot path reads synchronously.

import { type DrizzleDb } from "./client.js";
import { desc, eq, sql } from "drizzle-orm";
import { metricPoints, modelPrices } from "./schema.js";
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
export function loadPriceIndex(db: DrizzleDb): { index: PriceIndex; earliest: number | null } {
  const rows = db.select(PRICE_COLUMNS).from(modelPrices).all() as ModelPrice[];
  const earliest = rows.reduce<number | null>((min, r) => (min == null || r.effectiveDate < min ? r.effectiveDate : min), null);
  return { index: indexPrices(rows), earliest };
}

export function getPricing(db: DrizzleDb): ModelPrice[] {
  return db.select(PRICE_COLUMNS).from(modelPrices).orderBy(modelPrices.model, desc(modelPrices.effectiveDate)).all() as ModelPrice[];
}

// Upsert dated price rows (newer effective_date wins for a given model). The adapter reloads its index
// afterward (this function does not touch the in-memory index).
export function importPricing(db: DrizzleDb, prices: ModelPrice[]): { imported: number } {
  db.transaction(() => {
    for (const p of prices) {
      db.insert(modelPrices)
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
        .run();
    }
  });
  return { imported: prices.length };
}

// Rebuild the synthesized `finius.cost.computed` points from the token points already in metric_points —
// no transcript re-parse needed. Idempotent: delete then re-derive. Sessions that carry an agent-reported
// cost are skipped so we never stack computed cost on top of real cost. Prices come from the caller's
// in-memory index. Opens its own transaction.
export function recomputeComputedCost(db: DrizzleDb, priceIndex: PriceIndex): { costPoints: number } {
  const costPointCount = db.transaction(() => {
    db.delete(metricPoints).where(eq(metricPoints.metricName, COMPUTED_COST_METRIC)).run();
    // After the delete, every remaining kind='cost' row is an agent-reported cost.
    const reported = new Set(
      (db.all<{ id: number }>(sql`SELECT DISTINCT session_row_id AS id FROM ${metricPoints} WHERE kind = 'cost'`) as Array<{ id: number }>).map((r) => r.id)
    );
    const tokenRows = db.all<{ sessionRowId: number } & Omit<MetricPointInput, "kind" | "attributes">>(
      sql`SELECT source, signal, session_id AS sessionId, session_row_id AS sessionRowId, user_id AS userId,
          user_email AS userEmail, user_account_id AS userAccountId, model, metric_name AS metricName,
          token_type AS tokenType, value, timestamp
         FROM ${metricPoints} WHERE signal = 'jsonl' AND kind = 'tokens'`
    ) as Array<{ sessionRowId: number } & Omit<MetricPointInput, "kind" | "attributes">>;
    const tokenPoints: MetricPointInput[] = tokenRows
      .filter((r) => !reported.has(r.sessionRowId))
      .map((r) => ({
        source: r.source,
        signal: r.signal,
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
    for (const point of costPoints) ingest.insertMetricPoint(db, point, null);
    // The bulk delete+reinsert above changed which primary cost points exist (computed cost can be
    // primary — Codex/manual), so the rollup's cost rows are now stale. Rebuild it wholesale to restore
    // the invariant (rollup == aggregate of is_primary=1 points).
    ingest.rebuildRollup(db);
    return costPoints.length;
  });
  return { costPoints: costPointCount };
}
