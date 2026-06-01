import type { Filters } from "../../api";
import { EmptyState } from "../EmptyState";
import { usePeopleQuery } from "../queries/dashboardQueries";
import { PeopleTable } from "../tables/PeopleTable";

export function PeopleView({ filters, onOpen }: { filters: Filters; onOpen: (user: string) => void }) {
  const people = usePeopleQuery(filters);
  if (people.isLoading) return <EmptyState>Loading people...</EmptyState>;
  return <PeopleTable people={people.data ?? []} onOpen={onOpen} />;
}
