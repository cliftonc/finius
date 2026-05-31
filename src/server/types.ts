export type MetricKind =
  | "tokens"
  | "cost"
  | "lines"
  | "decision"
  | "active_time"
  | "session"
  | "pull_request"
  | "commit";

export type MetricPointInput = {
  source: string;
  signal: "otlp_metrics" | "jsonl";
  sessionId: string;
  userId?: string | null;
  userEmail?: string | null;
  userAccountId?: string | null;
  model?: string | null;
  metricName: string;
  kind: MetricKind;
  tokenType?: string | null;
  value: number;
  unit?: string | null;
  timestamp: number;
  attributes?: Record<string, unknown>;
};

export type SessionSummary = {
  id: number;
  source: string;
  sessionId: string;
  userId: string | null;
  userEmail: string | null;
  userAccountId: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  models: string[];
};

export type SummaryFilters = {
  from?: number;
  to?: number;
  user?: string;
  model?: string;
  source?: string;
  session?: number;
};

export type PersonSummary = {
  user: string;
  sessions: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  lastSeenAt: number;
  models: string[];
};

export type ModelSummary = {
  model: string;
  sessions: number;
  users: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  lastSeenAt: number;
};

export type FilterOptions = {
  sources: string[];
  users: string[];
  models: string[];
};

export type Summary = {
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  sessionCount: number;
  activeSenders: number;
  linesAdded: number;
  linesRemoved: number;
  editsAccepted: number;
  editsRejected: number;
  pullRequests: number;
  commits: number;
  models: Array<{ model: string; totalCost: number; totalTokens: number; sessions: number }>;
  users: Array<{ user: string; totalCost: number; totalTokens: number; sessions: number }>;
  sources: Array<{ source: string; totalCost: number; totalTokens: number; sessions: number }>;
};

export type Granularity = "minute" | "five_minute" | "quarter_hour" | "hour" | "day" | "week";

export type TimeseriesPoint = {
  bucket: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheTokens: number;
  totalTokens: number;
  linesAdded: number;
  linesRemoved: number;
  editsAccepted: number;
  editsRejected: number;
  pullRequests: number;
  commits: number;
};

export type TranscriptInfo = {
  source: string;
  importedAt: number;
  byteSize: number;
  lineCount: number;
};

export type ImportResult = {
  duplicate?: boolean;
  importedLines: number;
  malformedLines: number;
  metricPoints: number;
  rawEvents: number;
};

export interface StorageAdapter {
  ingestOtelMetrics(batch: unknown): Promise<{ duplicate: boolean; points: number }>;
  ingestOtelLogs(batch: unknown): Promise<{ duplicate: boolean; events: number }>;
  importJsonl(source: string, sessionHint: Partial<MetricPointInput>, content: string): Promise<ImportResult>;
  getSessionTranscript(sessionRowId: number): Promise<{ content: string; source: string; importedAt: number } | null>;
  getSessionTranscriptInfo(sessionRowId: number): Promise<TranscriptInfo | null>;
  getSummary(filters: SummaryFilters): Promise<Summary>;
  getTimeseries(filters: SummaryFilters & { granularity?: Granularity }): Promise<TimeseriesPoint[]>;
  listSessions(filters: SummaryFilters): Promise<SessionSummary[]>;
  getSession(id: number): Promise<SessionSummary | null>;
  listPeople(filters: SummaryFilters): Promise<PersonSummary[]>;
  listModels(filters: SummaryFilters): Promise<ModelSummary[]>;
  getFilterOptions(): Promise<FilterOptions>;
  pruneRawBatches(beforeTimestampMs: number): Promise<{ deleted: number }>;
  close(): void;
}
