# False colour scope conformance fixture

This fixture targets VLO SDK `>=1.13.0`. It is the *provider* half of the Phase
K composition pair; [`exposure-report`](../exposure-report/README.md) is the
consumer.

It proves three things about the new surfaces:

- **A contributed scope is an ordinary scope.** `ui.scopes.register` puts a
  false-colour exposure map in the same bottom-dock tab strip as the host's
  waveform, parade, vectorscope, and histogram, because host and contributed
  scopes go through one registry. `render` receives the host's own sampled
  pixels — premultiplied RGBA, valid only for the duration of the call — and
  draws into a host-owned 2D context.
- **Activation is deferred.** `"activationEvents": ["onProjectOpen"]` means the
  package does not run at startup. A scope has nothing to show without a
  project, and before Phase K every approved package activated in inventory
  order whether it had anything to do or not.
- **A package can export an API.** `context.exportApi(falseColorApi)` publishes
  the exposure-zone vocabulary. The host publishes it only after activation
  succeeds and retracts it on deactivation, so a dependent can never hold an API
  built by a session that was rolled back.

The exported value is a contract this package now owns: adding a zone is a minor
version, changing what `classifyLuma` returns is a major one.
