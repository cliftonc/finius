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
} from "../shared/api-types";

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
} from "../shared/api-types";

export type Filters = {
  from?: number;
  to?: number;
  source?: string;
  user?: string;
  model?: string;
  session?: number;
};

const AUTH_STORAGE_KEY = "finius_auth_token";

export function getAuthToken(): string {
  return window.localStorage.getItem(AUTH_STORAGE_KEY) ?? "";
}

export function clearAuthToken() {
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

function authHeaders(): HeadersInit | undefined {
  const token = getAuthToken();
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

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

export async function getTimeseries(filters: Filters = {}, granularity: Granularity = "hour") {
  return getJson<TimeseriesPoint[]>(withFilters("/api/metrics/timeseries", filters, { granularity }));
}

export async function getModelTimeseries(filters: Filters = {}, granularity: Granularity = "hour") {
  return getJson<ModelTimeseriesPoint[]>(withFilters("/api/metrics/timeseries/by-model", filters, { granularity }));
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

export async function getTranscriptInfo(id: number): Promise<TranscriptInfo | null> {
  const response = await fetch(transcriptUrl(id, "info"), { headers: authHeaders() });
  if (response.status === 404) return null;
  if (response.status === 401) {
    clearAuthToken();
    throw new AuthError();
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<TranscriptInfo>;
}

export function transcriptUrl(id: number, kind?: "info") {
  return `/api/sessions/${id}/transcript${kind ? `/${kind}` : ""}`;
}

export async function getTranscript(id: number): Promise<string | null> {
  const response = await fetch(transcriptUrl(id), { headers: authHeaders() });
  if (response.status === 404) return null;
  if (response.status === 401) {
    clearAuthToken();
    throw new AuthError();
  }
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}

export async function getMeta() {
  return getJson<FilterOptions>("/api/meta");
}

// Thrown on a 401 so the UI can show the login screen instead of a generic error.
export class AuthError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "AuthError";
  }
}

export type Health = { ok: boolean; now: number; secure: boolean };

export async function getHealth(): Promise<Health> {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Health>;
}

// Exchange the server password for a session token. Returns true on success, false on a bad password.
export async function login(password: string): Promise<boolean> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, label: "browser" })
  });
  if (response.ok) {
    const body = (await response.json()) as { token?: string };
    if (body.token) window.localStorage.setItem(AUTH_STORAGE_KEY, body.token);
  }
  return response.ok;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (response.status === 401) {
    clearAuthToken();
    throw new AuthError();
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
