import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionDisposable,
  ExtensionMenuCondition,
  ExtensionResource,
} from "../../types";
import { AppMenu } from "../../../../core/shell/AppMenu";
import type { HostMenuSubject } from "../../../../core/shell/hostMenus";
import { createExtensionCommandApi } from "../../commands/CommandRegistry";
import {
  extensionMenuPlacementRegistry,
  resolveMenuPlacements,
} from "../ExtensionMenuPlacementRegistry";
import { installExtensionMenuContributions } from "../menuContributionsInstall";

// In the app this runs at the composition root (main.tsx) before the first
// render latches the shell contribution seam.
installExtensionMenuContributions();

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

describe("extension menu placements", () => {
  it("rejects undeclared menus, unregistered or foreign commands, and malformed conditions", () => {
    const scope = createScope("example.menu");
    const commands = createExtensionCommandApi(scope);
    const menus = extensionMenuPlacementRegistry.bind(scope);
    cleanups.push(
      commands.register({ id: "tag", apiVersion: 1, title: "Tag Clip", run: vi.fn() }),
    );

    expect(() =>
      menus.addItem({
        id: "stray",
        apiVersion: 1,
        menuId: "undeclared.menu",
        kind: "command",
        command: "tag",
        group: "9_extensions",
      }),
    ).toThrow(/undeclared host menu/);
    expect(() =>
      menus.addItem({
        id: "orphan",
        apiVersion: 1,
        menuId: "timeline.clip.context",
        kind: "command",
        command: "missing",
        group: "9_extensions",
      }),
    ).toThrow(/Register the command first/);
    expect(() =>
      menus.addItem({
        id: "foreign",
        apiVersion: 1,
        menuId: "timeline.clip.context",
        kind: "command",
        command: "other.owner/tag",
        group: "9_extensions",
      }),
    ).toThrow(/local command ID/);
    expect(() =>
      menus.addItem({
        id: "bad-when",
        apiVersion: 1,
        menuId: "timeline.clip.context",
        kind: "command",
        command: "tag",
        group: "9_extensions",
        when: { bogus: true } as unknown as ExtensionMenuCondition,
      }),
    ).toThrow(/no recognised operator/);
  });

  it("merges placements into AppMenu with command title, dispatch, and legacy test IDs", () => {
    const scope = createScope("example.menu");
    const commands = createExtensionCommandApi(scope);
    const menus = extensionMenuPlacementRegistry.bind(scope);
    const run = vi.fn();
    cleanups.push(
      commands.register({ id: "tag", apiVersion: 1, title: "Tag Clip", run }),
    );
    cleanups.push(
      menus.addItem({
        id: "tag",
        apiVersion: 1,
        menuId: "timeline.clip.context",
        kind: "command",
        command: "tag",
        group: "9_extensions",
      }),
    );

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

    fireEvent.click(screen.getByTestId("extension-clip-menu-item-example.menu/tag"));
    expect(run).toHaveBeenCalledWith({
      subject: CLIP_SUBJECT,
      source: "menu",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("evaluates structured subject conditions and hides non-matching placements", () => {
    const scope = createScope("example.menu");
    const commands = createExtensionCommandApi(scope);
    const menus = extensionMenuPlacementRegistry.bind(scope);
    cleanups.push(
      commands.register({ id: "tag", apiVersion: 1, title: "Tag Clip", run: vi.fn() }),
    );
    cleanups.push(
      menus.addItem({
        id: "audio-only",
        apiVersion: 1,
        menuId: "timeline.clip.context",
        kind: "command",
        command: "tag",
        group: "9_extensions",
        when: { subject: { path: ["clip", "type"], equals: "audio" } },
      }),
    );
    cleanups.push(
      menus.addItem({
        id: "video-only",
        apiVersion: 1,
        menuId: "timeline.clip.context",
        kind: "command",
        command: "tag",
        group: "9_extensions",
        when: { subject: { path: ["clip", "type"], equals: "video" } },
      }),
    );

    expect(
      resolveMenuPlacements("timeline.clip.context", CLIP_SUBJECT).map(
        (placement) => placement.id,
      ),
    ).toEqual(["example.menu/video-only"]);
  });

  it("makes placements of disposed commands inert with one owner diagnostic", () => {
    const report = vi.fn();
    const scope = createScope("example.menu", report);
    const commands = createExtensionCommandApi(scope);
    const menus = extensionMenuPlacementRegistry.bind(scope);
    const command = commands.register({
      id: "tag",
      apiVersion: 1,
      title: "Tag Clip",
      run: vi.fn(),
    });
    cleanups.push(
      menus.addItem({
        id: "tag",
        apiVersion: 1,
        menuId: "timeline.clip.context",
        kind: "command",
        command: "tag",
        group: "9_extensions",
      }),
    );

    command.dispose();
    expect(resolveMenuPlacements("timeline.clip.context", CLIP_SUBJECT)).toEqual([]);
    resolveMenuPlacements("timeline.clip.context", CLIP_SUBJECT);
    expect(
      report.mock.calls.filter(([, message]) =>
        String(message).includes("disposed command"),
      ),
    ).toHaveLength(1);
  });

  it("exposes the catalogued menus with subject schemas through listMenus", () => {
    const scope = createScope("example.menu");
    const menus = extensionMenuPlacementRegistry.bind(scope);
    const infos = menus.listMenus();
    // The catalogue grows menu-by-menu; pin the wave-1 menus and the schema
    // contract rather than the full list.
    const ids = infos.map((info) => info.id);
    expect(ids).toContain("timeline.clip.context");
    expect(ids).toContain("library.item.actions");
    for (const info of infos) {
      expect(info.subjectSchema).toBeDefined();
      expect(Object.isFrozen(info.subjectSchema)).toBe(true);
    }
    const clipInfo = infos.find((info) => info.id === "timeline.clip.context");
    expect(clipInfo?.subjectSchema).toMatchObject({
      clip: { id: "string" },
    });
  });
});
