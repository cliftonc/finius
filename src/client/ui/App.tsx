import { useDisclosure } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AuthError, getAuthToken, logout as apiLogout, type Filters } from "../api";
import { DashboardShell } from "./DashboardShell";
import { EmptyState } from "./EmptyState";
import { FiltersBar } from "./FiltersBar";
import { LoginScreen } from "./LoginScreen";
import { SetupModal } from "./SetupModal";
import { useLiveInvalidation } from "./hooks/useLiveInvalidation";
import { useHealthQuery, useMeQuery, useMetaQuery } from "./queries/dashboardQueries";
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
  const { tab, range, customFrom, customTo, source, user, model, mine, session, transcript } = state;
  const custom = useMemo<CustomRange>(
    () => ({ from: customFrom ? Number(customFrom) : undefined, to: customTo ? Number(customTo) : undefined }),
    [customFrom, customTo]
  );
  const [clock, setClock] = useState(0);
  const [authToken, setAuthToken] = useState(() => getAuthToken());

  const meta = useMetaQuery();
  const health = useHealthQuery();
  // Authentication is whatever the protected /api/meta call reports — works for both a localStorage
  // bearer token (password login) and the HttpOnly cookie (GitHub login).
  const me = useMeQuery(meta.isSuccess);
  const live = useLiveInvalidation(queryClient, authToken);

  useEffect(() => {
    const returnTo = cliReturnToUrl();
    if (!returnTo) return;
    if (authToken) {
      // Password/owner session: we hold the raw token, so hand it straight to the CLI listener.
      redirectToCli(returnTo, authToken);
      return;
    }
    // GitHub (cookie) session: the token is HttpOnly and unreadable here, so re-enter the OAuth flow
    // with the loopback return_to — the callback mints a fresh token and redirects to the listener.
    if (health.data?.secure && meta.isSuccess) {
      window.location.href = `/api/auth/github?return_to=${encodeURIComponent(returnTo)}`;
    }
  }, [authToken, health.data?.secure, meta.isSuccess]);

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
      mine: mine === "1",
      model: model || undefined,
      session: session ? Number(session) : undefined
    }),
    [queryWindow, source, user, mine, model, session]
  );

  const logout = useCallback(async () => {
    // Revoke the token + clear the (HttpOnly) cookie server-side, then reload to a clean unauth state.
    await apiLogout();
    window.location.href = "/";
  }, []);

  const loginSuccess = useCallback(() => {
    setAuthToken(getAuthToken());
    void queryClient.invalidateQueries();
  }, [queryClient]);

  if (meta.error instanceof AuthError) {
    return <LoginScreen onSuccess={loginSuccess} />;
  }

  // Secure server, auth still resolving: render nothing rather than flash the dashboard. Once /api/meta
  // resolves we either show the dashboard (authed via cookie or token) or the login screen (401 above).
  if (health.data?.secure && meta.isPending) {
    return null;
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
      me={me.data?.user ?? null}
      mine={mine === "1"}
      onToggleMine={() => update({ mine: mine === "1" ? "" : "1", user: "", session: "" })}
      onLogout={logout}
      onOpenSetup={setup.onOpen}
    >
      <FiltersBar meta={meta.data} range={range} custom={custom} source={source} user={user} model={model} mine={mine} session={session} onChange={update} />

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

function cliReturnToUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("cli_return_to");
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port ? url.toString() : null;
  } catch {
    return null;
  }
}

function redirectToCli(returnTo: string, token: string) {
  const url = new URL(returnTo);
  url.searchParams.set("token", token);
  window.location.href = url.toString();
}
