CREATE TABLE IF NOT EXISTS `auth_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`token_hash` text NOT NULL CONSTRAINT `auth_tokens_token_hash_unique` UNIQUE,
	`label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked` integer DEFAULT 0 NOT NULL,
	`user_row_id` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `log_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`event_name` text,
	`severity` text,
	`session_id` text,
	`timestamp` integer NOT NULL,
	`attributes_json` text,
	`body_json` text,
	`raw_batch_id` integer,
	CONSTRAINT `log_events_raw_batch_id_raw_batches_id_fk` FOREIGN KEY (`raw_batch_id`) REFERENCES `raw_batches`(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `metric_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source` text NOT NULL,
	`signal` text NOT NULL,
	`session_row_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text,
	`user_email` text,
	`user_account_id` text,
	`model` text,
	`metric_name` text NOT NULL,
	`kind` text NOT NULL,
	`token_type` text,
	`value` real NOT NULL,
	`unit` text,
	`timestamp` integer NOT NULL,
	`attributes_json` text,
	`raw_batch_id` integer,
	`is_primary` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `metric_points_session_row_id_sessions_id_fk` FOREIGN KEY (`session_row_id`) REFERENCES `sessions`(`id`),
	CONSTRAINT `metric_points_raw_batch_id_raw_batches_id_fk` FOREIGN KEY (`raw_batch_id`) REFERENCES `raw_batches`(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `metric_rollup` (
	`bucket` integer NOT NULL,
	`source` text NOT NULL,
	`user_identity` text NOT NULL,
	`model` text NOT NULL,
	`kind` text NOT NULL,
	`token_type` text NOT NULL,
	`sum_value` real DEFAULT 0 NOT NULL,
	`cnt` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `metric_rollup_pk` PRIMARY KEY(`bucket`, `source`, `user_identity`, `model`, `kind`, `token_type`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `model_prices` (
	`model` text NOT NULL,
	`provider` text,
	`input_per_token` real DEFAULT 0 NOT NULL,
	`output_per_token` real DEFAULT 0 NOT NULL,
	`cache_read_per_token` real DEFAULT 0 NOT NULL,
	`cache_creation_per_token` real DEFAULT 0 NOT NULL,
	`effective_date` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `model_prices_pk` PRIMARY KEY(`model`, `effective_date`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`user_row_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `oauth_accounts_user_row_id_users_id_fk` FOREIGN KEY (`user_row_id`) REFERENCES `users`(`id`),
	CONSTRAINT `oauth_accounts_provider_provider_user_id_unique` UNIQUE(`provider`,`provider_user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `raw_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`signal` text NOT NULL,
	`hash` text NOT NULL UNIQUE,
	`payload_json` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL UNIQUE,
	`user_id` text,
	`user_email` text,
	`user_account_id` text,
	`user_row_id` integer,
	`has_otel` integer DEFAULT 0 NOT NULL,
	`has_jsonl` integer DEFAULT 0 NOT NULL,
	`metric_source` text DEFAULT 'jsonl' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	CONSTRAINT `sessions_user_row_id_users_id_fk` FOREIGN KEY (`user_row_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `source_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source` text NOT NULL,
	`session_row_id` integer,
	`session_id` text,
	`hash` text NOT NULL UNIQUE,
	`blob_key` text NOT NULL,
	`byte_size` integer NOT NULL,
	`line_count` integer NOT NULL,
	`imported_at` integer NOT NULL,
	CONSTRAINT `source_files_session_row_id_sessions_id_fk` FOREIGN KEY (`session_row_id`) REFERENCES `sessions`(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`email` text UNIQUE,
	`account_id` text,
	`user_id` text,
	`github_login` text,
	`display_name` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_auth_tokens_hash` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_auth_tokens_user_row` ON `auth_tokens` (`user_row_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_log_events_name` ON `log_events` (`event_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_log_events_batch` ON `log_events` (`raw_batch_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_metric_points_timestamp` ON `metric_points` (`timestamp`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_metric_points_session` ON `metric_points` (`session_row_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_metric_points_model` ON `metric_points` (`model`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_metric_points_signal_session` ON `metric_points` (`signal`,`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_metric_points_primary` ON `metric_points` (`is_primary`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_metric_points_metric_name` ON `metric_points` (`metric_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rollup_bucket` ON `metric_rollup` (`bucket`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_oauth_accounts_user_row` ON `oauth_accounts` (`user_row_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_raw_batches_received_at` ON `raw_batches` (`received_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_seen` ON `sessions` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_user_row` ON `sessions` (`user_row_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_source_files_session` ON `source_files` (`session_row_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_account_id` ON `users` (`account_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_user_id` ON `users` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_github_login` ON `users` (`github_login`);