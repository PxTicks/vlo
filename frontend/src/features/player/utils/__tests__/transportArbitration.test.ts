import { afterEach, describe, expect, it } from "vitest";
import {
  isTransportAvailable,
  readTransportArbitrationState,
} from "../transportArbitration";
import { useExtractStore } from "../../../../core/extract/useExtractStore";
import { useTimelineSelectionStore } from "../../../timelineSelection";

const IDLE = {
  extracting: false,
  frameSelectionMode: false,
  timelineSelectionMode: false,
} as const;

describe("transport arbitration", () => {
  afterEach(() => {
    useExtractStore.setState({ isProcessing: false, frameSelectionMode: false });
    useTimelineSelectionStore.setState({ selectionMode: false });
  });

  it("is available only when nothing else owns the transport", () => {
    expect(isTransportAvailable(IDLE)).toBe(true);
    expect(isTransportAvailable({ ...IDLE, extracting: true })).toBe(false);
    expect(isTransportAvailable({ ...IDLE, frameSelectionMode: true })).toBe(
      false,
    );
    expect(isTransportAvailable({ ...IDLE, timelineSelectionMode: true })).toBe(
      false,
    );
  });

  it("reads the live host state each call", () => {
    expect(readTransportArbitrationState()).toEqual(IDLE);

    useExtractStore.setState({ isProcessing: true });
    expect(readTransportArbitrationState().extracting).toBe(true);

    useExtractStore.setState({ isProcessing: false });
    useTimelineSelectionStore.setState({ selectionMode: true });
    expect(readTransportArbitrationState().timelineSelectionMode).toBe(true);
    expect(isTransportAvailable(readTransportArbitrationState())).toBe(false);
  });
});
