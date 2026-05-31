export type SessionSummary = {
  id: number;
  source: string;
  metricSource: "otel" | "jsonl";
  hasOtel: boolean;
  hasJsonl: boolean;
  sessionId: string;
  userId: string | null;
  userEmail: string | null;
  userAccountId: string | null;
  githubLogin: string | null;
  displayName: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  otelTotalTokens: number;
  jsonlTotalTokens: number;
  otelTotalCost: number;
  jsonlTotalCost: number;
  models: string[];
  hasTranscript: boolean;
};

export type PersonSummary = {
  user: string;
  email: string | null;
  displayName: string | null;
  githubLogin: string | null;
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
  users: Array<{
    user: string;
    email: string | null;
    displayName: string | null;
    githubLogin: string | null;
    totalCost: number;
    totalTokens: number;
    sessions: number;
  }>;
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

export type ModelTimeseriesPoint = {
  bucket: number;
  model: string;
  totalTokens: number;
  sessions: number;
};

export type TranscriptInfo = {
  source: string;
  importedAt: number;
  byteSize: number;
  lineCount: number;
};
