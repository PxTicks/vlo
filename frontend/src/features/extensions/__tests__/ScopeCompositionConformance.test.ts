import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The renderer front door boots Pixi at import time; the consumer fixture only
// needs the one frame-capture entry point behind `api.export.renderFrame`.
vi.mock("../../renderer", () => ({
  renderProjectFrameAtTick: vi.fn(),
}));

import type {
  ExtensionApiScope,
  ExtensionResource,
  VloExtensionApi,
} from "../types";
import {
  activate as activateFalseColor,
  classifyLuma,
  falseColorApi,
  renderFalseColor,
} from "../../../../../extension-fixtures/false-color/frontend/src/index";
import {
  activate as activateExposureReport,
  averageLuma,
  decodeFrameRgba,
  FALSE_COLOR_EXTENSION_ID,
  getExposureReportStateForConformance,
  resetExposureReportStateForConformance,
  SCANNED_CONTEXT_KEY,
} from "../../../../../extension-fixtures/exposure-report/frontend/src/index";
import { HostCommandTable } from "../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../core/shell/contextKeys";
import { HostKeybindingRegistry } from "../../../core/shell/keybindingRegistry";
import { HostNotificationCenter } from "../../../core/shell/notificationCenter";
import { HostViewRegistry } from "../../../core/shell/viewRegistry";
import { installHostExportController } from "../../../core/export/exportController";
import { resetExportRunLogForTests } from "../../../core/export/exportRunLog";
import { renderProjectFrameAtTick } from "../../renderer";
import { HostScopeRegistry, registerHostScopes } from "../../scopes";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { useProjectStore } from "../../project";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { createExtensionCommandApi } from "../commands/CommandRegistry";
import { createExtensionExportApi } from "../export/createExtensionExportApi";
import { createExtensionNotificationApi } from "../ui/createExtensionNotificationApi";
import { createExtensionScopeApi } from "../scopes/createExtensionScopeApi";
import { createExtensionTimelineApi } from "../timeline/createExtensionTimelineApi";
import { createExtensionViewApi } from "../views/createExtensionViewApi";
import { ExtensionPeerRegistry } from "../peers/ExtensionPeerRegistry";

const PROVIDER_ID = "example.false-color";
const CONSUMER_ID = "example.exposure-report";
const TICKS_PER_SECOND = 96_000;

function videoClip(id: string, start: number, duration: number): TimelineClip {
  return {
    id,
    trackId: "track-visual",
    type: "video",
    name: id,
    assetId: "asset-1",
    src: "asset-1.mp4",
    sourceDuration: duration,
    start,
    timelineDuration: duration,
    offset: 0,
    transformedDuration: duration,
    transformedOffset: 0,
    croppedSourceDuration: duration,
    transformations: [],
  } as unknown as TimelineClip;
}

const TRACKS: TimelineTrack[] = [
  {
    id: "track-visual",
    label: "Visual",
    type: "visual",
    isVisible: true,
    isLocked: false,
    isMuted: false,
  },
];

/**
 * Uniform opaque RGBA frame bytes at a given luma. Fully opaque, so the same
 * bytes read correctly as the scope's premultiplied sample and as a decoded
 * frame's straight alpha.
 */
