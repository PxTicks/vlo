# Audio analysis conformance fixture

This fixture targets VLO SDK `>=1.12.0` and proves the Phase J audio surface:

- `audio.listClips()` discovers audio-bearing placements without guessing from
  track labels;
- `audio.inspect()` advertises the source timestamp range and PCM frame ceiling,
  then `audio.readPcm()` decodes one deterministic bounded source chunk;
- `timeline.sourceTicksToClipProgress()` maps detected source transients back
  through clip crop and retiming before one atomic split transaction;
- `trusted-audio-effect` contributes a context-bound Web Audio compressor with
  ordinary host controls, validation, ownership, and disposal.

The detector is intentionally small and deterministic. It is a conformance
example, not a production beat tracker.
