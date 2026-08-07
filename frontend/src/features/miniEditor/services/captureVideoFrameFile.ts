const DEFAULT_VIDEO_OPERATION_TIMEOUT_MS = 5_000;
const SEEK_EPSILON_SECONDS = 0.001;

interface CaptureVideoFrameOptions {
  timeoutMs?: number;
  fallbackWidth?: number;
  fallbackHeight?: number;
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  event: "loadeddata" | "seeked",
  errorMessage: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`${errorMessage} (timed out).`));
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timeout);
      video.removeEventListener(event, handleSuccess);
      video.removeEventListener("error", handleError);
    }

    function handleSuccess() {
      cleanup();
      resolve();
    }

    function handleError() {
      cleanup();
      reject(new Error(errorMessage));
    }

    video.addEventListener(event, handleSuccess, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

/**
 * Captures a PNG from a video URL. The caller retains ownership of the URL;
 * the temporary media element is always detached from it before returning.
 */
export async function captureVideoFrameFile(
  videoUrl: string,
  atSeconds: number,
  filename: string,
  options: CaptureVideoFrameOptions = {},
): Promise<File> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIDEO_OPERATION_TIMEOUT_MS;
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";

  try {
    const loaded = waitForVideoEvent(
      video,
      "loadeddata",
      "Could not decode the video.",
      timeoutMs,
    );
    video.src = videoUrl;
    video.load();
    await loaded;

    const max = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - SEEK_EPSILON_SECONDS)
      : 0;
    const target = Math.min(Math.max(0, atSeconds), max);

    // Browsers do not consistently emit `seeked` for a no-op assignment.
    if (Math.abs(video.currentTime - target) > SEEK_EPSILON_SECONDS) {
      const seeked = waitForVideoEvent(
        video,
        "seeked",
        "Could not seek to the selected video frame.",
        timeoutMs,
      );
      video.currentTime = target;
      await seeked;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || options.fallbackWidth || 320;
    canvas.height = video.videoHeight || options.fallbackHeight || 180;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a canvas for video frame capture.");
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) {
      throw new Error("Could not encode the selected video frame.");
    }

    return new File([blob], filename, {
      type: "image/png",
      lastModified: Date.now(),
    });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}
