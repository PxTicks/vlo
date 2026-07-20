import {
  getActivePixiApplication,
  subscribeActivePixiApplication,
} from "../../../core/pixi/activeApplication";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { getEditorFocusStoreForTrustedHostAccess } from "../../editorFocus";
import { useProjectStore } from "../../project";
import { getTimelineStoreForTrustedHostAccess } from "../../timeline/api";
import { getTimelineSelectionStoreForTrustedHostAccess } from "../../timelineSelection";
import { extensionTransformationRegistry } from "../../transformations/extensionApi";
import {
  getAssetBrowserSelectionStoreForTrustedHostAccess,
  getAssetStoreForTrustedHostAccess,
} from "../../userAssets";
import type { ExtensionHost } from "../ExtensionHost";
import type { ExtensionDisposable, VloExtensionApi } from "../types";
import {
  trustedHostAccessDirectory,
  type TrustedHostAccessDirectory,
} from "./TrustedHostAccessDirectory";

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null
  );
}

function hasFunctions(
  value: unknown,
  names: readonly string[],
): value is Record<PropertyKey, unknown> {
  return (
    isObject(value) &&
    names.every((name) => typeof value[name] === "function")
  );
}

const activeRegistrations = new WeakMap<
  TrustedHostAccessDirectory,
  ExtensionDisposable
>();

export function registerTrustedHostEntries(
  extensionHost: ExtensionHost<VloExtensionApi>,
  directory: TrustedHostAccessDirectory = trustedHostAccessDirectory,
): ExtensionDisposable {
  const activeRegistration = activeRegistrations.get(directory);
  if (activeRegistration) return activeRegistration;

  const cleanups: Array<() => void> = [];
  const register = (
    definition: Parameters<TrustedHostAccessDirectory["register"]>[0],
  ) => {
    const registration = directory.register(definition);
    cleanups.push(() => {
      void registration.dispose();
    });
  };
  const disposeCleanups = () => {
    for (const cleanup of [...cleanups].reverse()) cleanup();
  };

  try {
    register({
      id: "timeline.store",
      lifetime: "session",
      getValue: getTimelineStoreForTrustedHostAccess,
      assertValue: (value) =>
        hasFunctions(value, ["getState", "setState", "subscribe"]),
    });
    register({
      id: "playback.clock",
      lifetime: "session",
      getValue: () => playbackClock,
      assertValue: (value) => {
        if (!hasFunctions(value, ["setTime", "subscribe"])) return false;
        return typeof value.time === "number";
      },
    });
    register({
      id: "project.store",
      lifetime: "session",
      getValue: () => useProjectStore,
      assertValue: (value) =>
        hasFunctions(value, ["getState", "setState", "subscribe"]),
    });
    register({
      id: "userAssets.store",
      lifetime: "session",
      getValue: getAssetStoreForTrustedHostAccess,
      assertValue: (value) =>
        hasFunctions(value, ["getState", "setState", "subscribe"]),
    });
    register({
      id: "editor.focusStore",
      lifetime: "session",
      getValue: getEditorFocusStoreForTrustedHostAccess,
      assertValue: (value) =>
        hasFunctions(value, ["getState", "setState", "subscribe"]),
    });
    register({
      id: "timeline.selectionStore",
      lifetime: "session",
      getValue: getTimelineSelectionStoreForTrustedHostAccess,
      assertValue: (value) =>
        hasFunctions(value, ["getState", "setState", "subscribe"]),
    });
    register({
      id: "library.selectionStore",
      lifetime: "session",
      getValue: getAssetBrowserSelectionStoreForTrustedHostAccess,
      assertValue: (value) =>
        hasFunctions(value, ["getState", "setState", "subscribe"]),
    });
    register({
      id: "transformations.registry",
      lifetime: "session",
      getValue: () => extensionTransformationRegistry,
      assertValue: (value) =>
        hasFunctions(value, ["listDefinitions", "subscribe", "getRevision"]),
    });
    register({
      id: "extensions.runtime",
      lifetime: "session",
      getValue: () => extensionHost,
      assertValue: (value) =>
        hasFunctions(value, [
          "activate",
          "deactivate",
          "listStates",
          "getDiagnostics",
        ]),
    });
    register({
      id: "renderer.runtime",
      lifetime: "availability",
      getValue: getActivePixiApplication,
      assertValue: (value) =>
        isObject(value) && isObject(value.renderer) && isObject(value.stage),
    });
    cleanups.push(
      subscribeActivePixiApplication(() => {
        directory.notifyAvailabilityChanged();
      }),
    );
  } catch (error) {
    disposeCleanups();
    throw error;
  }

  let disposed = false;
  const registration = Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeCleanups();
      activeRegistrations.delete(directory);
    },
  });
  activeRegistrations.set(directory, registration);
  return registration;
}
