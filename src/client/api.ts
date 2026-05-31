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
  models: Array<{ model: string; totalCost: number; totalTokens: number; sessions: number }>;
  users: Array<{ user: string; totalCost: number; totalTokens: number; sessions: number }>;
  sources: Array<{ source: string; totalCost: number; totalTokens: number; sessions: number }>;
};

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

export type Filters = {
  from?: number;
  to?: number;
  source?: string;
  user?: string;
  model?: string;
  session?: number;
};

function withFilters(path: string, filters: Filters = {}, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (filters.from !== undefined) params.set("from", String(filters.from));
  if (filters.to !== undefined) params.set("to", String(filters.to));
  if (filters.source) params.set("source", filters.source);
  if (filters.user) params.set("user", filters.user);
  if (filters.model) params.set("model", filters.model);
  if (filters.session !== undefined) params.set("session", String(filters.session));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export async function getSummary(filters: Filters = {}) {
  return getJson<Summary>(withFilters("/api/metrics/summary", filters));
}

export type Granularity = "minute" | "five_minute" | "quarter_hour" | "hour" | "day" | "week";

export async function getTimeseries(filters: Filters = {}, granularity: Granularity = "hour") {
  return getJson<TimeseriesPoint[]>(withFilters("/api/metrics/timeseries", filters, { granularity }));
}

export async function getSessions(filters: Filters = {}) {
  return getJson<SessionSummary[]>(withFilters("/api/sessions", filters));
}

export async function getPeople(filters: Filters = {}) {
  return getJson<PersonSummary[]>(withFilters("/api/people", filters));
}

export async function getModels(filters: Filters = {}) {
  return getJson<ModelSummary[]>(withFilters("/api/models", filters));
}

export async function getSession(id: number) {
  return getJson<SessionSummary>(`/api/sessions/${id}`);
}

export async function getMeta() {
  return getJson<FilterOptions>("/api/meta");
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
