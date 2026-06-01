import { Card, CardBody } from "@heroui/react";
import { Activity, ArrowUpRight, Check, CircleDollarSign, Database, GitCommit, GitPullRequest, Layers, Minus, Plus, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { Filters, Granularity, Summary } from "../../api";
import { formatCurrency, formatNumber } from "../../format";
import { EmptyState } from "../EmptyState";
import { UsageCharts } from "../charts/UsageCharts";
import { useModelTimeseriesQuery, useSummaryQuery, useTimeseriesQuery } from "../queries/dashboardQueries";
import type { RangeKey } from "../state/dateRange";
import type { TabKey, ViewState } from "../state/urlState";
import { UserAvatar, userLabel } from "../UserCell";

const PALETTE = ["#2563eb", "#0f766e", "#a855f7", "#f59e0b", "#ef4444", "#14b8a6", "#6366f1", "#ec4899"];

export function HomeView({
  filters,
  range,
  chartFrom,
  granularity,
  onNavigate,
  onFilter
}: {
  filters: Filters;
  range: RangeKey;
  chartFrom?: number;
  granularity: Granularity;
  onNavigate: (tab: TabKey) => void;
  onFilter: (patch: Partial<ViewState>) => void;
}) {
  const summary = useSummaryQuery(filters);
  const timeseries = useTimeseriesQuery(filters, granularity, range === "today" || range === "now");
  const modelTimeseries = useModelTimeseriesQuery(filters, granularity, range === "today");

  const breakdowns = useMemo(
    () => ({
      models: (summary.data?.models ?? []).map((row) => ({ label: row.model, cost: row.totalCost, tokens: row.totalTokens })),
      // `label` stays the canonical identity (the filter value); `display`/`icon` give the row a
      // GitHub-login-preferred name and avatar without changing what clicking it filters on.
      users: (summary.data?.users ?? []).map((row) => ({
        label: row.user,
        cost: row.totalCost,
        tokens: row.totalTokens,
        display: userLabel(row),
        icon: <UserAvatar id={row} />
      })),
      sources: (summary.data?.sources ?? []).map((row) => ({ label: row.source, cost: row.totalCost, tokens: row.totalTokens }))
    }),
    [summary.data]
  );

  if (summary.isLoading || timeseries.isLoading) return <EmptyState>Loading telemetry...</EmptyState>;

  return (
    <div className="flex flex-col gap-4">
      <Kpis summary={summary.data} onNavigate={onNavigate} />
      <UsageCharts points={timeseries.data ?? []} modelPoints={modelTimeseries.data ?? []} from={chartFrom} granularity={granularity} />
      <div className="grid gap-4 md:grid-cols-3">
        <BreakdownCard title="Models" rows={breakdowns.models} onSelect={(label) => onFilter({ model: label })} />
        <BreakdownCard title="Users" rows={breakdowns.users} onSelect={(label) => onFilter({ user: label })} />
        <BreakdownCard title="Sources" rows={breakdowns.sources} onSelect={(label) => onFilter({ source: label })} />
      </div>
    </div>
  );
}

type KpiTone = "primary" | "success" | "danger";
type KpiItem = { label: string; value: string; icon: typeof Activity; tone?: KpiTone; to?: TabKey };

const KPI_TONES: Record<KpiTone, string> = {
  primary: "bg-primary-100 text-primary-600",
  success: "bg-success-100 text-success-600",
  danger: "bg-danger-100 text-danger-600"
};

function Kpis({ summary, onNavigate }: { summary?: Summary; onNavigate: (tab: TabKey) => void }) {
  const rows: KpiItem[][] = [
    [
      { label: "Cost", value: formatCurrency(summary?.totalCost ?? 0), icon: CircleDollarSign },
      { label: "Input tokens", value: formatNumber(summary?.inputTokens ?? 0), icon: Activity },
      { label: "Output tokens", value: formatNumber(summary?.outputTokens ?? 0), icon: Activity },
      { label: "Cache write", value: formatNumber(summary?.cacheCreationTokens ?? 0), icon: Database },
      { label: "Cache read", value: formatNumber(summary?.cacheReadTokens ?? 0), icon: Database },
      { label: "Sources", value: formatNumber(summary?.sources?.length ?? 0), icon: Layers }
    ],
    [
      { label: "Lines added", value: formatNumber(summary?.linesAdded ?? 0), icon: Plus, tone: "success" },
      { label: "Lines removed", value: formatNumber(summary?.linesRemoved ?? 0), icon: Minus, tone: "danger" },
      { label: "Edits accepted", value: formatNumber(summary?.editsAccepted ?? 0), icon: Check, tone: "success" },
      { label: "Edits rejected", value: formatNumber(summary?.editsRejected ?? 0), icon: X, tone: "danger" },
      { label: "Pull requests", value: formatNumber(summary?.pullRequests ?? 0), icon: GitPullRequest },
      { label: "Commits", value: formatNumber(summary?.commits ?? 0), icon: GitCommit }
    ]
  ];

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {row.map((item) => (
            <KpiCard key={item.label} item={item} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </div>
  );
}

function KpiCard({ item, onNavigate }: { item: KpiItem; onNavigate: (tab: TabKey) => void }) {
  const Icon = item.icon;
  const pressable = item.to !== undefined;
  return (
    <Card shadow="sm" isPressable={pressable} onPress={pressable ? () => onNavigate(item.to!) : undefined} className="w-full">
      <CardBody className="flex flex-row items-center gap-3">
        <div className={`grid h-9 w-9 flex-none place-items-center rounded-lg ${KPI_TONES[item.tone ?? "primary"]}`}>
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <span className="flex items-center gap-1 text-xs font-bold text-default-500">
            {item.label}
            {pressable && <ArrowUpRight size={12} />}
          </span>
          <strong className="mt-0.5 block truncate text-2xl text-default-900">{item.value}</strong>
        </div>
      </CardBody>
    </Card>
  );
}

function BreakdownCard({
  title,
  rows,
  onSelect
}: {
  title: string;
  rows: Array<{ label: string; cost: number; tokens: number; display?: string; icon?: ReactNode }>;
  onSelect: (label: string) => void;
}) {
  const top = useMemo(() => rows.slice(0, 8).filter((row) => row.cost > 0 || row.tokens > 0), [rows]);
  const byCost = top.some((row) => row.cost > 0);
  const max = Math.max(...top.map((row) => (byCost ? row.cost : row.tokens)), 1);

  return (
    <Card shadow="sm">
      <CardBody className="gap-3">
        <h2 className="font-display text-lg font-semibold tracking-tight text-default-900">{title}</h2>
        {top.length === 0 ? (
          <p className="text-sm text-default-500">No data</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {top.map((row, index) => {
              const value = byCost ? row.cost : row.tokens;
              return (
                <li key={row.label}>
                  <button
                    type="button"
                    onClick={() => onSelect(row.label)}
                    className="-mx-2 flex w-[calc(100%+1rem)] flex-col gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-default-100"
                  >
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2 text-default-700">
                        {row.icon}
                        <span className="truncate">{row.display ?? row.label}</span>
                      </span>
                      <span className="flex-none tabular-nums text-default-500">
                        {formatCurrency(row.cost)} · {formatNumber(row.tokens)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-default-100">
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${Math.max(3, (value / max) * 100)}%`, background: PALETTE[index % PALETTE.length] }}
                      />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
