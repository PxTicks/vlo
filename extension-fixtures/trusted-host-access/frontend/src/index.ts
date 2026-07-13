import type {
  ExtensionDisposable,
  ExtensionModule,
  ExtensionReactRuntime,
  ExtensionTrustedHostApi,
} from "@vlo/extension-sdk";

interface TimelineStore {
  getState(): { readonly tracks?: readonly unknown[] };
  subscribe(listener: () => void): () => void;
}

interface ReactHooksRuntime extends ExtensionReactRuntime {
  useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void];
  useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
  ): T;
}

type HostComponent = (props: Readonly<Record<string, unknown>>) => unknown;

function isTimelineStore(value: unknown): value is TimelineStore {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "getState" in value &&
    typeof value.getState === "function" &&
    "subscribe" in value &&
    typeof value.subscribe === "function"
  );
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function requireTimelineStore(host: ExtensionTrustedHostApi): TimelineStore {
  const store = host.get("timeline.store");
  if (!isTimelineStore(store)) {
    throw new Error(
      "This extension requires trusted host entry 'timeline.store' from its supported VLO range.",
    );
  }
  return store;
}

let retainedRenderer: unknown;

export function getRetainedRendererForConformance(): unknown {
  return retainedRenderer;
}

export const activate: ExtensionModule["activate"] = (context) => {
  const host = context.api.trusted.host;
  const timelineStore = requireTimelineStore(host);
  const playbackClock = host.require("playback.clock");
  if (!isObject(playbackClock)) {
    throw new Error("Trusted host entry 'playback.clock' has an unexpected shape.");
  }
  const playbackClockTarget: object = playbackClock;

  const resolveRenderer = () => {
    retainedRenderer = host.get("renderer.runtime");
  };
  resolveRenderer();
  context.onDispose(host.subscribe(resolveRenderer));
  context.onDispose(() => {
    retainedRenderer = undefined;
  });

  const React = context.api.runtime.react as ReactHooksRuntime;
  const Button = context.api.runtime.mui.Button as HostComponent;
  const Box = context.api.runtime.mui.Box as HostComponent;
  const Typography = context.api.runtime.mui.Typography as HostComponent;
  let activePatch: ExtensionDisposable | undefined;

  function TrustedHostFixturePanel(): unknown {
    const [, setPatchRevision] = React.useState(0);
    const patched = activePatch !== undefined;
    const trackCount = React.useSyncExternalStore(
      timelineStore.subscribe,
      () => timelineStore.getState().tracks?.length ?? 0,
    );
    const installPatch = () => {
      if (activePatch) return;
      activePatch = host.patchProperty(
        playbackClockTarget,
        "trustedHostFixture",
        () => ({
          configurable: true,
          enumerable: false,
          writable: false,
          value: "active",
        }),
      );
      setPatchRevision((revision) => revision + 1);
    };

    return React.createElement(
      Box,
      { sx: { display: "flex", alignItems: "center", gap: 1 } },
      React.createElement(
        Typography,
        { variant: "caption" },
        `Trusted fixture · ${trackCount} tracks · patch ${patched ? "active" : "inactive"}`,
      ),
      React.createElement(
        Button,
        { size: "small", variant: "outlined", disabled: patched, onClick: installPatch },
        "Apply benign patch",
      ),
    );
  }

  context.api.ui.registerComponent({
    id: "status",
    apiVersion: 1,
    slot: "timeline.toolbar",
    kind: "trusted-react",
    component: TrustedHostFixturePanel,
  });
};
