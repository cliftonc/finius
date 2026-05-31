# Refactor: Split Dashboard App

## Problem

`src/client/ui/App.tsx` contains most of the dashboard: URL state, auth screen, layout, filters, home view, sessions table, people table, models table, chart setup, chart data shaping, and small formatting helpers.

The file is coherent, but at more than 1,200 lines it is becoming hard to scan and extend.

## Why It Matters

Most future UI changes will touch this file, increasing merge conflicts and making local reasoning harder. The project already has good extraction points (`TranscriptView`, timeline components, `UserCell`, provider logos), so continuing that pattern will keep the dashboard manageable.

## Pragmatic Split

Suggested target structure:

```text
src/client/ui/
  App.tsx
  DashboardShell.tsx
  FiltersBar.tsx
  LoginScreen.tsx
  views/
    HomeView.tsx
    SessionsView.tsx
    PeopleView.tsx
    ModelsView.tsx
  charts/
    UsageCharts.tsx
    chartOptions.ts
    chartData.ts
  state/
    urlState.ts
    dateRange.ts
```

## Suggested First Step

Extract low-risk pure pieces first:

1. Move range and granularity helpers to `state/dateRange.ts`.
2. Move chart option builders and densify/model-series helpers to `charts/chartOptions.ts` and `charts/chartData.ts`.
3. Move `LoginScreen` and `FiltersBar` into standalone components.

Leave behavior unchanged while reducing file size.