function solidFrame(luma: number, pixelCount = 4): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(pixelCount * 4);
  const level = Math.round(luma * 255);
  for (let index = 0; index < pixelCount; index += 1) {
    pixels[index * 4] = level;
    pixels[index * 4 + 1] = level;
    pixels[index * 4 + 2] = level;
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

interface StubBitmap {
  readonly width: number;
  readonly height: number;
  readonly luma: number;
  close(): void;
}

/**
 * Stands in for the browser's image decoder so the fixture's real
 * `createImageBitmap` + canvas path runs under jsdom, which implements neither.
 *
 * The encoded blob deliberately carries bytes that are *not* the picture: read
 * straight as RGBA they report mid-grey for every clip, so a fixture that went
 * back to `blob.arrayBuffer()` would classify both clips the same and fail the
 * assertions below rather than quietly passing.
 */
function installDecodeHarness() {
  const lumaByBlob = new Map<Blob, number>();
  const decodedBlobs: Blob[] = [];
  const counts = { closed: 0, drawn: 0 };
  let drawnLuma = 0;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  globalThis.createImageBitmap = (async (source: Blob): Promise<StubBitmap> => {
    decodedBlobs.push(source);
    const luma = lumaByBlob.get(source);
    if (luma === undefined) throw new Error("Not an image this test encoded.");
    return {
      width: 2,
      height: 2,
      luma,
      close: () => {
        counts.closed += 1;
      },
    };
  }) as unknown as typeof createImageBitmap;

  HTMLCanvasElement.prototype.getContext = function stubGetContext() {
    return {
      drawImage: (bitmap: StubBitmap) => {
        counts.drawn += 1;
        drawnLuma = bitmap.luma;
      },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: solidFrame(drawnLuma, width * height),
      }),
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  return {
    decodedBlobs,
    counts,
    /** An encoded blob whose bytes decode to `luma` but do not *contain* it. */
    encodeFrame: (luma: number): Blob => {
      const blob = new Blob([new Uint8Array([0x80, 0x80, 0x80, 0xff])], {
        type: "image/png",
      });
      lumaByBlob.set(blob, luma);
      return blob;
    },
    restore: () => {
      globalThis.createImageBitmap = originalCreateImageBitmap;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    },
  };
}

interface Harness {
  readonly api: VloExtensionApi;
  readonly scope: ExtensionApiScope;
  readonly report: ReturnType<typeof vi.fn>;
  dispose(): Promise<void>;
}

interface Registries {
  readonly peers: ExtensionPeerRegistry;
  readonly scopes: HostScopeRegistry;
  readonly notifications: HostNotificationCenter;
  readonly contextKeys: HostContextKeyService;
  readonly views: HostViewRegistry;
  readonly commands: HostCommandTable;
  readonly keybindings: HostKeybindingRegistry;
}

function createRegistries(): Registries {
  const contextKeys = new HostContextKeyService();
  contextKeys.set("project.open", true);
  return {
    peers: new ExtensionPeerRegistry(),
    scopes: new HostScopeRegistry(),
    notifications: new HostNotificationCenter(),
    contextKeys,
    views: new HostViewRegistry(contextKeys, null),
    commands: new HostCommandTable(contextKeys),
    keybindings: new HostKeybindingRegistry(() => false),
  };
}

function createHarness(
  registries: Registries,
  extensionId: string,
): Harness {
  const resources: ExtensionResource[] = [];
  const report = vi.fn();
  const scope: ExtensionApiScope = {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report,
  };

  const api = {
    extensions: registries.peers.bind(scope),
    timeline: createExtensionTimelineApi(scope),
    export: createExtensionExportApi(scope),
    ui: {
      ...createExtensionViewApi(scope, registries.views),
      commands: createExtensionCommandApi(
        scope,
        registries.commands,
        registries.keybindings,
        registries.contextKeys,
      ),
      notifications: createExtensionNotificationApi(
        scope,
        registries.notifications,
      ),
      scopes: createExtensionScopeApi(scope, registries.scopes),
    },
  } as unknown as VloExtensionApi;

  return {
    api,
    scope,
    report,
    dispose: async () => {
      for (const resource of [...resources].reverse()) {
        await (typeof resource === "function" ? resource() : resource.dispose());
      }
    },
  };
}

function activateFixture(
  harness: Harness,
  activateModule: typeof activateFalseColor,
): ExtensionResource[] {
  const disposers: ExtensionResource[] = [];
  const exported: { value?: object } = {};
  const result = activateModule({
    extension: harness.scope.extension,
    sdkVersion: "1.13.0",
    signal: harness.scope.signal,
    api: harness.api,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onDispose: (resource) => disposers.push(resource),
    exportApi: (api: object) => {
      exported.value = api;
    },
  });
  void result;
  if (exported.value) {
    // Stands in for the host, which publishes only after activation succeeds.
    harnessRegistries.peers.publishApi(harness.scope.extension.id, exported.value);
  }
  harnessRegistries.peers.markActive(harness.scope.extension.id);
  return disposers;
}

let harnessRegistries: Registries;

describe("scope composition conformance fixtures", () => {
  beforeEach(() => {
    harnessRegistries = createRegistries();
    resetExportRunLogForTests();
    resetExposureReportStateForConformance();
    useTimelineStore.setState({
      tracks: TRACKS,
      clips: [
        videoClip("clip-a", 0, TICKS_PER_SECOND),
        videoClip("clip-b", TICKS_PER_SECOND, TICKS_PER_SECOND),
      ],
      transitions: [],
      selectedClipIds: [],
      selectedTransitionId: null,
    });
  });

  afterEach(() => {
    useProjectStore.setState({ project: null, rootHandle: null });
    vi.mocked(renderProjectFrameAtTick).mockReset();
  });

  it("puts a contributed scope in the same table as the host's own", async () => {
    registerHostScopes(harnessRegistries.scopes);
    const provider = createHarness(harnessRegistries, PROVIDER_ID);
    const disposers = activateFixture(provider, activateFalseColor);

    const ids = harnessRegistries.scopes.list().map((scope) => scope.id);
    expect(ids).toContain("host.waveform");
    expect(ids).toContain(`${PROVIDER_ID}/false-color`);
    // Ordering is one comparison over one table, not host-first then extras.
    expect(ids.indexOf(`${PROVIDER_ID}/false-color`)).toBe(ids.length - 1);

    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await provider.dispose();
    expect(harnessRegistries.scopes.get(`${PROVIDER_ID}/false-color`)).toBeUndefined();
    expect(harnessRegistries.scopes.list()).toHaveLength(4);
  });

  it("isolates a throwing contributed scope and reports it once", () => {
    const provider = createHarness(harnessRegistries, PROVIDER_ID);
    provider.api.ui.scopes.register({
      id: "broken",
      apiVersion: 1,
      kind: "trusted-scope",
      label: "Broken",
      width: 32,
      height: 32,
      render: () => {
        throw new Error("bad draw");
      },
    });
    const entry = harnessRegistries.scopes.get(`${PROVIDER_ID}/broken`);
    const target = {
      context: {} as CanvasRenderingContext2D,
      width: 32,
      height: 32,
      frame: { pixels: solidFrame(0.5), width: 2, height: 2, sampledAt: 0 },
    };

    // The sampler runs several times a second, so a scope failing every frame
    // must not flood the diagnostics buffer it shares with activation.
    expect(() => entry?.render(target)).not.toThrow();
    expect(() => entry?.render(target)).not.toThrow();
    expect(provider.report).toHaveBeenCalledTimes(1);
    expect(provider.report).toHaveBeenCalledWith(
      "error",
      `Scope '${PROVIDER_ID}/broken' failed to render.`,
      expect.any(Error),
    );
  });

  it("classifies frames through the provider's exported vocabulary", async () => {
    const provider = createHarness(harnessRegistries, PROVIDER_ID);
    harnessRegistries.peers.declarePackage({
      id: PROVIDER_ID,
      version: "1.2.0",
      dependencies: {},
    });
    harnessRegistries.peers.declarePackage({
      id: CONSUMER_ID,
      version: "1.0.0",
      dependencies: { [FALSE_COLOR_EXTENSION_ID]: ">=1.2.0 <2.0.0" },
    });
    activateFixture(provider, activateFalseColor);

    const consumer = createHarness(harnessRegistries, CONSUMER_ID);
    const disposers = activateFixture(consumer, activateExposureReport);
    expect(getExposureReportStateForConformance().peerApiVersion).toBe(
      falseColorApi.apiVersion,
    );

    useProjectStore.setState({
      project: {
        id: "project-1",
        title: "Fixture project",
        rootAssetsFolder: "assets",
        createdAt: 10,
        lastModified: 20,
      },
      rootHandle: {} as FileSystemDirectoryHandle,
    });
    installHostExportController({
      canStart: () => true,
      startRange: () => "unused",
      cancel: () => undefined,
    });
    // Two clips at deliberately different exposures, so the report proves the
    // classification came from the peer rather than from a constant.
    const lumas = [0.02, 0.98];
    const decode = installDecodeHarness();
    const encodedBlobs: Blob[] = [];
    let call = 0;
    vi.mocked(renderProjectFrameAtTick).mockImplementation(async () => {
      const blob = decode.encodeFrame(lumas[call++] ?? 0.5);
      encodedBlobs.push(blob);
      return { blob, width: 2, height: 2, timeTicks: 0 };
    });

    try {
      await harnessRegistries.commands
        .getEntry(`${CONSUMER_ID}/scan-exposure`)
        ?.run({ source: "api" });
    } finally {
      decode.restore();
    }

    expect(getExposureReportStateForConformance().rows).toEqual([
      { timeTicks: 0, zone: classifyLuma(0.02).name },
      { timeTicks: TICKS_PER_SECOND, zone: classifyLuma(0.98).name },
    ]);
    // The blob went to the decoder rather than being read as raw pixels, and
    // every decoded bitmap was released.
    expect(decode.decodedBlobs).toEqual(encodedBlobs);
    expect(decode.counts).toEqual({ drawn: 2, closed: 2 });
    // The task settles into a toast rather than lingering as progress.
    const entries = harnessRegistries.notifications.listByOwner(CONSUMER_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "toast", tone: "success" });

    // The namespaced key is readable by anyone; only its owner may write it.
    const qualified = `extension.${CONSUMER_ID}.${SCANNED_CONTEXT_KEY}`;
    expect(harnessRegistries.contextKeys.get(qualified)).toBe(2);
    expect(provider.api.ui.commands.getContextKey(qualified)).toBe(2);

    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await consumer.dispose();
    // Deactivation takes the key and the notification with it.
    expect(harnessRegistries.contextKeys.get(qualified)).toBeUndefined();
    expect(harnessRegistries.notifications.listByOwner(CONSUMER_ID)).toEqual([]);
  });

  it("refuses a peer the manifest did not declare", () => {
    harnessRegistries.peers.declarePackage({
      id: CONSUMER_ID,
      version: "1.0.0",
      dependencies: {},
    });
    const consumer = createHarness(harnessRegistries, CONSUMER_ID);
    expect(() => consumer.api.extensions.getApi(PROVIDER_ID)).toThrow(
      /did not declare/,
    );
  });

  it("draws exposure bands from the host's own premultiplied sample", () => {
    const written: ImageData[] = [];
    const imageData = {
      data: new Uint8ClampedArray(4 * 4),
    } as unknown as ImageData;
    const context = {
      createImageData: () => imageData,
      putImageData: (image: ImageData) => written.push(image),
    } as unknown as CanvasRenderingContext2D;

    renderFalseColor({
      context,
      width: 2,
      height: 2,
      frame: { pixels: solidFrame(0.98), width: 2, height: 2, sampledAt: 0 },
    });

    expect(written).toHaveLength(1);
    const clipped = classifyLuma(0.98);
    expect([...imageData.data.slice(0, 4)]).toEqual([...clipped.color, 255]);
    expect(averageLuma(solidFrame(0.5))).toBeCloseTo(0.5, 2);
  });

  it("measures decoded frames as straight alpha, not premultiplied", () => {
    // Half-transparent mid-grey as `getImageData` reports it: the colour is
    // already un-premultiplied, so dividing by alpha again would read 1.0.
    const pixels = new Uint8ClampedArray([128, 128, 128, 128, 0, 0, 0, 0]);
    expect(averageLuma(pixels)).toBeCloseTo(128 / 255, 2);
    // Fully transparent pixels carry no exposure information at all.
    expect(averageLuma(new Uint8ClampedArray([255, 255, 255, 0]))).toBe(0);
  });
});

