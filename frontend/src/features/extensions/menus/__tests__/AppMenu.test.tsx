import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionDisposable,
  ExtensionResource,
  ExtensionUiMenuItemContext,
} from "../../types";
import { hostCommandRegistry } from "../../commands/CommandRegistry";
import { extensionUiSlotRegistry } from "../../ui/ExtensionUiSlotRegistry";
import { AppMenu } from "../AppMenu";
import type { HostMenuItemDescriptor } from "../menuDescriptors";

const CLIP_SUBJECT: ExtensionUiMenuItemContext = {
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

function createScope(
  extensionId: string,
  report: ExtensionApiScope["report"] = vi.fn(),
): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report,
  };
}

const cleanups: ExtensionDisposable[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) void cleanup.dispose();
});

describe("AppMenu", () => {
  it("renders host action and command items in group order and dispatches through the command table", () => {
    const run = vi.fn();
    cleanups.push(
      hostCommandRegistry.registerHostCommand({
        id: "test.clip.ping",
        title: "Ping",
        run,
      }),
    );
    const action = vi.fn();
    const onClose = vi.fn();
    const items: HostMenuItemDescriptor[] = [
      {
        kind: "command",
        id: "ping",
        command: "test.clip.ping",
        subject: { clipId: "clip-1" },
        group: "1_clip",
      },
      {
        kind: "action",
        id: "inline",
        label: "Inline",
        group: "1_clip",
        run: action,
      },
    ];

    render(
      <AppMenu
        menuId="timeline.clip.context"
        subject={CLIP_SUBJECT}
        items={items}
        open
        onClose={onClose}
        anchorPosition={{ top: 10, left: 10 }}
      />,
    );

    const rendered = screen.getAllByRole("menuitem");
    expect(rendered.map((item) => item.textContent)).toEqual([
      "Ping",
      "Inline",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Ping" }));
    expect(run).toHaveBeenCalledWith({
      subject: { clipId: "clip-1" },
      source: "menu",
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("menuitem", { name: "Inline" }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("disables items whose command is missing or gated off", () => {
    cleanups.push(
      hostCommandRegistry.registerHostCommand({
        id: "test.clip.gated",
        title: "Gated",
        when: { key: "test.never" },
        run: vi.fn(),
      }),
    );
    render(
      <AppMenu
        menuId="timeline.clip.context"
        subject={CLIP_SUBJECT}
        items={[
          {
            kind: "command",
            id: "gated",
            command: "test.clip.gated",
            group: "1_clip",
          },
          {
            kind: "command",
            id: "missing",
            command: "test.clip.missing",
            label: "Missing",
            group: "1_clip",
          },
        ]}
        open
        onClose={vi.fn()}
        anchorPosition={{ top: 10, left: 10 }}
      />,
    );

    expect(screen.getByRole("menuitem", { name: "Gated" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Missing" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("merges extension contributions into the trailing group with a divider and legacy test IDs", () => {
    const onSelect = vi.fn();
    const registration = extensionUiSlotRegistry
      .bind(createScope("example.menu"))
      .registerMenuItem({
        id: "tag",
        apiVersion: 1,
        slot: "timeline.clip.context",
        kind: "menu-item",
        label: "Tag Clip",
        onSelect,
      });
    cleanups.push(registration);

    const onClose = vi.fn();
    render(
      <AppMenu
        menuId="timeline.clip.context"
        subject={CLIP_SUBJECT}
        items={[
          { kind: "action", id: "host", label: "Host", group: "1_clip", run: vi.fn() },
        ]}
        open
        onClose={onClose}
        anchorPosition={{ top: 10, left: 10 }}
        extensionItemTestIdPrefix="extension-clip-menu-item-"
      />,
    );

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Host", "Tag Clip"]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);

    const extensionItem = screen.getByTestId(
      "extension-clip-menu-item-example.menu/tag",
    );
    fireEvent.click(extensionItem);
    expect(onSelect).toHaveBeenCalledWith(CLIP_SUBJECT);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
