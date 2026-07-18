import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextMenuService } from "../../../../core/shell/contextMenuService";
import { MenuHostMount } from "../MenuHostMount";
import { showHostContextMenu } from "../showHostContextMenu";
import type { HostMenuSubject } from "../AppMenu";

const CLIP_SUBJECT: HostMenuSubject<"timeline.clip.context"> = {
  slot: "timeline.clip.context",
  clip: {
    id: "clip-1",
    type: "video",
    name: "Clip",
    trackId: "track-1",
    startTicks: 0,
    durationTicks: 100,
    transformations: [],
  },
};

afterEach(() => {
  act(() => contextMenuService.close());
});

describe("MenuHostMount", () => {
  it("renders the active shell menu request and closes on selection", () => {
    render(<MenuHostMount />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const run = vi.fn();
    act(() => {
      showHostContextMenu({
        menuId: "timeline.clip.context",
        subject: CLIP_SUBJECT,
        items: [
          {
            kind: "action",
            id: "probe",
            label: "Probe",
            group: "1_clip",
            run,
          },
        ],
        position: { x: 24, y: 48 },
      });
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Probe" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(contextMenuService.getActive()).toBeNull();
  });

  it("closes through the returned handle", () => {
    render(<MenuHostMount />);
    let handle: { dispose(): void } | undefined;
    act(() => {
      handle = showHostContextMenu({
        menuId: "timeline.clip.context",
        subject: CLIP_SUBJECT,
        items: [
          { kind: "action", id: "probe", label: "Probe", group: "1_clip", run: vi.fn() },
        ],
        position: { x: 0, y: 0 },
      });
    });
    expect(screen.getByRole("menuitem", { name: "Probe" })).toBeInTheDocument();
    act(() => handle?.dispose());
    expect(contextMenuService.getActive()).toBeNull();
  });
});
