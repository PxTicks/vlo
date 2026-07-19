/**
 * Pins the §3.10 finding-1 independence property: shell menus render and
 * validate with no `features/extensions` import anywhere in this file's
 * graph — the catalogue is declared by the shell menu modules themselves,
 * and the contribution seam degrades to the empty source.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppMenu } from "../AppMenu";
import { MenuHostMount } from "../MenuHostMount";
import { hostCommandTable } from "../commandTable";
import { contextMenuService } from "../contextMenuService";
import type { HostMenuSubject } from "../hostMenus";
import { installMenuContributions } from "../menuContributions";
import { showHostContextMenu } from "../showHostContextMenu";
import { useHostContextMenu } from "../useHostContextMenu";

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

describe("shell menus without the extensions feature", () => {
  it("renders host command and action items against the shell-declared catalogue", () => {
    const run = vi.fn();
    const command = hostCommandTable.registerHostCommand({
      id: "core.test.ping",
      title: "Ping",
      run,
    });
    try {
      render(
        <AppMenu
          menuId="timeline.clip.context"
          subject={CLIP_SUBJECT}
          items={[
            {
              kind: "command",
              id: "ping",
              command: "core.test.ping",
              group: "1_clip",
            },
            {
              kind: "action",
              id: "inline",
              label: "Inline",
              group: "1_clip",
              run: vi.fn(),
            },
          ]}
          open
          onClose={vi.fn()}
          anchorPosition={{ top: 10, left: 10 }}
        />,
      );

      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Ping", "Inline"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Ping" }));
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      command.dispose();
    }
  });

  it("rejects invalid subjects, so the schema guard is active core-only", () => {
    const malformed = {
      slot: "timeline.clip.context",
      clip: { id: "c1" },
    } as unknown as typeof CLIP_SUBJECT;
    expect(() =>
      render(
        <AppMenu
          menuId="timeline.clip.context"
          subject={malformed}
          items={[]}
          open
          onClose={vi.fn()}
          anchorPosition={{ top: 0, left: 0 }}
        />,
      ),
    ).toThrow(/catalogued schema/);
  });

  it("shows imperative context menus through the shell service core-only", () => {
    render(<MenuHostMount />);
    const run = vi.fn();
    act(() => {
      showHostContextMenu({
        menuId: "timeline.clip.context",
        subject: CLIP_SUBJECT,
        items: [
          { kind: "action", id: "probe", label: "Probe", group: "1_clip", run },
        ],
        position: { x: 24, y: 48 },
      });
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Probe" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(contextMenuService.getActive()).toBeNull();
  });

  it("binds hook-shown menus to the owning component's lifecycle", () => {
    function Owner() {
      const showMenu = useHostContextMenu();
      return (
        <button
          type="button"
          onClick={() =>
            showMenu({
              menuId: "timeline.clip.context",
              subject: CLIP_SUBJECT,
              items: [
                {
                  kind: "action",
                  id: "probe",
                  label: "Probe",
                  group: "1_clip",
                  run: vi.fn(),
                },
              ],
              position: { x: 1, y: 2 },
            })
          }
        >
          open
        </button>
      );
    }

    const { unmount } = render(<Owner />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(contextMenuService.getActive()?.menuId).toBe(
      "timeline.clip.context",
    );

    // Unmounting the owner closes its menu, so stale closures never survive
    // the component that created them.
    unmount();
    expect(contextMenuService.getActive()).toBeNull();
  });

  it("refuses contribution installation once rendering has latched the seam", () => {
    // The renders above latched the empty source; installation now must fail
    // loudly instead of silently missing contributions — the composition
    // root has to install before the first render.
    expect(() => installMenuContributions(() => [])).toThrow(
      /before the first menu render/,
    );
  });
});
