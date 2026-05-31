import type { Granularity } from "../../api";

export type RangeKey = "now" | "today" | "week" | "month" | "year";

export const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "now", label: "Now" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "year", label: "This year" }
];

export const RANGE_KEYS: RangeKey[] = RANGES.map((range) => range.key);

export function rangeWindow(range: RangeKey): { from?: number; granularity: Granularity } {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  switch (range) {
    case "now":
      return { from: Date.now() - 3 * 3_600_000, granularity: "five_minute" };
    case "today":
      return { from: date.getTime(), granularity: "quarter_hour" };
    case "week":
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      return { from: date.getTime(), granularity: "hour" };
    case "month":
      date.setDate(1);
      return { from: date.getTime(), granularity: "day" };
    case "year":
      date.setMonth(0, 1);
      return { from: date.getTime(), granularity: "week" };
    default:
      return { from: undefined, granularity: "day" };
  }
}
