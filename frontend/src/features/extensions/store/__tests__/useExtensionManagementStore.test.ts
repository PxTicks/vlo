import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionInventoryItem } from "../../services/extensionManagementApi";
import { useExtensionManagementStore } from "../useExtensionManagementStore";

const originalFetch = globalThis.fetch;
const digest = `sha256:${"a".repeat(64)}`;

function inventoryItem(id: string): ExtensionInventoryItem {
  return {
    id,
    sourcePath: `/extensions/${id}`,
    status: "pending_approval",
    digest,
    errors: [],
    manifest: {
      manifestVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      sdk: ">=1.0.0 <2.0.0",
      frontend: { entry: "frontend/dist/index.js" },
      capabilities: [],
    },
    approval: null,
    backendRuntime: {
      status: "not_declared",
      message: "No backend entry point is declared.",
      digest: null,
    },
    frontendEntryUrl: null,
  };
}

function inventoryResponse(id: string): Response {
  return new Response(
    JSON.stringify({ extensions: [inventoryItem(id)] }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("useExtensionManagementStore", () => {
  beforeEach(() => {
    useExtensionManagementStore.getState().cancelPending();
    useExtensionManagementStore.setState({
      items: [],
      loadStatus: "idle",
      error: null,
      mutation: null,
    });
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    useExtensionManagementStore.getState().cancelPending();
    globalThis.fetch = originalFetch;
  });

  it("ignores an older inventory response that resolves last", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let resolveSecond: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const firstLoad = useExtensionManagementStore.getState().load();
    const secondLoad = useExtensionManagementStore.getState().load();
    resolveSecond?.(inventoryResponse("example.newer"));
    await secondLoad;
    resolveFirst?.(inventoryResponse("example.older"));
    await firstLoad;

    expect(useExtensionManagementStore.getState().items[0]?.id).toBe(
      "example.newer",
    );
  });

  it("cancels a hung mutation without leaving an error or busy state", async () => {
    useExtensionManagementStore.setState({
      items: [inventoryItem("example.cancel")],
    });
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const approval = useExtensionManagementStore
      .getState()
      .approve("example.cancel", digest);
    expect(useExtensionManagementStore.getState().mutation).toEqual({
      extensionId: "example.cancel",
      action: "approve",
    });

    useExtensionManagementStore.getState().cancelPending();

    await expect(approval).resolves.toBe(false);
    expect(useExtensionManagementStore.getState().mutation).toBeNull();
    expect(useExtensionManagementStore.getState().error).toBeNull();
  });
});
