# Audio projections, analysis, and effects

Use this reference for `context.api.audio` and `trusted-audio-effect` transformation
contributions. Verify exact definitions in `packages/extension-sdk/src/index.ts`.

## Discover audio-bearing model state

Use `audio.listClips()` to discover placed audio and video clips whose project
assets are known to contain audio. Each snapshot carries the asset and track IDs,
placement range, raw-source in-point/span, and clip mute. Use `audio.listTracks()`
for audio tracks and visual tracks that currently contain an audio-bearing clip;
it includes track mute/visibility/lock state and ordered audio clip IDs.

This is a focused projection, not a second timeline model. Use `timeline.listClips()`
for transformations and general placement state. `audio.subscribe` / `getRevision`
follow the shared payload-free pattern and signal on timeline or asset-library
changes.

## Analyse raw source audio

`audio.inspect(assetId)` reports the primary decoded stream's sample rate, channel
count, true stream span, first timestamp, exclusive end timestamp, and advertised
PCM frame ceiling. First timestamps may be non-zero or negative. `readPcm` returns
freshly allocated planar `Float32Array` copies for a source-time range; the host
never retains or reuses them. `readWaveform` returns per-channel min/max arrays,
where each pair summarizes `samplesPerPeak` source frames.

These methods decode the asset, not a rendered timeline placement. Results do not
include clip mute, volume, effects, or retiming. This keeps analysis deterministic
and lets several placements reuse one source analysis. Map source detections back
through `timeline.sourceTicksToClipProgress(clipId, sourceTicks)` before placing a
marker or split, so crop and retiming stay host-owned. PCM ranges use decoder
timestamps; when converting a detected timestamp to the timeline's zero-based
source ticks, subtract `source.firstTimestampSeconds` first.

Reads are bounded to keep one extension from allocating an unbounded planar buffer.
Use `source.maxPcmFramesPerRead` to issue deterministic adjacent PCM requests; handle
`range_too_large` as a stale-metadata fallback or increase `samplesPerPeak` for a
waveform overview. Missing/non-audio/undecodable sources and empty ranges are typed
outcomes. Malformed IDs, non-finite ranges, and invalid peak sizes are programming
errors and throw. Cancellation rejects with `AbortError`, whether it came from the
request signal or extension deactivation through the activation scope. Pass
`context.signal` for work started by the extension and stop late writes after
cancellation.

## Contribute trusted Web Audio effects

Register an audio effect through `context.api.transformations.register` with
`kind: "trusted-audio-effect"`. It uses the same owner-qualified ID, UI groups,
defaults, validation, timeline transform, undo, rollback, and disposal rules as
visual transformation contributions, but the host offers it only to audio-bearing
clips.

`createEffect(audioContext)` must return context-bound `inputNode` and `outputNode`
endpoints plus a synchronous `apply(parameters, context)` callback. Build every node
from the supplied context: preview and each offline export use different audio
contexts. The host connects the endpoints into the clip's persistent effect chain,
calls `apply` for each scheduled chunk, disconnects endpoints, and invokes optional
`destroy` for internal resources.

The raw `parameters` argument is an independently cloned snapshot typed as `unknown`;
narrow it before use and do not expect edits to it to reach the document. Prefer
`context.resolveParameter` for registered controls, especially animated numeric
values. It resolves against the same parameter snapshot used for that scheduling
call, so one chunk cannot observe a torn authoring update.

Use `context.resolveParameter(name, presentationTicks)` for animated numeric
controls. It samples in source-media time through the same mapping as native volume
and audio effects. Schedule Web Audio automation against `startContextTime` and
`wallDurationSeconds`; never read the global playhead. Declare a conservative
`maxTailSeconds` for delays, reverbs, compressors, or other effects that must survive
past source audio, so preview cleanup and export preroll do not cut the tail.

Constructor/apply/cleanup failures are isolated and reported once as extension
diagnostics. The affected effect is bypassed or keeps its last scheduled state; it
must never take down transport or export.
