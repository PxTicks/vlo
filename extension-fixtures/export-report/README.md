# Export and render conformance fixture

This fixture targets VLO SDK `>=1.11.0`. It proves the Phase I surface —
`api.export` — behaves as an extension author would expect:

- a single `export.subscribe` listener builds a post-export report. The signal
  is progress-grained rather than commit-grained, so the fixture records a run
  only once it has *settled*, and deduplicates by run ID — a listener that
  appended on every notification would produce one entry per rendered frame;
- the report covers renders the user started as well as the fixture's own,
  which is what makes reporting possible at all. `startedByExtension` is
  compared against the fixture's own ID rather than assumed;
- `render-placed-range` starts a render with `export.start()` and records the
  `ExtensionExportStartResult`. That result says a run *began* — the outcome
  arrives through the subscription, because a render takes minutes and the
  user can cancel it;
- `capture-thumbnail` reads one composited frame with `export.renderFrame()`
  and ingests it through `assets.ingest()`, which is the "read the frames it
  produced" half of the phase;
- settled entries are flushed into `storage.project`, re-reading the store
  inside the listener rather than caching it, since a project can close or
  hydrate between notifications.
