// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureVideoFrameFile,
  probeVideoDurationTicks,
} from "../browserVideo";

function installMediaElements(options: {
  currentTime: number;
  duration?: number;
  emitSeeked?: boolean;
  loadEvent?: "loadeddata" | "loadedmetadata";
}) {
  const video = document.createElement("video");
  let currentTime = options.currentTime;
  Object.defineProperties(video, {
    duration: { configurable: true, value: options.duration ?? 10 },
    videoWidth: { configurable: true, value: 640 },
    videoHeight: { configurable: true, value: 360 },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        if (options.emitSeeked) {
          queueMicrotask(() => video.dispatchEvent(new Event("seeked")));
        }
      },
    },
  });
  const loadEvent = options.loadEvent ?? "loadeddata";
  const load = vi.fn(() => {
    queueMicrotask(() => video.dispatchEvent(new Event(loadEvent)));
  });
  const pause = vi.fn();
  Object.defineProperties(video, {
    load: { configurable: true, value: load },
    pause: { configurable: true, value: pause },
  });
  const removeAttribute = vi.spyOn(video, "removeAttribute");

  const canvas = document.createElement("canvas");
  const drawImage = vi.fn();
  Object.defineProperties(canvas, {
    getContext: {
      configurable: true,
      value: vi.fn(() => ({ drawImage })),
    },
    toBlob: {
      configurable: true,
      value: vi.fn((callback: BlobCallback) =>
        callback(new Blob(["png"], { type: "image/png" })),
      ),
    },
  });

  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(
    ((tagName: string, creationOptions?: ElementCreationOptions) => {
      if (tagName === "video") return video;
      if (tagName === "canvas") return canvas;
      return createElement(tagName, creationOptions);
    }) as typeof document.createElement,
  );

  return { drawImage, load, pause, removeAttribute };
}

describe("browser video utilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("captures the initial frame without waiting for a no-op seek event", async () => {
    const media = installMediaElements({ currentTime: 0 });

    const file = await captureVideoFrameFile(
      "blob:video",
      0,
      "frame.png",
      { timeoutMs: 20 },
    );

    expect(file).toMatchObject({ name: "frame.png", type: "image/png" });
    expect(media.drawImage).toHaveBeenCalledOnce();
    expect(media.pause).toHaveBeenCalledOnce();
    expect(media.removeAttribute).toHaveBeenCalledWith("src");
    expect(media.load).toHaveBeenCalledTimes(2);
  });

  it("times out an uncompleted seek and still tears down the video", async () => {
    vi.useFakeTimers();
    const media = installMediaElements({ currentTime: 0 });

    const capture = captureVideoFrameFile("blob:video", 2, "frame.png", {
      timeoutMs: 50,
    });
    const rejection = expect(capture).rejects.toThrow(/seek.*timed out/i);
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(media.pause).toHaveBeenCalledOnce();
    expect(media.removeAttribute).toHaveBeenCalledWith("src");
  });

  it("probes duration and releases the metadata element", async () => {
    const media = installMediaElements({
      currentTime: 0,
      duration: 2.5,
      loadEvent: "loadedmetadata",
    });

    await expect(probeVideoDurationTicks("blob:video")).resolves.toBe(240_000);
    expect(media.pause).toHaveBeenCalledOnce();
    expect(media.removeAttribute).toHaveBeenCalledWith("src");
    expect(media.load).toHaveBeenCalledTimes(2);
  });
});
