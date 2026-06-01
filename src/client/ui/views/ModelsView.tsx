import type { Filters } from "../../api";
import { EmptyState } from "../EmptyState";
import { useModelsQuery } from "../queries/dashboardQueries";
import { ModelsTable } from "../tables/ModelsTable";

export function ModelsView({ filters, onOpen }: { filters: Filters; onOpen: (model: string) => void }) {
  const models = useModelsQuery(filters);
  if (models.isLoading) return <EmptyState>Loading models...</EmptyState>;
  return <ModelsTable models={models.data ?? []} onOpen={onOpen} />;
}
