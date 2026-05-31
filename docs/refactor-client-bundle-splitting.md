# Refactor: Client Bundle Splitting

## Problem

The production build succeeds, but Vite warns that one minified JavaScript chunk is larger than 500 KB. The current large chunk includes dashboard UI, charts, markdown/transcript rendering, syntax highlighting, and supporting libraries.

## Why It Matters

For a local-first app this is not urgent, but it will affect first load as the dashboard grows. Transcript rendering and syntax highlighting are not needed for the initial dashboard screen, so they are good candidates for lazy loading.

## Pragmatic Plan

1. Lazy-load `TranscriptView`.
2. Lazy-load timeline rendering and Prism-related code behind transcript view.
3. Consider lazy-loading chart code only if first-load performance is still poor.
4. Avoid manual Rollup chunking until dynamic imports are in place.

## Suggested First Step

Wrap `TranscriptView` in `React.lazy` and render it inside a `Suspense` fallback only when the `transcript` route state is active.
