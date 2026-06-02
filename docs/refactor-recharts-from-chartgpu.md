# Refactor: Replace chartgpu (WebGPU) with Recharts

## Problem

The dashboard's 8 time-series charts render with **chartgpu** (`^0.3.2`), a WebGPU charting
library, behind a bespoke streaming wrapper (`src/client/ui/GpuChart.tsx`). WebGPU is brittle
across browsers/headless environments, and the custom `appendData`/`streamAppend` diffing logic
is a lot of one-off surface area to maintain.

The goal is to drop chartgpu and render the charts with **Recharts** (a standard React/SVG
charting lib) while preserving live updates in live mode.

## Why It Matters

Charts are the centerpiece of the dashboard. A WebGPU dependency means silent blank charts
wherever WebGPU isn't available, and the streaming wrapper couples chart rendering to a
library-specific API. Recharts renders plain SVG, re-renders on prop change, and removes the
need for the custom streaming/resize plumbing.

The charting layer is already cleanly isolated, and the data + live-update pipeline is
**library-agnostic**:

- `charts/chartData.ts` (`densify`, `modelSeries`) transforms API rows into chart-ready data —
  no chartgpu dependency.
- Live updates flow through React Query: `hooks/useLiveInvalidation.ts` (SSE `/events` →
  invalidate queries) + `refetchInterval: 30_000` for live ranges (`queries/dashboardQueries.ts`).
  New data arrives as **props**, so any chart that re-renders on prop change updates live for
  free. Recharts re-renders on new `data` — no streaming code needed (the 8 charts have ≤2000
  points, so SVG re-render is fine).
- The `BreakdownCard` bars in `views/HomeView.tsx` are already hand-rolled native CSS — untouched.

## Decisions

- **Recharts for all 8** time-series charts (tokens, cost, tokens/sessions by model, lines,
  edits, PRs, commits). Keep the existing native CSS breakdown bars.
- **Animate on first paint only** — suppress animation replay on every live tick.

## Changes

### 1. `package.json`
Remove `"chartgpu": "^0.3.2"`; add `recharts` (2.x). Run `npm install`.

### 2. Delete `src/client/ui/GpuChart.tsx`
The WebGPU wrapper + `streamAppend` streaming logic is no longer needed — Recharts'
`ResponsiveContainer` replaces the `ResizeObserver`, and prop-driven re-render replaces streaming.

### 3. New `src/client/ui/charts/TimeSeriesChart.tsx`
A single reusable Recharts component used by all 8 charts. Props:

```ts
{
  data: Array<Record<string, number>>;       // rows keyed by `bucket` + each series' dataKey
  series: ReadonlyArray<{ name: string; color: string; dataKey: string }>;
  granularity: Granularity;
  axisFormatter: (v: number) => string;       // y-axis ticks
  tooltipFormatter: (v: number) => string;    // tooltip values
  theme: Theme;
}
```

Renders `ResponsiveContainer` (width 100%, height 220 — replaces the inline `style`) wrapping
`LineChart`:

- `CartesianGrid` (horizontal only) using the theme grid color.
- `XAxis dataKey="bucket"` type `number`, `domain={["dataMin","dataMax"]}`, scale `time`,
  `tickFormatter` = `formatAxisTime(value, granularity)`.
- `YAxis` with `tickFormatter` = `axisFormatter`.
- `Tooltip` with `labelFormatter` = `formatTooltipTime`, value `formatter` = `tooltipFormatter`,
  and `contentStyle`/`itemStyle` driven by theme colors so dark/light match.
- One `<Line>` per series: `dataKey`, `stroke={color}`, `strokeWidth={2.5}`, `dot={false}`,
  `connectNulls`, `type="monotone"`.
- **Animate-first-paint-only:** local `isAnimationActive` state starting `true`, flipped to
  `false` via `onAnimationEnd`. Subsequent live data updates re-render with animation off — no
  replay/flash (mirrors the dropped chartgpu behavior).

### 4. Replace `src/client/ui/charts/chartOptions.ts`
Strip the `ChartGPUOptions` builders (`lineOptions`, `seriesLineOptions`,
`multiSeriesLineOptions`). **Keep / export** the still-needed pure helpers:
`granularityLabel`, `formatAxisTime`, `formatTooltipTime`, `isIntradayMinutes`, the `PALETTE`
constant, and a per-`Theme` color map (`grid`, `axisLine`, `text`, `tooltipBg`) derived from the
existing `CHART_THEME`/`GRID_LINE_COLOR` constants for `TimeSeriesChart` to consume.

### 5. `src/client/ui/charts/chartData.ts`
Add a helper to pivot `NamedSeries[]` (model series, each `{name,color,data:[{x,y}]}`) into
Recharts rows. `modelSeries` builds every series off the same `bucketAxis`, so the `data` arrays
are index-aligned — zip by index:

```ts
export function toChartRows(series: NamedSeries[]): {
  rows: Array<Record<string, number>>;             // [{ bucket, [model]: value, ... }]
  keys: Array<{ name: string; color: string; dataKey: string }>;
}
```

`densify`/`modelSeries` are unchanged.

### 6. Rewrite `src/client/ui/charts/UsageCharts.tsx`
Replace the `useMemo<ChartGPUOptions>` blocks + `<GpuChart options=...>` with `<TimeSeriesChart>`
instances. Dense-based charts pass `data={dense}` with `dataKey` set to the field name:

- Tokens: `dataKey:"totalTokens"`.
- Cost: `dataKey:"totalCost"`, `axisFormatter=formatCurrencyCompact`, `tooltipFormatter=formatCurrency`.
- Lines / Edits / PRs / Commits: convert the `get` accessors in `LINES_SERIES` / `EDITS_SERIES` /
  `PR_SERIES` / `COMMIT_SERIES` to `dataKey` strings (`linesAdded`, `linesRemoved`,
  `editsAccepted`, `editsRejected`, `pullRequests`, `commits` — all direct `TimeseriesPoint`
  fields, so `dataKey` works directly).
- Tokens-by-model / Sessions-by-model: feed `modelSeries(...)` through `toChartRows(...)`.

The `ActivityChart` wrapper (title + legend chips + `EmptyState`) stays; only its inner chart
swaps from `GpuChart` to `TimeSeriesChart`. Legend chips already render from `{name,color}`.

## Live Updates (unchanged)

No changes to `useLiveInvalidation.ts`, `dashboardQueries.ts`, or `HomeView.tsx`. Recharts
re-renders when `timeseries.data` / `modelTimeseries.data` change after a poll or SSE `ingest`
invalidation. The "live" pill and 30s polling are untouched.

## Verification

1. `npm run typecheck` — must pass (strict; catches removed `ChartGPUOptions` types).
2. `npm test`.
3. `npm run dev`, open the dashboard — all 8 charts render; tooltips show formatted time +
   values; light/dark toggle recolors them; axes format per granularity.
4. **Live mode:** select "today"/"now", ingest new telemetry (`./scripts/run-claude.sh` or a hook
   upload), and confirm charts update within ~30s (or instantly on SSE `ingest`) **without**
   replaying the entry animation — only the first paint animates.
5. `grep -rn "chartgpu\|ChartGPU\|GpuChart" src/` returns nothing.
