import {
  Button,
  Card,
  CardBody,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Select,
  SelectItem,
  Snippet,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Tabs,
  useDisclosure
} from "@heroui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChartGPUOptions } from "chartgpu";
import { Activity, ArrowUpRight, Check, CircleDollarSign, Database, FileText, GitCommit, GitPullRequest, Layers, Minus, Moon, Plus, Radio, RefreshCcw, Settings, Sun, Users, X } from "lucide-react";
import { lazy, Suspense, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { AuthError, getHealth, getMeta, getModels, getModelTimeseries, getPeople, getSession, getSessions, getSummary, getTimeseries, getTranscriptInfo } from "../api";
import type { Filters, Granularity, ModelSummary, ModelTimeseriesPoint, PersonSummary, SessionSummary, Summary, TimeseriesPoint } from "../api";
import { formatCurrency, formatCurrencyCompact, formatExact, formatNumber, formatRelativeTime } from "../format";
import { UserAvatar, UserCell, userLabel } from "./UserCell";
import { useTheme } from "../theme";
import { GpuChart } from "./GpuChart";
import { PROVIDER_COLOR, PROVIDER_LABEL, ProviderLogo, providerForSource, type Provider } from "./ProviderLogo";
import { FiniusLogo } from "./FiniusLogo";
import { LoginScreen } from "./LoginScreen";
import { RANGES, RANGE_KEYS, rangeWindow, type RangeKey } from "./state/dateRange";
import { densify, modelSeries } from "./charts/chartData";
import { granularityLabel, lineOptions, multiSeriesLineOptions, seriesLineOptions } from "./charts/chartOptions";

type TabKey = "home" | "sessions" | "people" | "models";

const ALL = "__all__";

const TAB_KEYS: TabKey[] = ["home", "sessions", "people", "models"];
const TranscriptView = lazy(() => import("./TranscriptView").then((module) => ({ default: module.TranscriptView })));

type ViewState = {
  tab: TabKey;
  range: RangeKey;
  source: string;
  user: string;
  model: string;
  session: string;
  transcript: string;
};

function readState(): ViewState {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get("tab");
  const range = p.get("range");
  return {
    tab: TAB_KEYS.includes(tab as TabKey) ? (tab as TabKey) : "home",
    range: RANGE_KEYS.includes(range as RangeKey) ? (range as RangeKey) : "now",
    source: p.get("source") ?? "",
    user: p.get("user") ?? "",
    model: p.get("model") ?? "",
    session: p.get("session") ?? "",
    transcript: p.get("transcript") ?? ""
  };
}

function writeState(state: ViewState) {
  const p = new URLSearchParams();
  if (state.tab !== "home") p.set("tab", state.tab);
  if (state.range !== "now") p.set("range", state.range);
  if (state.source) p.set("source", state.source);
  if (state.user) p.set("user", state.user);
  if (state.model) p.set("model", state.model);
  if (state.session) p.set("session", state.session);
  if (state.transcript) p.set("transcript", state.transcript);
  const qs = p.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}

// Single source of truth for view + filter state, mirrored into the URL query string so links are
// shareable and back/forward navigates between drill-downs.
function useUrlState() {
  const [state, setState] = useState<ViewState>(readState);
  useEffect(() => {
    const onPop = () => setState(readState());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const update = useCallback((patch: Partial<ViewState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      writeState(next);
      return next;
    });
  }, []);
  return [state, update] as const;
}

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

const PALETTE = ["#2563eb", "#0f766e", "#a855f7", "#f59e0b", "#ef4444", "#14b8a6", "#6366f1", "#ec4899"];

export function App() {
  const queryClient = useQueryClient();
  const setup = useDisclosure();
  const [live, setLive] = useState(false);
  const [state, update] = useUrlState();
  const { tab, range, source, user, model, session, transcript } = state;
  const [clock, setClock] = useState(0);

  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, retry: false });

  // Advance a clock for the live "Now" range so its rolling 3h window (and query key) moves
  // forward in real time even when no new telemetry arrives.
  useEffect(() => {
    if (range !== "now") return;
    const id = window.setInterval(() => setClock((value) => value + 1), 10_000);
    return () => window.clearInterval(id);
  }, [range]);

  const filters = useMemo<Filters>(
    () => ({
      from: rangeWindow(range).from,
      source: source || undefined,
      user: user || undefined,
      model: model || undefined,
      session: session ? Number(session) : undefined
    }),
    // clock intentionally re-derives `from` for live ranges
    [range, source, user, model, session, clock]
  );

  useEffect(() => {
    const eventUrl = window.location.port === "5173" ? "http://127.0.0.1:8787/events" : "/events";
    const stream = new EventSource(eventUrl);
    stream.onopen = () => setLive(true);
    stream.addEventListener("ready", () => setLive(true));
    stream.addEventListener("ingest", () => {
      void queryClient.invalidateQueries();
    });
    stream.onerror = () => setLive(false);
    return () => stream.close();
  }, [queryClient]);

  // Secure Mode: any 401 surfaces as an AuthError on the always-running `meta` query. Show the login
  // screen until a successful login sets the finius_auth cookie, then refetch everything.
  if (meta.error instanceof AuthError) {
    return <LoginScreen onSuccess={() => void queryClient.invalidateQueries()} />;
  }

  if (transcript) {
    return (
      <main className="mx-auto w-full max-w-[1440px] p-7 text-foreground">
        <Suspense fallback={<EmptyState>Loading transcript...</EmptyState>}>
          <TranscriptView id={Number(transcript)} onBack={() => update({ transcript: "" })} />
        </Suspense>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1440px] p-7 text-foreground">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-3">
            <FiniusLogo size={44} />
            <h1 className="font-display text-5xl font-semibold leading-none tracking-tight text-default-900">Finius</h1>
          </div>
          <Tabs aria-label="Views" color="primary" radius="full" selectedKey={tab} onSelectionChange={(key) => update({ tab: key as TabKey })}>
            <Tab key="home" title="Home" />
            <Tab key="sessions" title="Sessions" />
            <Tab key="people" title="People" />
            <Tab key="models" title="Models" />
          </Tabs>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Button isIconOnly radius="full" variant="bordered" aria-label="Telemetry setup" onPress={setup.onOpen}>
            <Settings size={18} />
          </Button>
          <Chip color={live ? "success" : "default"} variant={live ? "flat" : "bordered"} startContent={<Radio size={14} className="ml-1" />}>
            {live ? "Live" : "Connecting"}
          </Chip>
        </div>
      </header>

      <Card className="mb-4" shadow="sm">
        <CardBody className="flex flex-row flex-wrap items-end gap-5">
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.7rem] font-extrabold uppercase tracking-wide text-default-500">Time range</span>
            <Tabs aria-label="Time range" size="sm" radius="full" selectedKey={range} onSelectionChange={(key) => update({ range: key as RangeKey })}>
              {RANGES.map((item) => (
                <Tab key={item.key} title={item.label} />
              ))}
            </Tabs>
          </div>
          <Select
            label="Source"
            labelPlacement="outside"
            size="sm"
            className="max-w-[220px]"
            selectedKeys={[source || ALL]}
            onSelectionChange={(keys) => update({ source: pickKey(keys) })}
          >
            {[{ key: ALL, label: "All sources" }, ...(meta.data?.sources ?? []).map((value) => ({ key: value, label: value }))].map((item) => (
              <SelectItem key={item.key}>{item.label}</SelectItem>
            ))}
          </Select>
          <Select
            label="User"
            labelPlacement="outside"
            size="sm"
            className="max-w-[260px]"
            selectedKeys={[user || ALL]}
            onSelectionChange={(keys) => update({ user: pickKey(keys) })}
          >
            {[{ key: ALL, label: "All users" }, ...(meta.data?.users ?? []).map((value) => ({ key: value, label: value }))].map((item) => (
              <SelectItem key={item.key}>{item.label}</SelectItem>
            ))}
          </Select>
          <Select
            label="Model"
            labelPlacement="outside"
            size="sm"
            className="max-w-[240px]"
            selectedKeys={[model || ALL]}
            onSelectionChange={(keys) => update({ model: pickKey(keys) })}
          >
            {[{ key: ALL, label: "All models" }, ...(meta.data?.models ?? []).map((value) => ({ key: value, label: value }))].map((item) => (
              <SelectItem key={item.key}>{item.label}</SelectItem>
            ))}
          </Select>
          {session && (
            <SessionFilterChip
              id={Number(session)}
              onClear={() => update({ session: "" })}
              onView={() => update({ transcript: session })}
            />
          )}
        </CardBody>
      </Card>

      {tab === "home" && <HomeView filters={filters} range={range} onNavigate={(next) => update({ tab: next })} onFilter={update} />}
      {tab === "sessions" && (
        <SessionsView
          filters={filters}
          onOpen={(id) => update({ session: String(id), tab: "home" })}
          onViewTranscript={(id) => update({ transcript: String(id) })}
        />
      )}
      {tab === "people" && <PeopleView filters={filters} onOpen={(value) => update({ user: value, tab: "home" })} />}
      {tab === "models" && <ModelsView filters={filters} onOpen={(value) => update({ model: value, tab: "home" })} />}

      <Modal isOpen={setup.isOpen} onOpenChange={setup.onOpenChange} size="2xl">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            Send Claude Code telemetry here
            <span className="text-sm font-normal text-default-500">Run this in the shell where you launch Claude Code, then start a session.</span>
          </ModalHeader>
          <ModalBody className="pb-6">
            <Snippet hideSymbol variant="bordered" className="w-full" classNames={{ pre: "whitespace-pre-wrap" }}>
              {setupScript(health.data?.secure ?? false).map((line, index) => (
                <span key={index}>{line}</span>
              ))}
            </Snippet>
          </ModalBody>
        </ModalContent>
      </Modal>
    </main>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <Button
      isIconOnly
      radius="full"
      variant="bordered"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onPress={toggle}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </Button>
  );
}

