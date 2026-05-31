# Refactor: Durable Transcript Import Queue

## Problem

Transcript uploads are accepted before their metrics are processed. `enqueueImport` saves the blob and returns `{ queued: true }`, but parse and metric insertion happen later in an in-memory `SerialQueue`.

If the server exits after accepting an upload but before the queue drains, the transcript blob can exist without a matching `source_files` row or `metric_points`.

## Why It Matters

This creates a quiet consistency failure: the client saw a successful upload, but the dashboard may never count the transcript. Because the queue is not persistent, restart recovery cannot discover unfinished work.

## Pragmatic Options

1. Drain on shutdown.
   - On `SIGINT`/`SIGTERM`, await `storage.settleIngest()` before closing SQLite.
   - Add a short timeout so shutdown cannot hang forever.
   - This is the smallest improvement, but it does not protect against process crashes.

2. Add a durable import job table.
   - Insert an `import_jobs` row when accepting an upload.
   - Mark it `processing`, `done`, or `failed`.
   - On startup, requeue `queued` and stale `processing` jobs.
   - This gives real recovery and makes failed imports inspectable.

## Suggested First Step

Implement shutdown draining first, then add durable jobs if transcript import reliability becomes important beyond local use.
