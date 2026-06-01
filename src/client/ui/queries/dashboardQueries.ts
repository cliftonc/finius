import { useQuery } from "@tanstack/react-query";
import { getAuthProviders, getHealth, getMe, getMeta, getModelTimeseries, getModels, getPeople, getSession, getSessions, getSummary, getTimeseries, getTranscriptInfo, type Filters, type Granularity } from "../../api";
import { queryKeys } from "./queryKeys";

export function useMetaQuery() {
  return useQuery({ queryKey: queryKeys.meta(), queryFn: ({ signal }) => getMeta(signal) });
}

export function useHealthQuery() {
  return useQuery({ queryKey: queryKeys.health(), queryFn: ({ signal }) => getHealth(signal), retry: false });
}

export function useAuthProvidersQuery() {
  return useQuery({ queryKey: queryKeys.authProviders(), queryFn: ({ signal }) => getAuthProviders(signal), retry: false });
}

export function useMeQuery(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.me(), queryFn: ({ signal }) => getMe(signal), enabled, retry: false });
}

export function useSummaryQuery(filters: Filters) {
  return useQuery({ queryKey: queryKeys.summary(filters), queryFn: ({ signal }) => getSummary(filters, signal) });
}

export function useTimeseriesQuery(filters: Filters, granularity: Granularity, liveRange: boolean) {
  return useQuery({
    queryKey: queryKeys.timeseries(filters, granularity),
    queryFn: ({ signal }) => getTimeseries(filters, granularity, signal),
    refetchInterval: liveRange ? 30_000 : false
  });
}

export function useModelTimeseriesQuery(filters: Filters, granularity: Granularity, liveRange: boolean) {
  return useQuery({
    queryKey: queryKeys.modelTimeseries(filters, granularity),
    queryFn: ({ signal }) => getModelTimeseries(filters, granularity, signal),
    refetchInterval: liveRange ? 30_000 : false
  });
}

export function useSessionsQuery(filters: Filters) {
  return useQuery({ queryKey: queryKeys.sessions(filters), queryFn: ({ signal }) => getSessions(filters, signal) });
}

export function usePeopleQuery(filters: Filters) {
  return useQuery({ queryKey: queryKeys.people(filters), queryFn: ({ signal }) => getPeople(filters, signal) });
}

export function useModelsQuery(filters: Filters) {
  return useQuery({ queryKey: queryKeys.models(filters), queryFn: ({ signal }) => getModels(filters, signal) });
}

export function useSessionQuery(id: number) {
  return useQuery({ queryKey: queryKeys.session(id), queryFn: ({ signal }) => getSession(id, signal) });
}

export function useTranscriptInfoQuery(id: number) {
  return useQuery({ queryKey: queryKeys.transcriptInfo(id), queryFn: ({ signal }) => getTranscriptInfo(id, signal) });
}
