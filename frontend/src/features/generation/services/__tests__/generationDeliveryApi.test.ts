import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockResponse, stubFetch } from "../../../../testUtils/fetch";
import {
  fetchDeliveryFileAsFile,
  getPendingDeliveries,
  parseGenerationDeliveryMessage,
} from "../generationDeliveryApi";

describe("generationDeliveryApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches pending deliveries using an encoded project id", async () => {
    const deliveries = [{ delivery_id: "delivery-1" }];
    const fetchMock = stubFetch(createMockResponse({ json: { deliveries } }));

    await expect(getPendingDeliveries("project / one")).resolves.toEqual(
      deliveries,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/app/generation-delivery/projects/project%20%2F%20one/pending",
    );
  });

  it("normalizes a missing deliveries array and reports request errors", async () => {
    stubFetch(
      createMockResponse({ json: {} }),
      createMockResponse({ status: 500, text: "backend unavailable" }),
      createMockResponse({ status: 404, text: "" }),
    );

    await expect(getPendingDeliveries("p1")).resolves.toEqual([]);
    await expect(getPendingDeliveries("p1")).rejects.toThrow(
      "Pending deliveries fetch failed: backend unavailable",
    );
    await expect(getPendingDeliveries("p1")).rejects.toThrow(
      "Pending deliveries fetch failed (404)",
    );
  });

  it("returns null for an absent file reference", async () => {
    await expect(fetchDeliveryFileAsFile(null)).resolves.toBeNull();
    await expect(fetchDeliveryFileAsFile(undefined)).resolves.toBeNull();
  });

  it("downloads a delivery file and applies manifest metadata", async () => {
    const blob = new Blob(["video"], { type: "application/octet-stream" });
    const fetchMock = stubFetch(createMockResponse({ blob }));

    const file = await fetchDeliveryFileAsFile({
      filename: "result.mp4",
      download_url: "/download/result",
      mime_type: "video/mp4",
    });

    expect(fetchMock).toHaveBeenCalledWith("/download/result");
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({ name: "result.mp4", type: "video/mp4" });
  });

  it("falls back to the blob MIME type and handles download failures", async () => {
    stubFetch(
      createMockResponse({
        blob: new Blob(["image"], { type: "image/png" }),
      }),
      createMockResponse({ status: 403, text: "forbidden" }),
    );

    const file = await fetchDeliveryFileAsFile({
      filename: "preview.png",
      download_url: "/preview",
    });
    expect(file?.type).toBe("image/png");
    await expect(
      fetchDeliveryFileAsFile({
        filename: "blocked",
        download_url: "/blocked",
      }),
    ).rejects.toThrow("Delivery file fetch failed: forbidden");
  });

  it.each([
    ["lease_state", { project_id: "p1", active: true }],
    ["snapshot", { project_id: "p1", deliveries: [] }],
    ["delivery_update", { delivery: { delivery_id: "d1" } }],
    ["delivery_removed", { delivery_id: "d1" }],
  ])("parses supported %s messages", (type, data) => {
    expect(
      parseGenerationDeliveryMessage(JSON.stringify({ type, data })),
    ).toEqual({ type, data });
  });

  it.each([
    "",
    "not json",
    "[]",
    "{}",
    '{"type":"unknown","data":{}}',
    '{"type":"snapshot","data":null}',
  ])("rejects malformed delivery messages", (raw) => {
    expect(parseGenerationDeliveryMessage(raw)).toBeNull();
  });
});
