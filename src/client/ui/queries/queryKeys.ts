export const dashboardQueryKeyPrefixes = [
  ["meta"],
  ["summary"],
  ["timeseries"],
  ["model-timeseries"],
  ["sessions"],
  ["people"],
  ["models"],
  ["session"],
  ["transcript-info"]
] as const;

export const queryKeys = {
  meta: () => ["meta"] as const,
  health: () => ["health"] as const,
  summary: (filters: unknown) => ["summary", filters] as const,
  timeseries: (filters: unknown, granularity: string) => ["timeseries", filters, granularity] as const,
  modelTimeseries: (filters: unknown, granularity: string) => ["model-timeseries", filters, granularity] as const,
  sessions: (filters: unknown) => ["sessions", filters] as const,
  people: (filters: unknown) => ["people", filters] as const,
  models: (filters: unknown) => ["models", filters] as const,
  session: (id: number) => ["session", id] as const,
  transcriptInfo: (id: number) => ["transcript-info", id] as const
};
