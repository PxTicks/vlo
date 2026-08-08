# Exposure report composition conformance fixture

This fixture targets VLO SDK `>=1.13.0`. It is the *consumer* half of the Phase
K composition pair; [`false-color`](../false-color/README.md) is the provider.

Together they are Phase K's acceptance case: two packages by the same author
compose without going through the timeline model or a trusted global.

- **A declared dependency, not a hopeful lookup.** `"dependencies": {
  "example.false-color": ">=1.2.0 <2.0.0" }` makes the host check the version,
  activate the provider first, and refuse this package outright if the provider
  is missing, incompatible, or failed. `requireApi` therefore cannot race:
  by the time `activate` runs, the API is published.
- **A narrowed peer contract.** The consumer declares only the part of the
  exported API it uses rather than importing the provider's source, because the
  two packages ship and version separately.
- **Progress for long work.** The scan renders a frame per clip, which is
  minutes with nothing on screen, so it runs under
  `ui.notifications.task` with a cancel the user can press. Cancelling *asks*
  the scan to stop; the scan settles the task once it actually has.
- **A namespaced context key.** The scan publishes
  `extension.example.exposure-report.scanned`, which gates this package's own
  bottom-dock view and is equally readable by any other package's `when`
  clause. Host keys stay host-owned: a package adds to the editor's vocabulary
  without being able to redefine `project.open`.

Both packages defer to `onProjectOpen`, since neither has anything to say
before a project is open.
