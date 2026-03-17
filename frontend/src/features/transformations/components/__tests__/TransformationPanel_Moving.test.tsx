import { render, screen, fireEvent } from "@testing-library/react";
import { TransformationPanel } from "../TransformationPanel";
import { useTimelineStore } from "../../../timeline";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the store
vi.mock("../../../timeline/useTimelineStore");

// Mock TransformationGroup to avoid testing its internals
vi.mock("../TransformationGroup", () => ({
  TransformationGroup: (props: {
    group: { id: string };
    transform?: { id: string; parameters?: { factor: number } };
    onCommit: (
      groupId: string,
      param: string,
      value: number,
      id?: string,
    ) => void;
  }) => {
    // Only render the Speed group for simplicity
    if (props.group.id === "speed") {
      return (
        <div data-testid="group-speed">
          <label htmlFor="speed-factor">Factor</label>
          <input
            id="speed-factor"
            type="number"
            value={props.transform?.parameters?.factor || 1}
            onChange={(e) =>
              props.onCommit(
                "speed",
                "factor",
                parseFloat(e.target.value),
                props.transform?.id,
              )
            }
          />
        </div>
      );
    }
    return null;
  },
}));

describe("TransformationPanel Moving Reproduction", () => {
  const mockUpdateClipShape = vi.fn();
  const mockUpdateClipTransform = vi.fn();
  const mockAddClipTransform = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates same duration regardless of clip start time", () => {
    // Scenario 1: Clip at 0
    // Scenario 2: Clip at 1000
    // Apply 2x speed. Duration should be consistent.

    // We will perform the action twice by re-rendering with different store states.

    // --- Run 1: Start 0 ---
    let capturedUpdates0: Record<string, unknown> | null = null;

    (
      useTimelineStore as unknown as {
        mockImplementation: (
          fn: (selector: (state: unknown) => unknown) => unknown,
        ) => void;
      }
    ).mockImplementation((selector) => {
      return selector({
        selectedClipIds: ["clip_0"],
        clips: [
          {
            id: "clip_0",
            start: 0,
            timelineDuration: 96000 * 10,
            sourceDuration: 96000 * 10,
            offset: 0,
            transformedOffset: 0,
            transformations: [
              {
                id: "speed_1",
                type: "speed",
                isEnabled: true,
                parameters: { factor: 1 },
              },
            ],
          },
        ],
        updateClipShape: (_id: string, updates: Record<string, unknown>) => {
          capturedUpdates0 = updates;
          mockUpdateClipShape(_id, updates);
        },
        updateClipTransform: mockUpdateClipTransform,
        addClipTransform: mockAddClipTransform,
        activeClip: {
          id: "clip_0",
          start: 0,
          timelineDuration: 96000 * 10,
          sourceDuration: 96000 * 10,
          offset: 0,
          transformedOffset: 0,
          transformations: [
            {
              id: "speed_1",
              type: "speed",
              isEnabled: true,
              parameters: { factor: 1 },
            },
          ],
        },
        activeTransforms: [
          {
            id: "speed_1",
            type: "speed",
            isEnabled: true,
            parameters: { factor: 1 },
          },
        ],
        activeClipDuration: 10,
        activeClipSourceDuration: 10,
      });
    });

    const { unmount } = render(<TransformationPanel />);

    // Apply Speed 2x
    const input = screen.getByLabelText("Factor");
    fireEvent.change(input, { target: { value: "2" } });

    unmount();

    // --- Run 2: Start 5000 ---
    let capturedUpdatesMoved: Record<string, unknown> | null = null;

    (
      useTimelineStore as unknown as {
        mockImplementation: (
          fn: (selector: (state: unknown) => unknown) => unknown,
        ) => void;
      }
    ).mockImplementation((selector) => {
      return selector({
        selectedClipIds: ["clip_moved"],
        clips: [
          {
            id: "clip_moved",
            start: 5000, // MOVED
            timelineDuration: 96000 * 10,
            sourceDuration: 96000 * 10,
            offset: 0,
            transformedOffset: 0,
            transformations: [
              {
                id: "speed_1",
                type: "speed",
                isEnabled: true,
                parameters: { factor: 1 },
              },
            ],
          },
        ],
        updateClipShape: (_id: string, updates: Record<string, unknown>) => {
          capturedUpdatesMoved = updates;
          mockUpdateClipShape(_id, updates);
        },
        updateClipTransform: mockUpdateClipTransform,
        addClipTransform: mockAddClipTransform,
        activeClip: {
          id: "clip_moved",
          start: 5000, // MOVED
          timelineDuration: 96000 * 10,
          sourceDuration: 96000 * 10,
          offset: 0,
          transformedOffset: 0,
          transformations: [
            {
              id: "speed_1",
              type: "speed",
              isEnabled: true,
              parameters: { factor: 1 },
            },
          ],
        },
        activeTransforms: [
          {
            id: "speed_1",
            type: "speed",
            isEnabled: true,
            parameters: { factor: 1 },
          },
        ],
        activeClipDuration: 10,
        activeClipSourceDuration: 10,
      });
    });

    render(<TransformationPanel />);

    // Apply Speed 2x
    const inputMoved = screen.getByLabelText("Factor");
    fireEvent.change(inputMoved, { target: { value: "2" } });

    expect(capturedUpdatesMoved).toEqual(capturedUpdates0);
  });

  it("calculates same duration regardless of clip start time WITH CROP", () => {
    // More complex case: Non-zero offset (cropping content).

    // --- Run 1: Start 0 ---
    let capturedUpdates0: Record<string, unknown> | null = null;

    (
      useTimelineStore as unknown as {
        mockImplementation: (
          fn: (selector: (state: unknown) => unknown) => unknown,
        ) => void;
      }
    ).mockImplementation((selector) => {
      return selector({
        selectedClipIds: ["clip_0"],
        clips: [
          {
            id: "clip_0",
            start: 0,
            timelineDuration: 96000 * 5, // Visual: 5s
            sourceDuration: 96000 * 10,
            offset: 96000 * 2, // Offset 2s (Content starts at 2s)
            transformedOffset: 0,
            transformations: [
              {
                id: "speed_1",
                type: "speed",
                isEnabled: true,
                parameters: { factor: 1 },
              },
            ],
          },
        ],
        updateClipShape: (_id: string, updates: Record<string, unknown>) => {
          capturedUpdates0 = updates;
        },
        updateClipTransform: mockUpdateClipTransform,
        addClipTransform: mockAddClipTransform,
        activeClip: {
          id: "clip_0",
          start: 0,
          timelineDuration: 96000 * 5,
          sourceDuration: 96000 * 10,
          offset: 96000 * 2,
          transformedOffset: 0,
          transformations: [
            {
              id: "speed_1",
              type: "speed",
              isEnabled: true,
              parameters: { factor: 1 },
            },
          ],
        },
        activeTransforms: [
          {
            id: "speed_1",
            type: "speed",
            isEnabled: true,
            parameters: { factor: 1 },
          },
        ],
        activeClipDuration: 5,
        activeClipSourceDuration: 10,
      });
    });

    const { unmount } = render(<TransformationPanel />);

    // Apply Speed 2x
    const input = screen.getByLabelText("Factor");
    fireEvent.change(input, { target: { value: "2" } });

    unmount();

    // --- Run 2: Start 5000 ---
    let capturedUpdatesMoved: Record<string, unknown> | null = null;

    (
      useTimelineStore as unknown as {
        mockImplementation: (
          fn: (selector: (state: unknown) => unknown) => unknown,
        ) => void;
      }
    ).mockImplementation((selector) => {
      return selector({
        selectedClipIds: ["clip_moved"],
        clips: [
          {
            id: "clip_moved",
            start: 5000, // MOVED
            timelineDuration: 96000 * 5,
            sourceDuration: 96000 * 10,
            offset: 96000 * 2, // SAME OFFSET
            transformedOffset: 0,
            transformations: [
              {
                id: "speed_1",
                type: "speed",
                isEnabled: true,
                parameters: { factor: 1 },
              },
            ],
          },
        ],
        updateClipShape: (_id: string, updates: Record<string, unknown>) => {
          capturedUpdatesMoved = updates;
        },
        updateClipTransform: mockUpdateClipTransform,
        addClipTransform: mockAddClipTransform,
        activeClip: {
          id: "clip_moved",
          start: 5000,
          timelineDuration: 96000 * 5,
          sourceDuration: 96000 * 10,
          offset: 96000 * 2,
          transformedOffset: 0,
          transformations: [
            {
              id: "speed_1",
              type: "speed",
              isEnabled: true,
              parameters: { factor: 1 },
            },
          ],
        },
        activeTransforms: [
          {
            id: "speed_1",
            type: "speed",
            isEnabled: true,
            parameters: { factor: 1 },
          },
        ],
        activeClipDuration: 5,
        activeClipSourceDuration: 10,
      });
    });

    render(<TransformationPanel />);

    const inputMoved = screen.getByLabelText("Factor");
    fireEvent.change(inputMoved, { target: { value: "2" } });

    expect(capturedUpdatesMoved).toEqual(capturedUpdates0);
  });
});
