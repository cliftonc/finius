import type { Filters } from "../../api";
import { EmptyState } from "../EmptyState";
import { useSessionsQuery } from "../queries/dashboardQueries";
import { SessionsTable } from "../tables/SessionsTable";

export function SessionsView({
  filters,
  onOpen,
  onViewTranscript
}: {
  filters: Filters;
  onOpen: (id: number) => void;
  onViewTranscript: (id: number) => void;
}) {
  const sessions = useSessionsQuery(filters);
  if (sessions.isLoading) return <EmptyState>Loading sessions...</EmptyState>;
  return <SessionsTable sessions={sessions.data ?? []} onOpen={onOpen} onViewTranscript={onViewTranscript} />;
}
