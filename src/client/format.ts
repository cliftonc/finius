// Shared display formatters for numbers, currency, and timestamps.
//
// Numbers are shown compactly with ~3 significant figures so large metrics stay
// scannable (2,518,482 → "2.52M", 158,224 → "158K", 29,651 → "29.7K"); small
// values render exactly (5 → "5"). Use `formatExact` when full precision matters
// (tooltips comparing raw counts). Currency rounds to cents (US$2.101 → "$2.10")
// while still showing meaningful digits for sub-cent costs. Timestamps render as
// relative time ("5 minutes ago") until they're older than 12 months, then fall
// back to an absolute date.

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumSignificantDigits: 3
});

const exactNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const subCentCurrency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 2
});

const compactCurrency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumSignificantDigits: 3
});

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const absoluteDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

// Compact, ~3 significant figures. 2,518,482 → "2.52M", 29,651 → "29.7K", 158 → "158".
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return compactNumber.format(value);
}

// Full integer with grouping separators — for tooltips/contexts needing exact counts.
export function formatExact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return exactNumber.format(value);
}

// Currency rounded to cents (US$2.101 → "$2.10"); sub-cent nonzero costs keep precision.
export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return subCentCurrency.format(value);
  return currency.format(value);
}

// Compact currency for chart axes/badges. 2,518 → "$2.52K".
export function formatCurrencyCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return compactCurrency.format(value);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1]
];

// "5 minutes ago" for recent times; absolute date once older than ~12 months.
export function formatRelativeTime(input: number | Date, now: number = Date.now()): string {
  const ts = input instanceof Date ? input.getTime() : input;
  if (!Number.isFinite(ts)) return "—";
  const diffMs = ts - now; // negative for past
  const absSec = Math.abs(diffMs) / 1000;
  if (absSec / 86_400 > 365) return absoluteDate.format(new Date(ts));
  for (const [unit, secs] of UNITS) {
    if (absSec >= secs || unit === "second") {
      return relativeTime.format(Math.round(diffMs / 1000 / secs), unit);
    }
  }
  return relativeTime.format(0, "second");
}
