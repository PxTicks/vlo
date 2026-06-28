import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveExtensionDigest,
  disableExtension,
  fetchExtensionInventory,
  prefixExtensionFrontendEntryUrl,
  revokeExtensionApproval,
} from "../extensionManagementApi";

const originalFetch = globalThis.fetch;

function inventoryItem(status = "pending_approval") {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    id: "example.test",
    sourcePath: "/extensions/example.test",
    status,
    digest,
    errors: [],
    manifest: {
      manifestVersion: 1,
      id: "example.test",
      name: "Example Test",
      version: "1.0.0",
      sdk: ">=1.0.0 <2.0.0",
      frontend: { entry: "frontend/dist/index.js" },
      capabilities: ["timeline.read"],
    },
    approval:
      status === "approved"
        ? {
            digest,
            version: "1.0.0",
            approvedAt: 10,
            enabled: true,
          }
        : null,
    backendRuntime: {
      status: "not_declared",
      message: "No backend entry point is declared.",
      digest: null,
    },
    frontendEntryUrl:
      status === "approved"
        ? `/app/extensions/example.test/frontend/${digest}/index.js`
        : null,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("extensionManagementApi", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads and validates the inert extension inventory", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ extensions: [inventoryItem()] }),
    );

    const items = await fetchExtensionInventory();

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("example.test");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/app/extensions",
      undefined,
    );
  });

  it("prefixes backend artifact paths for sub-path deployments", () => {
    expect(
      prefixExtensionFrontendEntryUrl(
        "/app/extensions/example.test/frontend/digest/index.js",
        "/vlo",
      ),
    ).toBe("/vlo/app/extensions/example.test/frontend/digest/index.js");
    expect(prefixExtensionFrontendEntryUrl(null, "/vlo")).toBeNull();
  });

  it("forwards caller cancellation to inventory requests", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ extensions: [] }),
    );
    const controller = new AbortController();

    await fetchExtensionInventory({ signal: controller.signal });

    expect(globalThis.fetch).toHaveBeenCalledWith("/app/extensions", {
      signal: controller.signal,
    });
  });

  it("sends exact-digest approval and lifecycle mutations", async () => {
    const approved = inventoryItem("approved");
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse({ extension: approved }))
      .mockResolvedValueOnce(
        jsonResponse({
          extension: { ...approved, status: "disabled" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          extension: {
            ...approved,
            status: "pending_approval",
            approval: null,
            frontendEntryUrl: null,
          },
        }),
      );

    await approveExtensionDigest("example.test", approved.digest);
    await disableExtension("example.test");
    await revokeExtensionApproval("example.test");

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "/app/extensions/example.test/approve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest: approved.digest }),
      },
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "/app/extensions/example.test/disable",
      { method: "POST" },
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      3,
      "/app/extensions/example.test/approval",
      { method: "DELETE" },
    );
  });

  it("preserves structured backend errors", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "extension_state_conflict",
            message: "Extension bytes changed before approval.",
          },
        },
        409,
      ),
    );

    await expect(
      approveExtensionDigest("example.test", `sha256:${"a".repeat(64)}`),
    ).rejects.toMatchObject({
      name: "ExtensionManagementApiError",
      status: 409,
      message: "Extension bytes changed before approval.",
    });
  });

  it("rejects malformed successful responses", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ extensions: [{ id: "missing-fields" }] }),
    );

    await expect(fetchExtensionInventory()).rejects.toThrow(
      "invalid response",
    );
  });
});
