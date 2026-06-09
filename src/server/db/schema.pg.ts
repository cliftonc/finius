// PostgreSQL mirror of schema.ts (the SQLite definition). Column NAMES, table names, and constraint
// names are IDENTICAL to the SQLite schema so the hand-written raw SQL (buildSessions,
// getLogEventSummary, rebuildRollup, rebuildIsPrimary, the ON CONFLICT upserts) runs unchanged on both,
// and so tests/schema-cross-parity.test.ts can guard the two against drift. The schema barrel
// (schema-active.ts) re-exports whichever set the active backend selected.
//
// Type mapping vs SQLite (see CLAUDE.md):
//   integer PK autoincrement  -> integer generatedByDefaultAsIdentity (RETURNING still yields the id)
//   epoch-ms time columns     -> bigint({ mode: "number" })  — ms exceeds int32; mode:number keeps JS numbers
//   real value/price columns  -> doublePrecision
//   0/1 flag columns          -> integer (KEPT as integer, not boolean, so `= 1` / greatest(...) SQL is shared)
//   text (incl attributes_json/json) -> text  (jsonExtract casts ::jsonb at read time)
//
// This file is ONLY for drizzle-kit `generate` (drizzle.config.pg.ts) + the barrel; never hand-edit the
// generated migrations under ./migrations-pg.

import { bigint, doublePrecision, foreignKey, index, integer, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core";

// epoch-ms helper: a bigint column surfaced as a JS number (ms fits in a JS double).
const epochMs = (name: string) => bigint(name, { mode: "number" });

export const rawBatches = pgTable(
  "raw_batches",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    signal: text("signal").notNull(),
    hash: text("hash").notNull().unique(),
    payloadJson: text("payload_json").notNull(),
    receivedAt: epochMs("received_at").notNull()
  },
  (t) => [index("idx_raw_batches_received_at").on(t.receivedAt)]
);

export const users = pgTable(
  "users",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    email: text("email").unique(),
    accountId: text("account_id"),
    userId: text("user_id"),
    githubLogin: text("github_login"),
    displayName: text("display_name"),
    firstSeenAt: epochMs("first_seen_at").notNull(),
    lastSeenAt: epochMs("last_seen_at").notNull()
  },
  (t) => [
    index("idx_users_account_id").on(t.accountId),
    index("idx_users_user_id").on(t.userId),
    index("idx_users_github_login").on(t.githubLogin)
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    sessionId: text("session_id").notNull().unique(),
    userId: text("user_id"),
    userEmail: text("user_email"),
    userAccountId: text("user_account_id"),
    userRowId: integer("user_row_id"),
    hasOtel: integer("has_otel").notNull().default(0),
    hasJsonl: integer("has_jsonl").notNull().default(0),
    metricSource: text("metric_source").notNull().default("jsonl"),
    firstSeenAt: epochMs("first_seen_at").notNull(),
    lastSeenAt: epochMs("last_seen_at").notNull()
  },
  (t) => [
    foreignKey({ columns: [t.userRowId], foreignColumns: [users.id], name: "sessions_user_row_id_users_id_fk" }),
    index("idx_sessions_seen").on(t.lastSeenAt),
    index("idx_sessions_user_row").on(t.userRowId)
  ]
);

export const metricPoints = pgTable(
  "metric_points",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    source: text("source").notNull(),
    signal: text("signal").notNull(),
    sessionRowId: integer("session_row_id").notNull(),
    sessionId: text("session_id").notNull(),
    userId: text("user_id"),
    userEmail: text("user_email"),
    userAccountId: text("user_account_id"),
    model: text("model"),
    metricName: text("metric_name").notNull(),
    kind: text("kind").notNull(),
    tokenType: text("token_type"),
    value: doublePrecision("value").notNull(),
    unit: text("unit"),
    timestamp: epochMs("timestamp").notNull(),
    attributesJson: text("attributes_json"),
    rawBatchId: integer("raw_batch_id"),
    isPrimary: integer("is_primary").notNull().default(1)
  },
  (t) => [
    foreignKey({ columns: [t.sessionRowId], foreignColumns: [sessions.id], name: "metric_points_session_row_id_sessions_id_fk" }),
    foreignKey({ columns: [t.rawBatchId], foreignColumns: [rawBatches.id], name: "metric_points_raw_batch_id_raw_batches_id_fk" }),
    index("idx_metric_points_timestamp").on(t.timestamp),
    index("idx_metric_points_session").on(t.sessionRowId),
    index("idx_metric_points_model").on(t.model),
    index("idx_metric_points_signal_session").on(t.signal, t.sessionId),
    index("idx_metric_points_primary").on(t.isPrimary),
    index("idx_metric_points_metric_name").on(t.metricName)
  ]
);

