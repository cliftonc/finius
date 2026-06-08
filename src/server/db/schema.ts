// Drizzle table definitions. The drizzle-kit-generated migration under ./migrations is the runtime
// source of truth (applied at startup by client.ts's runMigrations); this file feeds drizzle-kit
// `generate` and is guarded against drift by tests/schema-parity.test.ts (which diffs the applied
// schema against the snapshot).
//
// camelCase TS field names map to the snake_case columns the SQL uses. epoch-ms time columns
// (timestamp/bucket/*_at/effective_date) are plain `integer` (NOT timestamp mode); value/price
// columns are `real`; 0/1 flags are `integer`.
//
// NOTE: metric_rollup and model_prices are WITHOUT ROWID in migrate(). The sqlite-core schema API
// can't express WITHOUT ROWID, so the generated baseline .sql is hand-edited to add it; this file
// only declares the composite primary key (whose column order matches the ON CONFLICT targets).

import { foreignKey, index, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const rawBatches = sqliteTable(
  "raw_batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    signal: text("signal").notNull(),
    hash: text("hash").notNull().unique(),
    payloadJson: text("payload_json").notNull(),
    receivedAt: integer("received_at").notNull()
  },
  (t) => [index("idx_raw_batches_received_at").on(t.receivedAt)]
);

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").unique(),
    accountId: text("account_id"),
    userId: text("user_id"),
    githubLogin: text("github_login"),
    displayName: text("display_name"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull()
  },
  (t) => [
    index("idx_users_account_id").on(t.accountId),
    index("idx_users_user_id").on(t.userId),
    index("idx_users_github_login").on(t.githubLogin)
  ]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull().unique(),
    userId: text("user_id"),
    userEmail: text("user_email"),
    userAccountId: text("user_account_id"),
    // FK into users(id) — set on ingest. Added via ensureColumn ALTER on legacy DBs.
    userRowId: integer("user_row_id"),
    hasOtel: integer("has_otel").notNull().default(0),
    hasJsonl: integer("has_jsonl").notNull().default(0),
    metricSource: text("metric_source").notNull().default("jsonl"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull()
  },
  (t) => [
    foreignKey({ columns: [t.userRowId], foreignColumns: [users.id], name: "sessions_user_row_id_users_id_fk" }),
    index("idx_sessions_seen").on(t.lastSeenAt),
    index("idx_sessions_user_row").on(t.userRowId)
  ]
);

export const metricPoints = sqliteTable(
  "metric_points",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    value: real("value").notNull(),
    unit: text("unit"),
    timestamp: integer("timestamp").notNull(),
    attributesJson: text("attributes_json"),
    rawBatchId: integer("raw_batch_id"),
    // Static per-source flag: counts toward dashboards iff 1. Set once at insert, never updated.
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

export const metricRollup = sqliteTable(
  "metric_rollup",
  {
    bucket: integer("bucket").notNull(),
    source: text("source").notNull(),
    userIdentity: text("user_identity").notNull(),
    model: text("model").notNull(),
    kind: text("kind").notNull(),
    tokenType: text("token_type").notNull(),
    sumValue: real("sum_value").notNull().default(0),
    cnt: integer("cnt").notNull().default(0)
  },
  (t) => [
    // PK column order matches upsertRollup's ON CONFLICT target.
    primaryKey({ columns: [t.bucket, t.source, t.userIdentity, t.model, t.kind, t.tokenType] }),
    index("idx_rollup_bucket").on(t.bucket)
  ]
);

export const sourceFiles = sqliteTable(
  "source_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    sessionRowId: integer("session_row_id"),
    sessionId: text("session_id"),
    hash: text("hash").notNull().unique(),
    blobKey: text("blob_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    lineCount: integer("line_count").notNull(),
    importedAt: integer("imported_at").notNull()
  },
  (t) => [
    foreignKey({ columns: [t.sessionRowId], foreignColumns: [sessions.id], name: "source_files_session_row_id_sessions_id_fk" }),
    index("idx_source_files_session").on(t.sessionRowId)
  ]
);

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revoked: integer("revoked").notNull().default(0),
    // Added via ensureColumn ALTER on legacy DBs.
    userRowId: integer("user_row_id")
  },
  (t) => [
    // migrate() has BOTH a UNIQUE constraint on token_hash AND a redundant plain index on it.
    // Declared as a table-level unique + a separate index so drizzle-kit emits both (a column-level
    // .unique() + same-column index() gets deduped to just the index, losing the UNIQUE autoindex).
    unique("auth_tokens_token_hash_unique").on(t.tokenHash),
    index("idx_auth_tokens_hash").on(t.tokenHash),
    index("idx_auth_tokens_user_row").on(t.userRowId)
  ]
);

export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userRowId: integer("user_row_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    unique("oauth_accounts_provider_provider_user_id_unique").on(t.provider, t.providerUserId),
    foreignKey({ columns: [t.userRowId], foreignColumns: [users.id], name: "oauth_accounts_user_row_id_users_id_fk" }),
    index("idx_oauth_accounts_user_row").on(t.userRowId)
  ]
);

export const logEvents = sqliteTable(
  "log_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventName: text("event_name"),
    severity: text("severity"),
    sessionId: text("session_id"),
    timestamp: integer("timestamp").notNull(),
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

export const modelPrices = sqliteTable(
  "model_prices",
  {
    model: text("model").notNull(),
    provider: text("provider"),
    inputPerToken: real("input_per_token").notNull().default(0),
    outputPerToken: real("output_per_token").notNull().default(0),
    cacheReadPerToken: real("cache_read_per_token").notNull().default(0),
    cacheCreationPerToken: real("cache_creation_per_token").notNull().default(0),
    effectiveDate: integer("effective_date").notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.model, t.effectiveDate] })]
);
