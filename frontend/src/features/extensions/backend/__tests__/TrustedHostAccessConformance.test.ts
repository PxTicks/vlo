import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionContext,
  ExtensionResource,
  VloExtensionApi,
} from "../../types";
import {
  activate,
  getRetainedRendererForConformance,
} from "../../../../../../extension-fixtures/trusted-host-access/frontend/src/index";
import { TrustedHostPatchManager } from "../../runtime/TrustedHostPatchManager";
import { TrustedHostAccessDirectory } from "../../runtime/TrustedHostAccessDirectory";

describe("trusted host access conformance fixture", () => {
  it("composes scoped UI, store reads, remount resolution, and patch cleanup", async () => {
    const resources: ExtensionResource[] = [];
    const timelineListeners = new Set<() => void>();
    const directoryListeners = new Set<() => void>();
    const playbackClock = {};
    let renderer: unknown = { id: "first" };
    let registeredComponent: (() => unknown) | undefined;
    const patchManager = new TrustedHostPatchManager();
    const scope = {
      extension: { id: "example.trusted-host-access", version: "1.0.0" },
      signal: new AbortController().signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => {
        resources.push(resource);
        return resource;
      },
      report: vi.fn(),
    };
    const createElement = (
      type: unknown,
      props: Readonly<Record<string, unknown>> | null,
      ...children: unknown[]
    ) => ({ type, props: props ?? {}, children });
    const api = {
      trusted: {
        host: {
          hostVersion: "0.2.0",
          list: () => [],
          get: (id: string) => {
            if (id === "timeline.store") {
              return {
                getState: () => ({ tracks: ["one", "two"] }),
                subscribe: (listener: () => void) => {
                  timelineListeners.add(listener);
                  return () => timelineListeners.delete(listener);
                },
              };
            }
            if (id === "renderer.runtime") return renderer;
            return undefined;
          },
          require: (id: string) => {
            if (id === "playback.clock") return playbackClock;
            throw new Error(`missing ${id}`);
          },
          getRevision: () => 0,
          subscribe: (listener: () => void) => {
            directoryListeners.add(listener);
            return () => directoryListeners.delete(listener);
          },
          patchProperty: (
            target: object,
            property: PropertyKey,
            factory: (previous: PropertyDescriptor | undefined) => PropertyDescriptor,
          ) => patchManager.patchProperty(scope, target, property, factory),
        },
      },
      runtime: {
        react: {
          createElement,
          useState: <T,>(initial: T) => [initial, vi.fn()] as const,
          useSyncExternalStore: <T,>(
            subscribe: (listener: () => void) => () => void,
            getSnapshot: () => T,
          ) => {
            resources.push(subscribe(vi.fn()));
            return getSnapshot();
          },
        },
        mui: {
          Button: "button",
          Box: "box",
          Typography: "typography",
        },
      },
      ui: {
        registerComponent: (definition: { component: () => unknown }) => {
          registeredComponent = definition.component;
          return { id: "example.trusted-host-access/status", dispose: vi.fn() };
        },
      },
    } as unknown as VloExtensionApi;
    const context = {
      extension: scope.extension,
      sdkVersion: "1.3.0",
      signal: scope.signal,
      api,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      onDispose: scope.own,
    } satisfies ExtensionContext;

    await activate(context);
    expect(getRetainedRendererForConformance()).toBe(renderer);
    renderer = { id: "second" };
    for (const listener of directoryListeners) listener();
    expect(getRetainedRendererForConformance()).toBe(renderer);

    const panel = registeredComponent?.() as {
      children: readonly [{ children: readonly [string] }, { props: { onClick(): void } }];
    };
    expect(panel.children[0].children[0]).toContain("2 tracks");
    panel.children[1].props.onClick();
    expect(Reflect.get(playbackClock, "trustedHostFixture")).toBe("active");

    const remountedPanel = registeredComponent?.() as {
      children: readonly [
        { children: readonly [string] },
        { props: { disabled: boolean } },
      ];
    };
    expect(remountedPanel.children[0].children[0]).toContain("patch active");
    expect(remountedPanel.children[1].props.disabled).toBe(true);

    for (const resource of [...resources].reverse()) {
      if (typeof resource === "function") await resource();
      else await resource.dispose();
    }
    expect(Reflect.has(playbackClock, "trustedHostFixture")).toBe(false);
    expect(getRetainedRendererForConformance()).toBeUndefined();
    expect(directoryListeners).toHaveLength(0);
    expect(timelineListeners).toHaveLength(0);
  });

  it("reports the fixture's actionable incompatibility when the host shape drifts", () => {
    const directory = new TrustedHostAccessDirectory();
    directory.register({
      id: "timeline.store",
      lifetime: "session",
      getValue: () => ({ detached: true }),
      assertValue: () => false,
    });
    const scope = {
      extension: { id: "example.trusted-host-access", version: "1.0.0" },
      signal: new AbortController().signal,
      own: <TResource extends ExtensionResource>(resource: TResource) => resource,
      report: vi.fn(),
    };
    const host = directory.bind(scope, "0.2.0");

    expect(() =>
      activate({
        extension: scope.extension,
        sdkVersion: "1.3.0",
        signal: scope.signal,
        api: { trusted: { host } },
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        onDispose: vi.fn(),
      } as unknown as ExtensionContext),
    ).toThrow(
      "This extension requires trusted host entry 'timeline.store' from its supported VLO range.",
    );
    expect(scope.report).toHaveBeenCalledWith(
      "error",
      "Trusted host entry 'timeline.store' failed its host shape assertion.",
      expect.any(TypeError),
    );
  });
});
