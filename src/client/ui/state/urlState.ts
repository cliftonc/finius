import { useCallback, useEffect, useState } from "react";
import { RANGE_KEYS, type RangeKey } from "./dateRange";

export type TabKey = "home" | "sessions" | "people" | "models";

export const TAB_KEYS: TabKey[] = ["home", "sessions", "people", "models"];
export type ViewState = {
  tab: TabKey;
  range: RangeKey;
  customFrom: string;
  customTo: string;
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
    range: RANGE_KEYS.includes(range as RangeKey) ? (range as RangeKey) : "today",
    customFrom: p.get("from") ?? "",
    customTo: p.get("to") ?? "",
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
  if (state.range !== "today") p.set("range", state.range);
  if (state.range === "custom" && state.customFrom) p.set("from", state.customFrom);
  if (state.range === "custom" && state.customTo) p.set("to", state.customTo);
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
export function useUrlState() {
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