export const metricRollup = pgTable(
  "metric_rollup",
  {
    bucket: epochMs("bucket").notNull(),
    source: text("source").notNull(),
    userIdentity: text("user_identity").notNull(),
    model: text("model").notNull(),
    kind: text("kind").notNull(),
    tokenType: text("token_type").notNull(),
    sumValue: doublePrecision("sum_value").notNull().default(0),
    cnt: integer("cnt").notNull().default(0)
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.source, t.userIdentity, t.model, t.kind, t.tokenType] }),
    index("idx_rollup_bucket").on(t.bucket)
  ]
);

export const sourceFiles = pgTable(
  "source_files",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    source: text("source").notNull(),
    sessionRowId: integer("session_row_id"),
    sessionId: text("session_id"),
    hash: text("hash").notNull().unique(),
    blobKey: text("blob_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    lineCount: integer("line_count").notNull(),
    importedAt: epochMs("imported_at").notNull()
  },
  (t) => [
    foreignKey({ columns: [t.sessionRowId], foreignColumns: [sessions.id], name: "source_files_session_row_id_sessions_id_fk" }),
    index("idx_source_files_session").on(t.sessionRowId)
  ]
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    createdAt: epochMs("created_at").notNull(),
    lastUsedAt: epochMs("last_used_at"),
    revoked: integer("revoked").notNull().default(0),
    userRowId: integer("user_row_id")
  },
  (t) => [
    unique("auth_tokens_token_hash_unique").on(t.tokenHash),
    index("idx_auth_tokens_hash").on(t.tokenHash),
    index("idx_auth_tokens_user_row").on(t.userRowId)
  ]
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userRowId: integer("user_row_id").notNull(),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull()
  },
  (t) => [
    unique("oauth_accounts_provider_provider_user_id_unique").on(t.provider, t.providerUserId),
    foreignKey({ columns: [t.userRowId], foreignColumns: [users.id], name: "oauth_accounts_user_row_id_users_id_fk" }),
    index("idx_oauth_accounts_user_row").on(t.userRowId)
  ]
);

export const logEvents = pgTable(
  "log_events",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    eventName: text("event_name"),
    severity: text("severity"),
    sessionId: text("session_id"),
    timestamp: epochMs("timestamp").notNull(),
    attributesJson: text("attributes_json"),
    bodyJson: text("body_json"),
    rawBatchId: integer("raw_batch_id")
  },
  (t) => [
    foreignKey({ columns: [t.rawBatchId], foreignColumns: [rawBatches.id], name: "log_events_raw_batch_id_raw_batches_id_fk" }),
    index("idx_log_events_name").on(t.eventName),
    index("idx_log_events_batch").on(t.rawBatchId)
  ]
);

export const modelPrices = pgTable(
  "model_prices",
  {
    model: text("model").notNull(),
    provider: text("provider"),
    inputPerToken: doublePrecision("input_per_token").notNull().default(0),
    outputPerToken: doublePrecision("output_per_token").notNull().default(0),
    cacheReadPerToken: doublePrecision("cache_read_per_token").notNull().default(0),
    cacheCreationPerToken: doublePrecision("cache_creation_per_token").notNull().default(0),
    effectiveDate: epochMs("effective_date").notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.model, t.effectiveDate] })]
);
