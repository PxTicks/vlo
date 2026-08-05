# Transport, selection, and project conformance fixture

This fixture targets VLO SDK `>=1.10.0`. It proves the Phase H surfaces —
transport writes, selection writes, and project identity — behave as an
extension author would expect:

- `next-edit` / `previous-edit` read the playhead and `timeline.listClips()`,
  then move the transport with `playback.seek()`. The returned
  `ExtensionTransportResult` is recorded rather than assumed: the host clamps
  and frame-snaps every seek, and refuses one outright while an export or
  capture flow owns the transport;
- `select-asset-siblings` turns "the clip I have selected" into "every clip
  using that asset" through `selection.setClips()`, which is the outcome an
  extension could previously only ask a user to perform by hand;
- `project.subscribe` tracks project identity across open, close, and save
  with the same payload-free listener every other read domain uses;
- `project.onBeforeSave` flushes the visited playhead into
  `storage.project`, which is the ordering that makes project-scoped storage
  usable: the host writes the extension's namespace in the same save.

The keybinding (`Mod+Alt+ArrowRight`) is an ordinary chord, unlike the
deliberate collision in the `command-hotkeys` fixture.
