# Changelog

Notable changes to VLO are documented here.

## 0.3.2

### Added

- LTX 2.5 Refine Details and Restore workflows for enhancing existing video.
- MiniMax H3 inpaint controls for mask growth, VAE-grid snapping, masked-area
  prefill, temporal feathering, and an optional seam repair pass.
- Alpha-based cropping for masked stills and custom generation crop padding
  above the slider's range.
- A 360p option for timeline selections, clip skew, and fixed-edge scaling.
- The Generation panel detects outdated local ComfyUI-vlo packs and can update
  packs installed by vlo.

### Changed

- SAM2 masks preserve subpixel edges. Mask growth, feathering, and Boolean
  combinations use distance fields for smoother edges and fewer seams.
- Position, scale, and rotation share one layout keyframe track.

### Fixed

- MP4 and WebM exports preserve the encoder's color metadata, preventing crushed
  shadows, clipped highlights, and incorrect color tags in exported selections.
- The embedded ComfyUI page loads its relative assets when opened without a
  trailing slash and reports ready even when no workflow tab is open.
- The preview recovers after WebGL context loss. Timeline thumbnails and
  waveforms remain visible during scrolling and editing.
- Generation keeps delivery events that arrive before the submission response,
  preserves captured aspect ratios when replaying settings, and skips widget
  overrides for bypassed nodes.
- ComfyUI V3 combo widgets appear as dropdowns. Audio-only video containers
  import as audio.
- Color grading retains curve textures and preserves super-whites when editing
  the highlight response.

## 0.3.1

### Added

- Marquee selection in the timeline and asset browser.
- A dedicated opacity transformation.
- LoRA stacks in MiniMax and image workflows, with additional slots appearing as
  models are selected.
- Optional start and end frame inputs for the MiniMax H3 TTM workflow.

### Changed

- Improved long-timeline performance by rendering clips, thumbnails and waveforms
  around the visible area and reducing unnecessary updates during edits and scrolling.
- Imported media becomes available for editing before its proxy is ready. Proxies
  are generated in the background, including missing proxies when reopening a project.
- Deleting an asset group now shows one confirmation instead of a separate prompt
  for each asset.

### Fixed

- Fixed blank editor pages on Windows caused by incorrect JavaScript MIME types.
- Fixed the Windows installer hanging when Git Bash or MSYS supplies a different
  `find` command.
- Fixed SAM-Audio installation in folders whose paths contain spaces.
- Fixed custom-node requests and WebSocket connections in the embedded ComfyUI interface.
- Generation controls now follow LoRA loaders being enabled or bypassed in ComfyUI.
- Fixed keyframed transformation and audio controls showing stale values after
  switching panels or remounting. Focusing an unchanged input no longer overwrites
  a keyframe with the clip's starting value.
- Slider drags now produce a single undo step, including speed and mask controls.
- Keyboard shortcuts such as undo and redo now work while a slider has focus.
- Fixed clips turning black or newly added grades having no effect when changing
  the number of color grades.
- Fixed fully saturated pixels being excluded by full-range color qualifiers.
- Fixed timeline zoom-out calculations ignoring the header width.
- Stalled proxy conversions no longer block later media processing.
- Project folder selection now explains unavailable browser folder access instead
  of failing silently.
- The ComfyUI installation dialog no longer closes when clicking its backdrop.
- Fixed workflow how-to dialogs getting stuck loading after switching workflows.
- Cancelling a running backend job no longer logs a spurious error.
- Stopping `npm run dev` with Ctrl+C now also stops the backend process.

## [0.3.0]

### Added

- New Live ComfyUI bridge, allows asset sharing and live media capture
- Sam-audio for ai-driven stem separation
- New workflows, including Minimax workflows.
- Composite clips and subtimelines
- Extension SDK
- Adjustment Clips
- Color grading
- Managed installs for ComfyUI, SAM2, Sam-Audio etc.
- Transitions

### Changed

- Unified backend and ComfyUI queuing.
- New frame-graph renderer: live preview and export use the same render plan

[0.3.0]: https://github.com/PxTicks/vlo/releases/tag/v0.3.0
