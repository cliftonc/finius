import type {
  FilterOptions,
  Granularity,
  ModelSummary,
  ModelTimeseriesPoint,
  PersonSummary,
  SessionSummary,
  Summary,
  TimeseriesPoint,
  TranscriptInfo
} from "../shared/api-types.js";

export type {
  FilterOptions,
  Granularity,
  ModelSummary,
  ModelTimeseriesPoint,
  PersonSummary,
  SessionSummary,
  Summary,
  TimeseriesPoint,
  TranscriptInfo
} from "../shared/api-types.js";

export type MetricKind =
  | "tokens"
  | "cost"
  | "lines"
  | "decision"
  | "active_time"
  | "session"
  | "pull_request"
  | "commit";

// Which coding agent wrote a transcript. Selects the matching parser (see server/transcripts.ts).
// Add a new agent by extending this union and the parser dispatch.
export type TranscriptFormat = "claude" | "codex";

export type MetricPointInput = {
  source: string;
  signal: "otlp_metrics" | "jsonl";
  sessionId: string;
  userId?: string | null;
  userEmail?: string | null;
  userAccountId?: string | null;
  // Identity enrichment carried on the sessionHint (not from OTEL metrics): used only to populate the
  // `users` registry, never aggregated. Present on JSONL/rollout imports that resolved a GitHub login.
  githubLogin?: string | null;
  displayName?: string | null;
  model?: string | null;
  metricName: string;
  kind: MetricKind;
  tokenType?: string | null;
  value: number;
  unit?: string | null;
  timestamp: number;
  attributes?: Record<string, unknown>;
};

export type SummaryFilters = {
  from?: number;
  to?: number;
  user?: string;
  model?: string;
  source?: string;
  session?: number;
};

// A single OTLP log record, flattened out of the resourceLogs→scopeLogs→logRecords nesting and
// decoded into plain values. Codex's native telemetry is logs-only (no metrics/spans), so this is
// how we capture what it actually sends. `eventName` is the OTLP event name (Codex uses values like
// `codex.sse_event`, `codex.api_request`); kept loose because we capture before we parse.
export type OtelLogRecord = {
  eventName: string | null;
  severityText: string | null;
  timestamp: number;
  sessionId: string | null;
  attributes: Record<string, unknown>;
  body: unknown;
};

// Grouped view of captured log records for the inspection endpoint (GET /api/logs/events): one entry
// per distinct event name with a count, the most recent timestamp, and one sample record so we can
// see the real shape Codex emits before committing to a parser.
export type LogEventSummary = {
  eventName: string;
  count: number;
  lastSeenAt: number;
  sample: { attributes: Record<string, unknown>; body: unknown } | null;
};

// Per-model token pricing used to compute cost ourselves when the agent doesn't report it (Codex
// rollouts and JSONL Claude transcripts carry no cost). Rates are USD per single token, by token
// type — they map 1:1 onto our metric_points token_type values (input/output/cache_read/
// cache_creation). `effectiveDate` (epoch ms) lets dated rows accrete so historical usage can be
// priced by the rate in effect at the time (LiteLLM only publishes current pricing).
export type ModelPrice = {
  model: string;
  provider: string | null;
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number;
  cacheCreationPerToken: number;
  effectiveDate: number;
};

export type ImportResult = {
  duplicate?: boolean;
  importedLines: number;
  malformedLines: number;
  metricPoints: number;
  rawEvents: number;
};

// A minted client auth session token as surfaced to a (future) admin GUI. The raw token is never
// stored — only its sha256 in auth_tokens.token_hash.
export type AuthTokenRecord = {
  id: number;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: number;
};

// Result of authenticating a request in Secure Mode. 'master' = the server password was presented
// directly; 'token' = a minted session token matched (tokenId names the auth_tokens row).
export type AuthContext = { kind: "master" | "token"; tokenId?: number };

export interface StorageAdapter {
  ingestOtelMetrics(batch: unknown): Promise<{ duplicate: boolean; points: number }>;
  ingestOtelLogs(batch: unknown): Promise<{ duplicate: boolean; events: number }>;
  getLogEventSummary(): Promise<LogEventSummary[]>;
  // Per-model pricing used to synthesize cost. `importPricing` inserts dated rows and reloads the
  // in-memory lookup; `recomputeComputedCost` rebuilds the synthesized `finius.cost.computed` points
  // from existing token points (cheap — no transcript re-parse). Both are idempotent.
  getPricing(): Promise<ModelPrice[]>;
  importPricing(prices: ModelPrice[]): Promise<{ imported: number }>;
  recomputeComputedCost(): Promise<{ costPoints: number }>;
  // Synchronous import (parse + process inline), returning the full result. Used by tests / CLI-direct.
  importJsonl(
    source: string,
    sessionHint: Partial<MetricPointInput>,
    content: string,
    format?: TranscriptFormat
  ): Promise<ImportResult>;
  // Upload path: persist the blob immediately and hand processing to the single background queue.
  // `settleIngest` drains it; `setProcessingListener` is notified when each queued job completes.
  enqueueImport(
    source: string,
    sessionHint: Partial<MetricPointInput>,
    content: string,
    format?: TranscriptFormat
  ): Promise<{ duplicate: boolean; queued: boolean }>;
  settleIngest(): Promise<void>;
  setProcessingListener(listener: (signal: string, result: ImportResult) => void): void;
  getSessionTranscript(sessionRowId: number): Promise<{ content: string; source: string; importedAt: number } | null>;
  getSessionTranscriptInfo(sessionRowId: number): Promise<TranscriptInfo | null>;
  getSummary(filters: SummaryFilters): Promise<Summary>;
  getTimeseries(filters: SummaryFilters & { granularity?: Granularity }): Promise<TimeseriesPoint[]>;
  getModelTimeseries(filters: SummaryFilters & { granularity?: Granularity }): Promise<ModelTimeseriesPoint[]>;
  listSessions(filters: SummaryFilters): Promise<SessionSummary[]>;
  getSession(id: number): Promise<SessionSummary | null>;
  listPeople(filters: SummaryFilters): Promise<PersonSummary[]>;
  listModels(filters: SummaryFilters): Promise<ModelSummary[]>;
  getFilterOptions(): Promise<FilterOptions>;
  pruneRawBatches(beforeTimestampMs: number): Promise<{ deleted: number }>;
  createAuthToken(tokenHash: string, label: string, now: number): void;
  findAuthToken(tokenHash: string): { id: number; revoked: number } | null;
  listAuthTokens(): AuthTokenRecord[];
  revokeAuthToken(id: number): void;
  close(): void;
}
