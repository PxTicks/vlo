import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { createExtensionBackendApi } from "../createExtensionBackendApi";

function createScope(controller = new AbortController()): ExtensionApiScope {
  return {
    extension: { id: "example.tracker", version: "1.0.0" },
    signal: controller.signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: () => undefined,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function job(status: "running" | "succeeded") {
  return {
    jobId: "job-1",
    jobType: "track",
    extensionId: "example.tracker",
    extensionVersion: "1.0.0",
    status,
    progress: status === "running" ? 0.5 : 1,
    message: status === "running" ? "Tracking" : "Completed",
    cancelRequested: false,
    createdAt: 1,
    updatedAt: 2,
    ...(status === "succeeded"
      ? { result: { schemaVersion: 1, points: [] } }
      : {}),
    artifacts: [],
    diagnostics: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createExtensionBackendApi", () => {
  it("binds raw calls and standard requests to the activation owner", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("ok"))
      .mockResolvedValueOnce(
        jsonResponse({
          artifact: {
            artifactId: "a".repeat(32),
            role: "input",
            filename: "clip.mp4",
            contentType: "video/mp4",
            size: 4,
            sha256: "b".repeat(64),
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ job: job("running") }));
    const api = createExtensionBackendApi(createScope());

    await api.call("status");
    const artifact = await api.uploadArtifact(new Blob(["clip"]), {
      filename: "clip.mp4",
      contentType: "video/mp4",
    });
    await api.submitJob("track", { sampleCount: 4 }, [artifact.artifactId]);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/app/extensions/example.tracker/api/status",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/app/extensions/example.tracker/artifacts?filename=clip.mp4&contentType=video%2Fmp4",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/app/extensions/example.tracker/jobs/track",
    );
    expect(() => api.call("../other/status")).toThrow(/traversal/);
    expect(() => api.call("/other/status")).toThrow(/relative/);
  });

  it("polls to a terminal result and reports progress", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ job: job("running") }))
      .mockResolvedValueOnce(jsonResponse({ job: job("succeeded") }));
    const onProgress = vi.fn();
    const api = createExtensionBackendApi(createScope());

    const completed = await api.waitForJob("job-1", {
      pollIntervalMs: 10,
      onProgress,
    });

    expect(completed.status).toBe("succeeded");
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("aborts requests when the extension activation ends", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const api = createExtensionBackendApi(createScope(controller));
    const request = api.listJobs();
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
