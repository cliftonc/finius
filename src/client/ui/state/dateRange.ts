import type { Granularity } from "../../api";

export type RangeKey =
  | "now"
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "3m"
  | "6m"
  | "12m"
  | "wtd"
  | "mtd"
  | "qtd"
  | "ytd"
  | "custom";

// Preset buttons rendered inline, in display order.
export const PRESET_RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "now", label: "Live" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "12m", label: "12M" }
];

// "X to Date" options grouped under the XTD dropdown.
export const XTD_RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "wtd", label: "Week to Date" },
  { key: "mtd", label: "Month to Date" },
  { key: "qtd", label: "Quarter to Date" },
  { key: "ytd", label: "Year to Date" }
];

export const RANGE_KEYS: RangeKey[] = [
  "now",
  "today",
  "yesterday",
  "7d",
  "30d",
  "3m",
  "6m",
  "12m",
  "wtd",
  "mtd",
  "qtd",
  "ytd",
  "custom"
];

const DAY_MS = 86_400_000;

export type CustomRange = { from?: number; to?: number };

export type RangeWindow = { from?: number; to?: number; granularity: Granularity };

// Resolve a range key into the {from, to, granularity} window the API and charts consume. `from`/`to`
// are epoch ms; `to` is an exclusive upper bound (next-midnight) for the closed ranges. Open-ended
// ranges (now, today, the "to date" set) leave `to` undefined so they track the live edge.
export function rangeWindow(range: RangeKey, custom?: CustomRange): RangeWindow {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const startOfToday = midnight.getTime();
  switch (range) {
    case "now":
      return { from: Date.now() - 3 * 3_600_000, granularity: "five_minute" };
    case "today":
      return { from: startOfToday, granularity: "quarter_hour" };
    case "yesterday":
      return { from: startOfToday - DAY_MS, to: startOfToday, granularity: "hour" };
    case "7d":
      return { from: startOfToday - 6 * DAY_MS, granularity: "hour" };
    case "30d":
      return { from: startOfToday - 29 * DAY_MS, granularity: "day" };
    case "3m":
      return { from: monthsBack(startOfToday, 3), granularity: "day" };
    case "6m":
      return { from: monthsBack(startOfToday, 6), granularity: "week" };
    case "12m":
      return { from: monthsBack(startOfToday, 12), granularity: "week" };
    case "wtd": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      return { from: start.getTime(), granularity: "hour" };
    }
    case "mtd": {
      const start = new Date(startOfToday);
      start.setDate(1);
      return { from: start.getTime(), granularity: "day" };
    }
    case "qtd": {
      const start = new Date(startOfToday);
      start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1);
      return { from: start.getTime(), granularity: "day" };
    }
    case "ytd": {
      const start = new Date(startOfToday);
      start.setMonth(0, 1);
      return { from: start.getTime(), granularity: "week" };
    }
    case "custom": {
      if (custom?.from === undefined) return { from: undefined, granularity: "day" };
      return { from: custom.from, to: custom.to, granularity: customGranularity(custom.from, custom.to) };
    }
    default:
      return { from: undefined, granularity: "day" };
  }
}

function monthsBack(from: number, months: number): number {
  const date = new Date(from);
  date.setMonth(date.getMonth() - months);
  return date.getTime();
}

function customGranularity(from: number, to?: number): Granularity {
  const span = (to ?? Date.now()) - from;
  if (span <= 2 * DAY_MS) return "quarter_hour";
  if (span <= 14 * DAY_MS) return "hour";
  if (span <= 120 * DAY_MS) return "day";
  return "week";
}
