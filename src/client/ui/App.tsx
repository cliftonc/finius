import { useDisclosure } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AuthError, clearAuthToken, getAuthToken, type Filters } from "../api";
import { DashboardShell } from "./DashboardShell";
import { EmptyState } from "./EmptyState";
import { FiltersBar } from "./FiltersBar";
import { LoginScreen } from "./LoginScreen";
import { SetupModal } from "./SetupModal";
import { useLiveInvalidation } from "./hooks/useLiveInvalidation";
import { useHealthQuery, useMetaQuery } from "./queries/dashboardQueries";
import { rangeWindow, type CustomRange } from "./state/dateRange";
import { useUrlState, type TabKey } from "./state/urlState";
import { HomeView } from "./views/HomeView";
import { ModelsView } from "./views/ModelsView";
import { PeopleView } from "./views/PeopleView";
import { SessionsView } from "./views/SessionsView";

const TranscriptView = lazy(() => import("./TranscriptView").then((module) => ({ default: module.TranscriptView })));

export function App() {
  const queryClient = useQueryClient();
  const setup = useDisclosure();
  const [state, update] = useUrlState();
  const { tab, range, customFrom, customTo, source, user, model, session, transcript } = state;
  const custom = useMemo<CustomRange>(
    () => ({ from: customFrom ? Number(customFrom) : undefined, to: customTo ? Number(customTo) : undefined }),
    [customFrom, customTo]
  );
  const [clock, setClock] = useState(0);
  const [authToken, setAuthToken] = useState(() => getAuthToken());

  const meta = useMetaQuery();
  const health = useHealthQuery();
  const live = useLiveInvalidation(queryClient, authToken);

  useEffect(() => {
    if (range !== "now") return;
    const id = window.setInterval(() => setClock((value) => value + 1), 10_000);
    return () => window.clearInterval(id);
  }, [range]);

  const queryWindow = useMemo(() => rangeWindow(range, custom), [range, custom]);
  const chartWindow = useMemo(() => {
    void clock;
    return rangeWindow(range, custom);
  }, [range, custom, clock]);
  const filters = useMemo<Filters>(
    () => ({
      from: queryWindow.from,
      to: queryWindow.to,
      source: source || undefined,
      user: user || undefined,
      model: model || undefined,
      session: session ? Number(session) : undefined
    }),
    [queryWindow, source, user, model, session]
  );

  const logout = useCallback(() => {
    clearAuthToken();
    setAuthToken(getAuthToken());
    void queryClient.invalidateQueries();
  }, [queryClient]);

  const loginSuccess = useCallback(() => {
    setAuthToken(getAuthToken());
    void queryClient.invalidateQueries();
  }, [queryClient]);

  if (meta.error instanceof AuthError) {
    return <LoginScreen onSuccess={loginSuccess} />;
  }

  if (transcript) {
    return (
      <main className="mx-auto w-full max-w-[1440px] px-3 py-3 text-foreground">
        <Suspense fallback={<EmptyState>Loading transcript...</EmptyState>}>
          <TranscriptView id={Number(transcript)} onBack={() => update({ transcript: "" })} />
        </Suspense>
      </main>
    );
  }

  return (
    <DashboardShell
      tab={tab}
      live={live}
      secure={health.data?.secure}
      onTabChange={(next: TabKey) => update({ tab: next })}
      onLogout={logout}
      onOpenSetup={setup.onOpen}
    >
      <FiltersBar meta={meta.data} range={range} custom={custom} source={source} user={user} model={model} session={session} onChange={update} />

      {tab === "home" && (
        <HomeView
          filters={filters}
          range={range}
          chartFrom={chartWindow.from}
          granularity={chartWindow.granularity}
          onNavigate={(next) => update({ tab: next })}
          onFilter={update}
        />
      )}
      {tab === "sessions" && (
        <SessionsView
          filters={filters}
          onOpen={(id) => update({ session: String(id), tab: "home" })}
          onViewTranscript={(id) => update({ transcript: String(id) })}
        />
      )}
      {tab === "people" && <PeopleView filters={filters} onOpen={(value) => update({ user: value, tab: "home" })} />}
      {tab === "models" && <ModelsView filters={filters} onOpen={(value) => update({ model: value, tab: "home" })} />}

      <SetupModal isOpen={setup.isOpen} onOpenChange={setup.onOpenChange} secure={health.data?.secure} />
    </DashboardShell>
  );
}
