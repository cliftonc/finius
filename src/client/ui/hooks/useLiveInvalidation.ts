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
    // Always same-origin: in dev this rides the Vite proxy (`/events` → :8787), so the browser sends
    // the finius_auth cookie (GitHub login). Password logins have no cookie, so pass the bearer token
    // as a query param — EventSource can't set an Authorization header.
    const eventUrl = authToken ? "/events?token=" + encodeURIComponent(authToken) : "/events";
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