function HomeView({
  filters,
  range,
  onNavigate,
  onFilter
}: {
  filters: Filters;
  range: RangeKey;
  onNavigate: (tab: TabKey) => void;
  onFilter: (patch: Partial<ViewState>) => void;
}) {
  const { from, granularity } = rangeWindow(range);
  const summary = useQuery({ queryKey: ["summary", filters], queryFn: () => getSummary(filters) });
  const timeseries = useQuery({
    queryKey: ["timeseries", filters, granularity],
    queryFn: () => getTimeseries(filters, granularity),
    refetchInterval: range === "today" ? 30_000 : false
  });
  const modelTimeseries = useQuery({
    queryKey: ["model-timeseries", filters, granularity],
    queryFn: () => getModelTimeseries(filters, granularity),
    refetchInterval: range === "today" ? 30_000 : false
  });

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
      <UsageCharts points={timeseries.data ?? []} modelPoints={modelTimeseries.data ?? []} from={from} granularity={granularity} />
      <div className="grid gap-4 md:grid-cols-3">
        <BreakdownCard title="Models" rows={breakdowns.models} onSelect={(label) => onFilter({ model: label })} />
        <BreakdownCard title="Users" rows={breakdowns.users} onSelect={(label) => onFilter({ user: label })} />
        <BreakdownCard title="Sources" rows={breakdowns.sources} onSelect={(label) => onFilter({ source: label })} />
      </div>
    </div>
  );
}

