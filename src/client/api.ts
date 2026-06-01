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
  mine?: boolean;
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

export function storeAuthToken(token: string) {
  window.localStorage.setItem(AUTH_STORAGE_KEY, token);
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
  if (filters.mine) params.set("mine", "1");
  if (filters.model) params.set("model", filters.model);
  if (filters.session !== undefined) params.set("session", String(filters.session));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export async function getSummary(filters: Filters = {}, signal?: AbortSignal) {
  return getJson<Summary>(withFilters("/api/metrics/summary", filters), signal);
}

export async function getTimeseries(filters: Filters = {}, granularity: Granularity = "hour", signal?: AbortSignal) {
  return getJson<TimeseriesPoint[]>(withFilters("/api/metrics/timeseries", filters, { granularity }), signal);
}

export async function getModelTimeseries(filters: Filters = {}, granularity: Granularity = "hour", signal?: AbortSignal) {
  return getJson<ModelTimeseriesPoint[]>(withFilters("/api/metrics/timeseries/by-model", filters, { granularity }), signal);
}

export async function getSessions(filters: Filters = {}, signal?: AbortSignal) {
  return getJson<SessionSummary[]>(withFilters("/api/sessions", filters), signal);
}

export async function getPeople(filters: Filters = {}, signal?: AbortSignal) {
  return getJson<PersonSummary[]>(withFilters("/api/people", filters), signal);
}

export async function getModels(filters: Filters = {}, signal?: AbortSignal) {
  return getJson<ModelSummary[]>(withFilters("/api/models", filters), signal);
}

export async function getSession(id: number, signal?: AbortSignal) {
  return getJson<SessionSummary>(`/api/sessions/${id}`, signal);
}

export async function getTranscriptInfo(id: number, signal?: AbortSignal): Promise<TranscriptInfo | null> {
  const response = await fetch(transcriptUrl(id, "info"), { headers: authHeaders(), signal });
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

export async function getTranscript(id: number, signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(transcriptUrl(id), { headers: authHeaders(), signal });
  if (response.status === 404) return null;
  if (response.status === 401) {
    clearAuthToken();
    throw new AuthError();
  }
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}

export async function getMeta(signal?: AbortSignal) {
  return getJson<FilterOptions>("/api/meta", signal);
}

// Thrown on a 401 so the UI can show the login screen instead of a generic error.
export class AuthError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "AuthError";
  }
}

export type Health = { ok: boolean; now: number; secure: boolean };
export type AuthProviders = {
  password?: { enabled: boolean };
  github: { enabled: boolean; requiredOrg?: string; loginUrl?: string };
};
export type AuthMe = { user: { id: number; email: string | null; displayName: string | null; githubLogin: string | null } | null };

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Health>;
}

export async function getAuthProviders(signal?: AbortSignal): Promise<AuthProviders> {
  const response = await fetch("/api/auth/providers", { signal });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<AuthProviders>;
}

export async function getMe(signal?: AbortSignal): Promise<AuthMe> {
  return getJson<AuthMe>("/api/auth/me", signal);
}

// Exchange the server password for a session token. Returns the token on success, null on failure.
export async function login(password: string): Promise<string | null> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, label: "browser" })
  });
  if (response.ok) {
    const body = (await response.json()) as { token?: string };
    if (body.token) {
      storeAuthToken(body.token);
      return body.token;
    }
  }
  return null;
}

// Revoke the current session on the server (clears the HttpOnly GitHub cookie + revokes the token)
// and drop any locally-stored bearer token. Best-effort: the local clear happens regardless.
export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", headers: authHeaders() });
  } catch {
    /* ignore network errors — we still clear the local token below */
  }
  clearAuthToken();
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: authHeaders(), signal });
  if (response.status === 401) {
    clearAuthToken();
    throw new AuthError();
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
