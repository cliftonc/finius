import type { ChartGPUOptions, ThemeConfig, TooltipParams } from "chartgpu";
import type { Granularity, TimeseriesPoint } from "../../api";
import type { Theme } from "../../theme";
import type { NamedSeries } from "./chartData";

const PALETTE = ["#2563eb", "#0f766e", "#a855f7", "#f59e0b", "#ef4444", "#14b8a6", "#6366f1", "#ec4899"];
const GRID_LINE_COLOR: Record<Theme, string> = { light: "#eef2f6", dark: "#222d24" };
const CHART_FONT = "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif";

const CHART_THEME: Record<Theme, ThemeConfig> = {
  light: {
    backgroundColor: "#ffffff",
    textColor: "#586250",
    axisLineColor: "rgba(22,32,26,0.22)",
    axisTickColor: "rgba(22,32,26,0.42)",
    gridLineColor: GRID_LINE_COLOR.light,
    colorPalette: PALETTE,
    fontFamily: CHART_FONT,
    fontSize: 12
  },
  dark: {
    backgroundColor: "#161d18",
    textColor: "#9aa899",
    axisLineColor: "rgba(231,236,228,0.22)",
    axisTickColor: "rgba(231,236,228,0.4)",
    gridLineColor: GRID_LINE_COLOR.dark,
    colorPalette: PALETTE,
    fontFamily: CHART_FONT,
    fontSize: 12
  }
};

export function lineOptions(
  dense: TimeseriesPoint[],
  granularity: Granularity,
  key: "totalTokens" | "totalCost",
  color: string,
  tooltipValue: (value: number) => string,
  axisValue: (value: number) => string,
  chartTheme: Theme
): ChartGPUOptions {
  return {
    theme: CHART_THEME[chartTheme],
    animation: { duration: 280, easing: "cubicOut" },
    legend: { show: false },
    grid: { left: 64, right: 22, top: 16, bottom: 28 },
    gridLines: { horizontal: true, vertical: false, color: GRID_LINE_COLOR[chartTheme] },
    palette: [color],
    xAxis: { type: "time", tickFormatter: (value) => formatAxisTime(value, granularity) },
    yAxis: { type: "value", tickFormatter: axisValue },
    tooltip: {
      trigger: "axis",
      formatter: (params: TooltipParams | readonly TooltipParams[]) => {
        const first = Array.isArray(params) ? params[0] : params;
        if (!first) return "";
        return `${formatTooltipTime(first.value[0], granularity)}<br/>${tooltipValue(first.value[1])}`;
      }
    },
    series: [
      {
        type: "line",
        name: key === "totalCost" ? "Cost" : "Tokens",
        color,
        lineStyle: { width: 2.5 },
        connectNulls: true,
        data: dense.map((point) => ({ x: point.bucket, y: point[key] }))
      }
    ]
  };
}

export function seriesLineOptions(
  dense: TimeseriesPoint[],
  granularity: Granularity,
  series: ReadonlyArray<{ name: string; color: string; get: (point: TimeseriesPoint) => number }>,
  axisValue: (value: number) => string,
  tooltipValue: (value: number) => string,
  chartTheme: Theme
): ChartGPUOptions {
  return {
    theme: CHART_THEME[chartTheme],
    animation: { duration: 280, easing: "cubicOut" },
    legend: { show: false },
    grid: { left: 64, right: 22, top: 16, bottom: 28 },
    gridLines: { horizontal: true, vertical: false, color: GRID_LINE_COLOR[chartTheme] },
    palette: series.map((entry) => entry.color),
    xAxis: { type: "time", tickFormatter: (value) => formatAxisTime(value, granularity) },
    yAxis: { type: "value", tickFormatter: axisValue },
    tooltip: {
      trigger: "axis",
      formatter: (params: TooltipParams | readonly TooltipParams[]) => {
        const arr = Array.isArray(params) ? params : [params];
        if (arr.length === 0) return "";
        const lines = arr.map((item) => `${item.seriesName}: ${tooltipValue(item.value[1])}`);
        return `${formatTooltipTime(arr[0].value[0], granularity)}<br/>${lines.join("<br/>")}`;
      }
    },
    series: series.map((entry) => ({
      type: "line",
      name: entry.name,
      color: entry.color,
      lineStyle: { width: 2.5 },
      connectNulls: true,
      data: dense.map((point) => ({ x: point.bucket, y: entry.get(point) }))
    }))
  };
}

export function multiSeriesLineOptions(
  series: NamedSeries[],
  granularity: Granularity,
  axisValue: (value: number) => string,
  tooltipValue: (value: number) => string,
  chartTheme: Theme
): ChartGPUOptions {
  return {
    theme: CHART_THEME[chartTheme],
    animation: { duration: 280, easing: "cubicOut" },
    legend: { show: false },
    grid: { left: 64, right: 22, top: 16, bottom: 28 },
    gridLines: { horizontal: true, vertical: false, color: GRID_LINE_COLOR[chartTheme] },
    palette: series.map((entry) => entry.color),
    xAxis: { type: "time", tickFormatter: (value) => formatAxisTime(value, granularity) },
    yAxis: { type: "value", tickFormatter: axisValue },
    tooltip: {
      trigger: "axis",
      formatter: (params: TooltipParams | readonly TooltipParams[]) => {
        const arr = Array.isArray(params) ? params : [params];
        if (arr.length === 0) return "";
        const lines = arr.map((item) => `${item.seriesName}: ${tooltipValue(item.value[1])}`);
        return `${formatTooltipTime(arr[0].value[0], granularity)}<br/>${lines.join("<br/>")}`;
      }
    },
    series: series.map((entry) => ({
      type: "line",
      name: entry.name,
      color: entry.color,
      lineStyle: { width: 2.5 },
      connectNulls: true,
      data: entry.data
    }))
  };
}

export function granularityLabel(granularity: Granularity): string {
  return { minute: "minute", five_minute: "5-min", quarter_hour: "15-min", hour: "hourly", day: "daily", week: "weekly" }[granularity];
}

function isIntradayMinutes(granularity: Granularity): boolean {
  return granularity === "minute" || granularity === "five_minute" || granularity === "quarter_hour";
}

function formatAxisTime(value: number, granularity: Granularity): string {
  const date = new Date(value);
  if (isIntradayMinutes(granularity)) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  if (granularity === "hour") {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatTooltipTime(value: number, granularity: Granularity): string {
  const date = new Date(value);
  if (isIntradayMinutes(granularity)) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  if (granularity === "hour") {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit" }).format(date);
  }
  if (granularity === "week") {
    return `Week of ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}`;
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