describe("exposure report frame decoding", () => {
  const encoded = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });

  it("decodes through a canvas and releases the bitmap", async () => {
    const decode = installDecodeHarness();
    try {
      const blob = decode.encodeFrame(0.5);
      const pixels = await decodeFrameRgba(blob);
      expect(pixels).not.toBeNull();
      expect(averageLuma(pixels as Uint8ClampedArray)).toBeCloseTo(0.5, 2);
      expect(decode.decodedBlobs).toEqual([blob]);
      expect(decode.counts).toEqual({ drawn: 1, closed: 1 });
    } finally {
      decode.restore();
    }
  });

  it("gives up rather than throwing when the image cannot be decoded", async () => {
    const decode = installDecodeHarness();
    try {
      // A blob the harness never encoded: `createImageBitmap` rejects, exactly
      // as it would for a truncated or unsupported image.
      await expect(decodeFrameRgba(encoded)).resolves.toBeNull();
      expect(decode.counts.closed).toBe(0);
    } finally {
      decode.restore();
    }
  });

  it("releases the bitmap even when no 2D context is available", async () => {
    const decode = installDecodeHarness();
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext =
      (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      await expect(decodeFrameRgba(decode.encodeFrame(0.5))).resolves.toBeNull();
      expect(decode.counts.closed).toBe(1);
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      decode.restore();
    }
  });

  it("reports no pixels on a host without an image decoder", async () => {
    const original = globalThis.createImageBitmap;
    // @ts-expect-error deliberately removing a browser global for this case
    delete globalThis.createImageBitmap;
    try {
      await expect(decodeFrameRgba(encoded)).resolves.toBeNull();
    } finally {
      globalThis.createImageBitmap = original;
    }
  });
});