function SessionsView({
  filters,
  onOpen,
  onViewTranscript
}: {
  filters: Filters;
  onOpen: (id: number) => void;
  onViewTranscript: (id: number) => void;
}) {
  const sessions = useQuery({ queryKey: ["sessions", filters], queryFn: () => getSessions(filters) });
  if (sessions.isLoading) return <EmptyState>Loading sessions...</EmptyState>;
  return <SessionsTable sessions={sessions.data ?? []} onOpen={onOpen} onViewTranscript={onViewTranscript} />;
}

function PeopleView({ filters, onOpen }: { filters: Filters; onOpen: (user: string) => void }) {
  const people = useQuery({ queryKey: ["people", filters], queryFn: () => getPeople(filters) });
  if (people.isLoading) return <EmptyState>Loading people...</EmptyState>;
  return <PeopleTable people={people.data ?? []} onOpen={onOpen} />;
}

function ModelsView({ filters, onOpen }: { filters: Filters; onOpen: (model: string) => void }) {
  const models = useQuery({ queryKey: ["models", filters], queryFn: () => getModels(filters) });
  if (models.isLoading) return <EmptyState>Loading models...</EmptyState>;
  return <ModelsTable models={models.data ?? []} onOpen={onOpen} />;
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

function UsageCharts({
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

// One badge per signal a session carries (OTEL and/or JSONL). Color identifies the provider (Claude
// today, Codex etc. later) — every signal from one provider shares it — so only the OTEL/JSONL label
// distinguishes them.
function SignalBadge({ kind, active, provider = "claude" }: { kind: "otel" | "jsonl"; active: boolean; provider?: Provider }) {
  const label = kind === "otel" ? "OTEL" : "JSONL";
  const color = PROVIDER_COLOR[provider];
  const title = active ? `${label} · shown` : `${label} · present, not shown (OTel wins)`;
  return (
    <span
      title={`${PROVIDER_LABEL[provider]} · ${title}`}
      style={{ backgroundColor: `${color}33`, color }}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
    >
      <ProviderLogo provider={provider} size={11} />
      {label}
    </span>
  );
}

function SourceBadges({
  hasOtel,
  hasJsonl,
  metricSource,
  source
}: {
  hasOtel: boolean;
  hasJsonl: boolean;
  metricSource: "otel" | "jsonl";
  source: string;
}) {
  const provider = providerForSource(source);
  return (
    <span className="inline-flex items-center gap-1">
      {hasOtel && <SignalBadge kind="otel" active={metricSource === "otel"} provider={provider} />}
      {hasJsonl && <SignalBadge kind="jsonl" active={metricSource === "jsonl"} provider={provider} />}
    </span>
  );
}

// When a session carries both OTel and a transcript, the two ingest paths usually disagree (OTel
// commonly misses requests the transcript captured). Show JSONL's signed delta vs OTel so the gap is
// visible at a glance; hidden when either signal is absent (nothing to compare).
function TokenDiffBadge({ otel, jsonl }: { otel: number; jsonl: number }) {
  if (otel <= 0 || jsonl <= 0) return null;
  const delta = jsonl - otel;
  if (delta === 0) return null;
  const pct = Math.round((delta / otel) * 100);
  const sign = delta > 0 ? "+" : "−";
  const tone = Math.abs(pct) >= 25 ? "bg-warning/10 text-warning-600" : "bg-default-100 text-default-500";
  return (
    <span
      title={`JSONL ${formatExact(jsonl)} vs OTEL ${formatExact(otel)} tokens (${sign}${formatExact(Math.abs(delta))}, ${sign}${Math.abs(pct)}%)`}
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${tone}`}
    >
      {sign}
      {formatNumber(Math.abs(delta))}
    </span>
  );
}

// Same idea as TokenDiffBadge for cost: OTel reports cost directly while JSONL cost is synthesized from
// pricing, so the two can diverge. Show JSONL's signed delta vs OTel; hidden when either signal lacks a
// cost figure (nothing to compare).
function CostDiffBadge({ otel, jsonl }: { otel: number; jsonl: number }) {
  if (otel <= 0 || jsonl <= 0) return null;
  const delta = jsonl - otel;
  if (delta === 0) return null;
  const pct = Math.round((delta / otel) * 100);
  const sign = delta > 0 ? "+" : "−";
  const tone = Math.abs(pct) >= 25 ? "bg-warning/10 text-warning-600" : "bg-default-100 text-default-500";
  return (
    <span
      title={`JSONL ${formatCurrency(jsonl)} vs OTEL ${formatCurrency(otel)} (${sign}${formatCurrency(Math.abs(delta))}, ${sign}${Math.abs(pct)}%)`}
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${tone}`}
    >
      {sign}
      {formatCurrency(Math.abs(delta))}
    </span>
  );
}

function SessionsTable({
  sessions,
  onOpen,
  onViewTranscript
}: {
  sessions: SessionSummary[];
  onOpen: (id: number) => void;
  onViewTranscript: (id: number) => void;
}) {
  return (
    <Card shadow="sm">
      <CardBody className="gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">Recent sessions</h2>
          <span className="text-sm text-default-500">{sessions.length} shown · click to drill in</span>
        </div>
        <Table aria-label="Recent sessions" removeWrapper selectionMode="none" onRowAction={(key) => onOpen(Number(key))}>
          <TableHeader>
            <TableColumn>SESSION</TableColumn>
            <TableColumn>USER</TableColumn>
            <TableColumn>SOURCE</TableColumn>
            <TableColumn>MODEL</TableColumn>
            <TableColumn>TOKENS</TableColumn>
            <TableColumn>COST</TableColumn>
            <TableColumn>LAST SEEN</TableColumn>
            <TableColumn>TRANSCRIPT</TableColumn>
          </TableHeader>
          <TableBody emptyContent="No sessions yet" items={sessions}>
            {(session) => (
              <TableRow key={session.id} className="cursor-pointer transition-colors hover:bg-default-100">
                <TableCell>{compact(session.sessionId)}</TableCell>
                <TableCell>
                  <UserCell
                    id={{
                      user: session.userEmail ?? session.userAccountId ?? session.userId,
                      email: session.userEmail,
                      displayName: session.displayName,
                      githubLogin: session.githubLogin
                    }}
                  />
                </TableCell>
                <TableCell>
                  <SourceBadges hasOtel={session.hasOtel} hasJsonl={session.hasJsonl} metricSource={session.metricSource} source={session.source} />
                </TableCell>
                <TableCell>{session.models.join(", ") || "unknown"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span>{formatNumber(session.totalTokens)}</span>
                    <TokenDiffBadge otel={session.otelTotalTokens} jsonl={session.jsonlTotalTokens} />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span>{formatCurrency(session.totalCost)}</span>
                    <CostDiffBadge otel={session.otelTotalCost} jsonl={session.jsonlTotalCost} />
                  </div>
                </TableCell>
                <TableCell title={new Date(session.lastSeenAt).toLocaleString()}>{formatRelativeTime(session.lastSeenAt)}</TableCell>
                <TableCell>
                  {session.hasTranscript ? (
                    <button
                      type="button"
                      aria-label="View transcript"
                      title="View transcript"
                      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        onViewTranscript(session.id);
                      }}
                    >
                      <FileText size={14} /> View
                    </button>
                  ) : (
                    <span className="text-xs text-default-400">—</span>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}

function PeopleTable({ people, onOpen }: { people: PersonSummary[]; onOpen: (user: string) => void }) {
  return (
    <Card shadow="sm">
      <CardBody className="gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">People</h2>
          <span className="text-sm text-default-500">{people.length} senders · click to drill in</span>
        </div>
        <Table aria-label="People" removeWrapper selectionMode="none" onRowAction={(key) => onOpen(String(key))}>
          <TableHeader>
            <TableColumn>SENDER</TableColumn>
            <TableColumn>SESSIONS</TableColumn>
            <TableColumn>MODELS</TableColumn>
            <TableColumn>TOKENS</TableColumn>
            <TableColumn>COST</TableColumn>
            <TableColumn>LAST SEEN</TableColumn>
          </TableHeader>
          <TableBody emptyContent="No senders yet" items={people}>
            {(person) => (
              <TableRow key={person.user} className="cursor-pointer transition-colors hover:bg-default-100">
                <TableCell>
                  <UserCell id={person} />
                </TableCell>
                <TableCell>{formatNumber(person.sessions)}</TableCell>
                <TableCell>{person.models.join(", ") || "unknown"}</TableCell>
                <TableCell>{formatNumber(person.totalTokens)}</TableCell>
                <TableCell>{formatCurrency(person.totalCost)}</TableCell>
                <TableCell title={new Date(person.lastSeenAt).toLocaleString()}>{formatRelativeTime(person.lastSeenAt)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}

function ModelsTable({ models, onOpen }: { models: ModelSummary[]; onOpen: (model: string) => void }) {
  return (
    <Card shadow="sm">
      <CardBody className="gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold tracking-tight text-default-900">Models</h2>
          <span className="text-sm text-default-500">{models.length} models · click to drill in</span>
        </div>
        <Table aria-label="Models" removeWrapper selectionMode="none" onRowAction={(key) => onOpen(String(key))}>
          <TableHeader>
            <TableColumn>MODEL</TableColumn>
            <TableColumn>SESSIONS</TableColumn>
            <TableColumn>USERS</TableColumn>
            <TableColumn>TOKENS</TableColumn>
            <TableColumn>COST</TableColumn>
            <TableColumn>LAST SEEN</TableColumn>
          </TableHeader>
          <TableBody emptyContent="No models yet" items={models}>
            {(model) => (
              <TableRow key={model.model} className="cursor-pointer transition-colors hover:bg-default-100">
                <TableCell>{model.model}</TableCell>
                <TableCell>{formatNumber(model.sessions)}</TableCell>
                <TableCell>{formatNumber(model.users)}</TableCell>
                <TableCell>{formatNumber(model.totalTokens)}</TableCell>
                <TableCell>{formatCurrency(model.totalCost)}</TableCell>
                <TableCell title={new Date(model.lastSeenAt).toLocaleString()}>{formatRelativeTime(model.lastSeenAt)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardBody>
    </Card>
  );
}

// Sessions are unbounded, so the active session drill-down is shown as a removable chip rather than a
// dropdown. Resolves the numeric id to a friendly "shortId · user" label via the session detail route.
function SessionFilterChip({ id, onClear, onView }: { id: number; onClear: () => void; onView: () => void }) {
  const session = useQuery({ queryKey: ["session", id], queryFn: () => getSession(id) });
  const transcript = useQuery({ queryKey: ["transcript-info", id], queryFn: () => getTranscriptInfo(id) });
  const data = session.data;
  const label = data
    ? `${compact(data.sessionId)} · ${userLabel({ user: data.userEmail ?? data.userAccountId ?? data.userId, email: data.userEmail, displayName: data.displayName, githubLogin: data.githubLogin })}`
    : `Session #${id}`;
  return (
    <div className="flex items-center gap-2 self-end">
      <Chip variant="flat" color="primary" startContent={<RefreshCcw size={14} className="ml-1" />} onClose={onClear}>
        {label}
      </Chip>
      {data && <SourceBadges hasOtel={data.hasOtel} hasJsonl={data.hasJsonl} metricSource={data.metricSource} source={data.source} />}
      {transcript.data && (
        <button type="button" onClick={onView} className="text-sm text-primary hover:underline">
          View transcript
        </button>
      )}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[220px] place-items-center rounded-lg border border-dashed border-default-300 text-default-500">{children}</div>;
}

function pickKey(keys: "all" | Set<React.Key>): string {
  if (keys === "all") return "";
  const value = Array.from(keys)[0] as string | undefined;
  return value && value !== ALL ? value : "";
}

function setupScript(secure: boolean): string[] {
  const origin = window.location.origin;
  return [
    "# Recommended: let the CLI configure server URL, auth, and shell hooks.",
    "finius setup",
    "",
    "# Manual open-mode launch for Claude Code telemetry:",
    "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
    "export OTEL_METRICS_EXPORTER=otlp",
    "export OTEL_LOGS_EXPORTER=otlp",
    "export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json",
    "export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json",
    `export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=${origin}/otlp/v1/metrics`,
    `export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${origin}/otlp/v1/logs`,
    "export OTEL_METRIC_EXPORT_INTERVAL=5000",
    "export OTEL_LOGS_EXPORT_INTERVAL=2000",
    ...(secure ? ["", "# Secure Mode requires CLI-managed setup so telemetry gets an auth token."] : []),
    "claude"
  ];
}

function compact(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}
