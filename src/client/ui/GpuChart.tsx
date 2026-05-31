import { ChartGPU } from "chartgpu";
import type { ChartGPUInstance, ChartGPUOptions, DataPoint } from "chartgpu";
import { useEffect, useRef } from "react";

type Point = { x: number; y: number };

/**
 * React wrapper around ChartGPU (WebGPU) with incremental streaming.
 *
 * Rather than replacing the whole dataset on every data tick, it diffs the incoming series
 * against what's already on the chart:
 *  - if the new data is a pure extension of the current data, the appended tail is streamed in
 *    via `appendData(...)` (no re-upload, no re-render);
 *  - otherwise (a value changed, the window slid, granularity/range changed) it falls back to
 *    `setOption(...)` with the entry animation disabled, so updates never "flash"/replay.
 * The entry animation only runs on the very first paint.
 */
export function GpuChart({ options, className, style }: { options: ChartGPUOptions; className?: string; style?: React.CSSProperties }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartGPUInstance | null>(null);
  const optionsRef = useRef(options);
  const prevDataRef = useRef<Point[][] | null>(null);
  optionsRef.current = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const created = optionsRef.current;

    ChartGPU.create(container, created)
      .then((chart) => {
        if (disposed) {
          chart.dispose();
          return;
        }
        chartRef.current = chart;
        // Reconcile any props that changed during async init (without re-animating).
        if (optionsRef.current !== created) chart.setOption({ ...optionsRef.current, animation: false });
        prevDataRef.current = seriesData(optionsRef.current);
      })
      .catch((error) => console.error("ChartGPU init failed", error));

    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
      prevDataRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return; // not ready yet — the init effect applies the latest options
    const next = seriesData(options);
    const prev = prevDataRef.current;
    if (prev && streamAppend(chart, prev, next)) {
      prevDataRef.current = next;
      return;
    }
    chart.setOption({ ...options, animation: false });
    prevDataRef.current = next;
  }, [options]);

  return <div ref={containerRef} className={className} style={style} />;
}

function seriesData(options: ChartGPUOptions): Point[][] {
  return (options.series ?? []).map((series) => {
    const data = (series as { data?: unknown }).data;
    return Array.isArray(data) ? (data as Point[]) : [];
  });
}

/**
 * Returns true (and streams the appended tail via appendData) when `next` is an exact
 * prefix-extension of `prev` for every series. Returns false when a full setOption is needed.
 */
function streamAppend(chart: ChartGPUInstance, prev: Point[][], next: Point[][]): boolean {
  if (prev.length !== next.length) return false;

  const tails: Point[][] = [];
  for (let i = 0; i < next.length; i++) {
    const before = prev[i];
    const after = next[i];
    if (after.length < before.length) return false;
    for (let j = 0; j < before.length; j++) {
      if (before[j].x !== after[j].x || before[j].y !== after[j].y) return false;
    }
    tails.push(after.slice(before.length));
  }

  if (tails.every((tail) => tail.length === 0)) return true; // identical — nothing to do
  tails.forEach((tail, i) => {
    if (tail.length) chart.appendData(i, tail as DataPoint[]);
  });
  return true;
}
