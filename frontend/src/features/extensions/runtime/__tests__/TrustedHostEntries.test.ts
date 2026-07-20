import { describe, expect, it } from "vitest";
import type { Application } from "pixi.js";
import {
  clearActivePixiApplication,
  setActivePixiApplication,
} from "../../../../core/pixi/activeApplication";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { useEditorFocusStore } from "../../../editorFocus";
import { useProjectStore } from "../../../project";
import { useTimelineSelectionStore } from "../../../timelineSelection";
import { useTimelineStore } from "../../../timeline/useTimelineStore";
import { extensionTransformationRegistry } from "../../../transformations/extensionApi";
import {
  useAssetBrowserSelectionStore,
  useAssetStore,
} from "../../../userAssets";
import { ExtensionHost } from "../../ExtensionHost";
import type { VloExtensionApi } from "../../types";
import { createVloExtensionApi } from "../../services/FrontendExtensionRuntime";
import {
  TrustedHostAccessDirectory,
  trustedHostAccessDirectory,
} from "../TrustedHostAccessDirectory";
import { registerTrustedHostEntries } from "../registerTrustedHostEntries";

describe("trusted host composition roots", () => {
  it("publishes canonical session identities with host shape assertions", () => {
    expect(trustedHostAccessDirectory.get("timeline.store")).toBe(useTimelineStore);
    expect(trustedHostAccessDirectory.get("playback.clock")).toBe(playbackClock);
    expect(trustedHostAccessDirectory.get("project.store")).toBe(useProjectStore);
    expect(trustedHostAccessDirectory.get("userAssets.store")).toBe(useAssetStore);
    expect(trustedHostAccessDirectory.get("editor.focusStore")).toBe(
      useEditorFocusStore,
    );
    expect(trustedHostAccessDirectory.get("timeline.selectionStore")).toBe(
      useTimelineSelectionStore,
    );
    expect(trustedHostAccessDirectory.get("library.selectionStore")).toBe(
      useAssetBrowserSelectionStore,
    );
    expect(trustedHostAccessDirectory.get("transformations.registry")).toBe(
      extensionTransformationRegistry,
    );
    expect(trustedHostAccessDirectory.get("extensions.runtime")).toBeDefined();
    expect(
      trustedHostAccessDirectory.list().map((entry) => entry.id),
    ).toEqual([
      "timeline.store",
      "playback.clock",
      "project.store",
      "userAssets.store",
      "editor.focusStore",
      "timeline.selectionStore",
      "library.selectionStore",
      "transformations.registry",
      "extensions.runtime",
      "renderer.runtime",
    ]);
  });

  it("invalidates and re-resolves the mount-scoped renderer identity", () => {
    const first = { renderer: {}, stage: {} } as Application;
    const second = { renderer: {}, stage: {} } as Application;
    const initialRevision = trustedHostAccessDirectory.getRevision();

    setActivePixiApplication(first);
    expect(trustedHostAccessDirectory.get("renderer.runtime")).toBe(first);
    clearActivePixiApplication(first);
    expect(trustedHostAccessDirectory.get("renderer.runtime")).toBeUndefined();
    setActivePixiApplication(second);
    expect(trustedHostAccessDirectory.get("renderer.runtime")).toBe(second);
    expect(trustedHostAccessDirectory.getRevision()).toBe(initialRevision + 3);
    clearActivePixiApplication(second);
  });

  it("retains teardown and can register again after disposal", () => {
    const directory = new TrustedHostAccessDirectory();
    const host = new ExtensionHost<VloExtensionApi>({
      sdkVersion: "1.0.0",
      createApi: createVloExtensionApi,
    });
    const registration = registerTrustedHostEntries(host, directory);

    expect(registerTrustedHostEntries(host, directory)).toBe(registration);
    expect(directory.list()).toHaveLength(10);
    registration.dispose();
    expect(directory.list()).toEqual([]);

    const revisionAfterDisposal = directory.getRevision();
    const application = { renderer: {}, stage: {} } as Application;
    setActivePixiApplication(application);
    expect(directory.getRevision()).toBe(revisionAfterDisposal);
    clearActivePixiApplication(application);

    const nextRegistration = registerTrustedHostEntries(host, directory);
    expect(nextRegistration).not.toBe(registration);
    expect(directory.list()).toHaveLength(10);
    nextRegistration.dispose();
  });
});
