# Refactor: Split Dashboard App

## Problem

`src/client/ui/App.tsx` still contains most of the dashboard: URL state, live event wiring, app shell, filters, setup modal, home view, sessions table, people table, models table, chart composition, badges, and small formatting helpers.

The file is coherent, but at roughly 1,000 lines it is becoming hard to scan and extend. Some low-risk pieces are already extracted (`LoginScreen`, chart data/options helpers, date range helpers, `TranscriptView`, timeline components, `UserCell`, provider logos), so future work should continue that pattern.

## Why It Matters

Most future UI changes will touch this file, increasing merge conflicts and making local reasoning harder. Query behavior, URL state, view state, and display components are also mixed together, which makes it harder to reason about caching and live updates independently from markup.

## Pragmatic Split

Suggested target structure:

```text
src/client/ui/
  App.tsx
  DashboardShell.tsx
  FiltersBar.tsx
  SetupModal.tsx
  LoginScreen.tsx
  queries/
    dashboardQueries.ts
    queryKeys.ts
  hooks/
    useLiveInvalidation.ts
  views/
    HomeView.tsx
    SessionsView.tsx
    PeopleView.tsx
    ModelsView.tsx
  charts/
    UsageCharts.tsx
    chartOptions.ts
    chartData.ts
  sessions/
    SourceBadges.tsx
    SessionFilterChip.tsx
  tables/
    SessionsTable.tsx
    PeopleTable.tsx
    ModelsTable.tsx
  state/
    urlState.ts
    dateRange.ts
  utils/
    compact.ts
```

## Suggested Order

Extract behavior-preserving pieces first:

1. Move `ViewState`, `readState`, `writeState`, and `useUrlState` into `state/urlState.ts`.
2. Move the EventSource setup and dashboard-only invalidation into `hooks/useLiveInvalidation.ts`.
3. Move query keys and query hooks into `queries/queryKeys.ts` and `queries/dashboardQueries.ts`.
4. Move shell-only UI (`DashboardShell`, `FiltersBar`, `SetupModal`) without changing props or behavior.
5. Move views (`HomeView`, `SessionsView`, `PeopleView`, `ModelsView`) after query hooks exist.
6. Move presentational leaf components (`UsageCharts`, tables, session badges, `SessionFilterChip`, `compact`).

Keep each PR mechanical and behavior-preserving where possible. The safest target is for `App.tsx` to own only top-level routing between the dashboard and transcript view, while the dashboard shell owns layout and the views own their data rendering.

## Query Boundaries

The data layer should keep these rules:

- Query keys live in one place and are reused by hooks and invalidation.
- SSE `ingest` events invalidate dashboard data only, not static health checks or raw transcript content.
- The live `now` chart window can tick independently from the API query key so charts move without creating a new cache entry every few seconds.
- Query functions should pass TanStack Query's `AbortSignal` through to `fetch`.
