import type { Asset, GeneratedCreationInput } from "../../../types/Asset";
import type { LegacyTimelineSelection, TimelineSelection } from "../../../types/TimelineTypes";
import { useProjectStore } from "../../project/useProjectStore";
import { parseTimelineSelection } from "./timelineSelection";

/**
 * Resolves a TimelineSelection from an asset's creation metadata: the
 * extracted selection, or the generation input that places the asset (see
 * {@link findPlacementInput}).
 *
 * Selections are stripped from the asset index, so this answers `null` for an
 * asset whose metadata sidecar has not been hydrated. Callers that only need
 * the selection's placement should use
 * {@link getTimelineSelectionStartFromAsset}, which survives the strip.
 */
export function getTimelineSelectionFromAsset(
  asset: Asset,
): TimelineSelection | null {
  const meta = asset.creationMetadata;
  if (!meta) return null;

  if (meta.source === "extracted" && meta.timelineSelection) {
    return parseTimelineSelection(meta.timelineSelection, useProjectStore.getState().config.fps) ?? null;
  }

  if (meta.source === "generated") {
    const input = findPlacementInput(meta.inputs, (candidate) => candidate.timelineSelection !== undefined);
    if (input?.timelineSelection) {
      return parseTimelineSelection(input.timelineSelection, useProjectStore.getState().config.fps) ?? null;
    }
  }

  return null;
}

/**
 * The start tick of the asset's placing timeline selection, or `null` when it has
 * none. Unlike {@link getTimelineSelectionFromAsset} this reads the abridged
 * index copy too, so "Send to Timeline" stays offered — and lands in the right
 * place — without paying to hydrate every asset the browser renders.
 */
export function getTimelineSelectionStartFromAsset(
  asset: Asset,
): number | null {
  const meta = asset.creationMetadata;
  if (!meta) return null;

  if (meta.source === "extracted") {
    return savedAnchor(meta.timelineSelection) ?? meta.timelineSelectionStart ?? null;
  }

  if (meta.source === "generated") {
    const input = findPlacementInput(meta.inputs, (candidate) => selectionStart(candidate) !== undefined);
    return input ? (selectionStart(input) ?? null) : null;
  }

  return null;
}

type SelectionCreationInput = Extract<GeneratedCreationInput, { kind: "timelineSelection" }>;

/**
 * The selection input a generated asset lines up with. A workflow fed both a
 * range and a captured frame (e.g. video inpainting with first/last-frame
 * guides) produces output spanning the range, so ranges win; workflow input
 * order only breaks ties. Frames still place frame-only (i2v) generations.
 */
function findPlacementInput(
  inputs: readonly GeneratedCreationInput[],
  isUsable: (input: SelectionCreationInput) => boolean,
): SelectionCreationInput | undefined {
  const candidates = inputs.filter(
    (input): input is SelectionCreationInput => input.kind === "timelineSelection" && isUsable(input),
  );
  return candidates.find((input) => !isFrameInput(input)) ?? candidates[0];
}

function isFrameInput(input: SelectionCreationInput): boolean {
  // `isPoint` covers assets generated before `isFrame` was recorded, once
  // their metadata sidecar is hydrated.
  return input.isFrame === true || input.timelineSelection?.isPoint === true;
}

function selectionStart(input: SelectionCreationInput): number | undefined {
  return savedAnchor(input.timelineSelection) ?? input.timelineSelectionStart;
}

function savedAnchor(selection: TimelineSelection | LegacyTimelineSelection | undefined): number | undefined {
  if (!selection) return undefined;
  return "anchor" in selection ? selection.anchor : selection.start;
}
