import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { dashboardQueryKeyPrefixes } from "../queries/queryKeys";

function invalidateDashboardQueries(queryClient: QueryClient) {
  for (const queryKey of dashboardQueryKeyPrefixes) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

export function useLiveInvalidation(queryClient: QueryClient, authToken: string) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    const baseUrl = window.location.port === "5173" ? "http://127.0.0.1:8787/events" : "/events";
    const eventUrl = authToken ? baseUrl + "?token=" + encodeURIComponent(authToken) : baseUrl;
    const stream = new EventSource(eventUrl);
    stream.onopen = () => setLive(true);
    stream.addEventListener("ready", () => setLive(true));
    stream.addEventListener("ingest", () => {
      invalidateDashboardQueries(queryClient);
    });
    stream.onerror = () => setLive(false);
    return () => stream.close();
  }, [queryClient, authToken]);

  return live;
}
