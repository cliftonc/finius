// One-off cleanup for the short-lived build that ingested Codex's logs-only OTel as metric_points.
// That made Codex sessions flip to metric_source='otel', shadowing the complete rollout-JSONL (full
// tokens + cost) behind a partial, cost-less OTel subset — so the home/session views undercounted.
// We reverted that ingestion; this removes the stale points + rollup rows and recomputes the affected
// sessions' signal flags from what actually remains in metric_points.
//
// RUN ORDER: rebuild + restart the server on the reverted code FIRST (otherwise the running old build
// keeps re-creating these). Then:  node scripts/cleanup-codex-otel.mjs
// Honors FINIUS_DB_PATH; defaults to ./data/finius.sqlite.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const dbPath = process.env.FINIUS_DB_PATH ?? join(process.cwd(), "data", "finius.sqlite");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");

const before = db.prepare("SELECT COUNT(*) n FROM metric_points WHERE source = 'codex'").get();
console.log(`DB: ${dbPath}`);
console.log(`Codex OTel metric_points to remove: ${before.n}`);

db.exec("BEGIN IMMEDIATE");
try {
  // Sessions that have any Codex OTel point — only these need their flags recomputed.
  const affected = db.prepare("SELECT DISTINCT session_row_id AS id FROM metric_points WHERE source = 'codex' AND session_row_id IS NOT NULL").all();

  db.prepare("DELETE FROM metric_points WHERE source = 'codex'").run();
  db.prepare("DELETE FROM metric_rollup WHERE source = 'codex'").run();

  // Recompute has_otel/has_jsonl from the points that actually remain, then re-derive metric_source
  // exactly as upsertSession does (OTel wins when present — which, post-cleanup, means Claude only).
  const recompute = db.prepare(
    `UPDATE sessions SET
       has_otel  = (SELECT EXISTS(SELECT 1 FROM metric_points mp WHERE mp.session_row_id = sessions.id AND mp.signal = 'otlp_metrics')),
       has_jsonl = (SELECT EXISTS(SELECT 1 FROM metric_points mp WHERE mp.session_row_id = sessions.id AND mp.signal = 'jsonl'))
     WHERE id = ?`
  );
  const reflag = db.prepare("UPDATE sessions SET metric_source = CASE WHEN has_otel = 1 THEN 'otel' ELSE 'jsonl' END WHERE id = ?");
  for (const { id } of affected) {
    recompute.run(id);
    reflag.run(id);
  }
  db.exec("COMMIT");
  console.log(`Recomputed signal flags for ${affected.length} session(s). Done.`);
} catch (err) {
  db.exec("ROLLBACK");
  console.error("Rolled back:", err.message);
  process.exitCode = 1;
}
db.close();
