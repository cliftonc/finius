import type { ModelTimeseriesPoint, TimeseriesPoint } from "../../api";

const PALETTE = ["#2563eb", "#0f766e", "#a855f7", "#f59e0b", "#ef4444", "#14b8a6", "#6366f1", "#ec4899"];
const MAX_MODEL_SERIES = 6;

export type NamedSeries = { name: string; color: string; data: Array<{ x: number; y: number }> };

export function densify(points: TimeseriesPoint[], from: number | undefined, stepMs: number): TimeseriesPoint[] {
  if (points.length === 0 && from == null) return [];
  const byBucket = new Map(points.map((point) => [point.bucket, point]));
  const firstData = points.length ? points[0].bucket : (from ?? Date.now());
  const start = Math.floor((from ?? firstData) / stepMs) * stepMs;
  const now = Math.floor(Date.now() / stepMs) * stepMs;
  const lastData = points.length ? points[points.length - 1].bucket : start;
  const end = Math.max(now, lastData);
  const out: TimeseriesPoint[] = [];
  for (let t = start, i = 0; t <= end && i < 2000; t += stepMs, i++) {
    out.push(
      byBucket.get(t) ?? {
        bucket: t,
        totalCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        linesAdded: 0,
        linesRemoved: 0,
        editsAccepted: 0,
        editsRejected: 0,
        pullRequests: 0,
        commits: 0
      }
    );
  }
  return out;
}

export function modelSeries(
  points: ModelTimeseriesPoint[],
  key: "totalTokens" | "sessions",
  from: number | undefined,
  stepMs: number
): NamedSeries[] {
  if (points.length === 0) return [];
  const byModel = new Map<string, Map<number, number>>();
  const totals = new Map<string, number>();
  for (const point of points) {
    const bucket = Math.floor(point.bucket / stepMs) * stepMs;
    let series = byModel.get(point.model);
    if (!series) {
      series = new Map();
      byModel.set(point.model, series);
    }
    series.set(bucket, (series.get(bucket) ?? 0) + point[key]);
    totals.set(point.model, (totals.get(point.model) ?? 0) + point[key]);
  }

  const models = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_MODEL_SERIES)
    .map(([model]) => model)
    .filter((model) => (totals.get(model) ?? 0) > 0);

  const buckets = bucketAxis(points.map((p) => p.bucket), from, stepMs);
  return models.map((model, index) => {
    const series = byModel.get(model);
    return {
      name: model,
      color: PALETTE[index % PALETTE.length],
      data: buckets.map((bucket) => ({ x: bucket, y: series?.get(bucket) ?? 0 }))
    };
  });
}

function bucketAxis(dataBuckets: number[], from: number | undefined, stepMs: number): number[] {
  const firstData = dataBuckets.length ? Math.min(...dataBuckets) : (from ?? Date.now());
  const start = Math.floor((from ?? firstData) / stepMs) * stepMs;
  const now = Math.floor(Date.now() / stepMs) * stepMs;
  const lastData = dataBuckets.length ? Math.max(...dataBuckets) : start;
  const end = Math.max(now, lastData);
  const out: number[] = [];
  for (let t = start, i = 0; t <= end && i < 2000; t += stepMs, i++) out.push(t);
  return out;
}
