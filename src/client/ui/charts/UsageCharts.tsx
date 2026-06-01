import { Card, CardBody } from "@heroui/react";
import type { ChartGPUOptions } from "chartgpu";
import { useMemo } from "react";
import type { Granularity, ModelTimeseriesPoint, TimeseriesPoint } from "../../api";
import { formatCurrency, formatCurrencyCompact, formatNumber } from "../../format";
import { useTheme } from "../../theme";
import { EmptyState } from "../EmptyState";
import { GpuChart } from "../GpuChart";
import { densify, modelSeries } from "./chartData";
import { granularityLabel, lineOptions, multiSeriesLineOptions, seriesLineOptions } from "./chartOptions";

const GRANULARITY_MS: Record<Granularity, number> = {
  minute: 60_000,
  five_minute: 300_000,
  quarter_hour: 900_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000
};

const TOKEN_COLOR = "#2563eb";
const COST_COLOR = "#d97706";

const LINES_SERIES = [
  { name: "Added", color: "#0f766e", get: (point: TimeseriesPoint) => point.linesAdded },
  { name: "Removed", color: "#ef4444", get: (point: TimeseriesPoint) => point.linesRemoved }
] as const;

const EDITS_SERIES = [
  { name: "Accepted", color: "#0f766e", get: (point: TimeseriesPoint) => point.editsAccepted },
  { name: "Rejected", color: "#ef4444", get: (point: TimeseriesPoint) => point.editsRejected }
] as const;

const PR_SERIES = [{ name: "Pull requests", color: "#a855f7", get: (point: TimeseriesPoint) => point.pullRequests }] as const;
const COMMIT_SERIES = [{ name: "Commits", color: "#2563eb", get: (point: TimeseriesPoint) => point.commits }] as const;
export function UsageCharts({
  points,
  modelPoints,
  from,
  granularity
}: {
  points: TimeseriesPoint[];
  modelPoints: ModelTimeseriesPoint[];
  from?: number;
  granularity: Granularity;
}) {
  const { theme } = useTheme();
  const dense = useMemo(() => densify(points, from, GRANULARITY_MS[granularity]), [points, from, granularity]);
  const empty = dense.length === 0;

  // Pivot the flat per-(bucket, model) rows into one densified line per model (top models only, so
  // the legend stays readable), once for tokens and once for distinct session counts.
  const tokenByModel = useMemo(
    () => modelSeries(modelPoints, "totalTokens", from, GRANULARITY_MS[granularity]),
    [modelPoints, from, granularity]
  );
  const sessionByModel = useMemo(
    () => modelSeries(modelPoints, "sessions", from, GRANULARITY_MS[granularity]),
    [modelPoints, from, granularity]
  );
  const modelEmpty = tokenByModel.length === 0;

  const tokenByModelOptions = useMemo<ChartGPUOptions>(
    () => multiSeriesLineOptions(tokenByModel, granularity, formatNumber, formatNumber, theme),
    [tokenByModel, granularity, theme]
  );
  const sessionByModelOptions = useMemo<ChartGPUOptions>(
    () => multiSeriesLineOptions(sessionByModel, granularity, formatNumber, formatNumber, theme),
    [sessionByModel, granularity, theme]
  );

  const tokenOptions = useMemo<ChartGPUOptions>(
    () => lineOptions(dense, granularity, "totalTokens", TOKEN_COLOR, (value) => `${formatNumber(value)} tokens`, formatNumber, theme),
    [dense, granularity, theme]
  );

  const costOptions = useMemo<ChartGPUOptions>(
    () => lineOptions(dense, granularity, "totalCost", COST_COLOR, formatCurrency, formatCurrencyCompact, theme),
    [dense, granularity, theme]
  );

  const linesOptions = useMemo<ChartGPUOptions>(
    () => seriesLineOptions(dense, granularity, LINES_SERIES, formatNumber, formatNumber, theme),
    [dense, granularity, theme]
  );

  const editsOptions = useMemo<ChartGPUOptions>(
    () => seriesLineOptions(dense, granularity, EDITS_SERIES, formatNumber, formatNumber, theme),
    [dense, granularity, theme]
  );

  const prOptions = useMemo<ChartGPUOptions>(
    () => seriesLineOptions(dense, granularity, PR_SERIES, formatNumber, formatNumber, theme),
    [dense, granularity, theme]
  );

  const commitOptions = useMemo<ChartGPUOptions>(
    () => seriesLineOptions(dense, granularity, COMMIT_SERIES, formatNumber, formatNumber, theme),
    [dense, granularity, theme]
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card shadow="sm">
          <CardBody className="gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">Tokens over time</h2>
              <span className="text-sm text-default-500">
                {dense.length} {granularityLabel(granularity)} buckets
              </span>
            </div>
            {empty ? <EmptyState>No telemetry yet</EmptyState> : <GpuChart options={tokenOptions} style={{ width: "100%", height: 220 }} />}
          </CardBody>
        </Card>

        <Card shadow="sm">
          <CardBody className="gap-3">
            <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">Cost over time</h2>
            {empty ? <EmptyState>No telemetry yet</EmptyState> : <GpuChart options={costOptions} style={{ width: "100%", height: 220 }} />}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ActivityChart title="Tokens by model" series={tokenByModel} options={tokenByModelOptions} empty={modelEmpty} emptyLabel="No model telemetry yet" />
        <ActivityChart title="Sessions by model" series={sessionByModel} options={sessionByModelOptions} empty={modelEmpty} emptyLabel="No model telemetry yet" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ActivityChart title="Lines of code" series={LINES_SERIES} options={linesOptions} empty={empty} />
        <ActivityChart title="Edit decisions" series={EDITS_SERIES} options={editsOptions} empty={empty} />
        <ActivityChart title="Pull requests" series={PR_SERIES} options={prOptions} empty={empty} />
        <ActivityChart title="Commits" series={COMMIT_SERIES} options={commitOptions} empty={empty} />
      </div>
    </div>
  );
}

function ActivityChart({
  title,
  series,
  options,
  empty,
  emptyLabel = "No telemetry yet"
}: {
  title: string;
  series: ReadonlyArray<{ name: string; color: string }>;
  options: ChartGPUOptions;
  empty: boolean;
  emptyLabel?: string;
}) {
  return (
    <Card shadow="sm">
      <CardBody className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">{title}</h2>
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
            {series.map((entry) => (
              <span key={entry.name} className="flex items-center gap-1.5 text-sm text-default-600">
                <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: entry.color }} />
                {entry.name}
              </span>
            ))}
          </div>
        </div>
        {empty ? <EmptyState>{emptyLabel}</EmptyState> : <GpuChart options={options} style={{ width: "100%", height: 220 }} />}
      </CardBody>
    </Card>
  );
}
