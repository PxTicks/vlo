import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionApprovalGate } from "../ExtensionApprovalGate";
import { useExtensionManagementStore } from "../../store/useExtensionManagementStore";
import type { ExtensionInventoryItem } from "../../services/extensionManagementApi";

const originalFetch = globalThis.fetch;
const digest = `sha256:${"b".repeat(64)}`;

function extensionItem(
  overrides: Partial<ExtensionInventoryItem> = {},
): ExtensionInventoryItem {
  return {
    id: "example.gate",
    sourcePath: "/extensions/example.gate",
    status: "pending_approval",
    digest,
    errors: [],
    manifest: {
      manifestVersion: 1,
      id: "example.gate",
      name: "Gate Extension",
      version: "1.2.0",
      sdk: ">=1.0.0 <2.0.0",
      frontend: { entry: "frontend/dist/index.js" },
      capabilities: ["timeline.read"],
    },
    approval: null,
    backendRuntime: {
      status: "not_declared",
      message: "No backend entry point is declared.",
      digest: null,
    },
    frontendEntryUrl: null,
    preflight: null,
    ...overrides,
  };
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ExtensionApprovalGate", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    useExtensionManagementStore.setState({
      items: [],
      loadStatus: "idle",
      error: null,
      mutation: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("prompts for a new extension and offers a restart once it is allowed", async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(response({ extensions: [extensionItem()] }))
      .mockResolvedValueOnce(
        response({
          extension: extensionItem({
            status: "approved",
            approval: {
              digest,
              version: "1.2.0",
              approvedAt: 10,
              enabled: true,
            },
          }),
        }),
      );

    render(<ExtensionApprovalGate onReload={onReload} />);

    expect(
      await screen.findByRole("heading", {
        name: "A new extension was found",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Gate Extension")).toBeInTheDocument();
    expect(
      screen.getByText(/Extensions can pose security risks/i),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("extension-approval-gate-allow"));

    expect(
      await screen.findByRole("heading", { name: "Restart to finish" }),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("extension-approval-gate-reload"));
    expect(onReload).toHaveBeenCalledTimes(1);

    const [, approveCall] = vi.mocked(globalThis.fetch).mock.calls;
    expect(approveCall[0]).toContain("/example.gate/approve");
  });

  it("records a refusal against the reviewed digest and closes without a restart", async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(response({ extensions: [extensionItem()] }))
      .mockResolvedValueOnce(
        response({
          extension: extensionItem({
            status: "disabled",
            approval: {
              digest,
              version: "1.2.0",
              approvedAt: 10,
              enabled: false,
            },
          }),
        }),
      );

    render(<ExtensionApprovalGate />);

    await screen.findByText("Gate Extension");
    await user.click(screen.getByTestId("extension-approval-gate-block"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("extension-approval-gate"),
      ).not.toBeInTheDocument();
    });

    const [, declineCall] = vi.mocked(globalThis.fetch).mock.calls;
    expect(declineCall[0]).toContain("/example.gate/decline");
    expect(declineCall[1]?.body).toBe(JSON.stringify({ digest }));
  });

  it("never re-queues an extension the user already answered", async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(response({ extensions: [extensionItem()] }))
      // A backend that reports the package as still undecided must not be able
      // to trap the user behind a dialog they cannot dismiss.
      .mockResolvedValueOnce(response({ extension: extensionItem() }));

    render(<ExtensionApprovalGate />);

    await screen.findByText("Gate Extension");
    await user.click(screen.getByTestId("extension-approval-gate-block"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("extension-approval-gate"),
      ).not.toBeInTheDocument();
    });
  });

  it("says so plainly when an extension changed after being allowed", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(
        response({
          extensions: [
            extensionItem({
              status: "changed",
              approval: {
                digest: `sha256:${"c".repeat(64)}`,
                version: "1.1.0",
                approvedAt: 5,
                enabled: true,
              },
            }),
          ],
        }),
      ),
    );

    render(<ExtensionApprovalGate />);

    expect(
      await screen.findByRole("heading", { name: "An extension has changed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/altered since you last allowed it/i),
    ).toBeInTheDocument();
  });

  it("stays out of the way for already decided and unusable packages", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(
        response({
          extensions: [
            extensionItem({
              status: "approved",
              approval: {
                digest,
                version: "1.2.0",
                approvedAt: 10,
                enabled: true,
              },
            }),
            extensionItem({
              id: "example.blocked",
              status: "disabled",
              approval: {
                digest,
                version: "1.2.0",
                approvedAt: 10,
                enabled: false,
              },
            }),
            // Cannot run here whatever the answer, so asking would be noise.
            extensionItem({
              id: "example.incompatible",
              manifest: {
                ...extensionItem().manifest!,
                id: "example.incompatible",
                sdk: ">=99.0.0",
              },
            }),
          ],
        }),
      ),
    );

    render(<ExtensionApprovalGate />);

    await waitFor(() => {
      expect(useExtensionManagementStore.getState().loadStatus).toBe("ready");
    });
    expect(
      screen.queryByTestId("extension-approval-gate"),
    ).not.toBeInTheDocument();
  });
});
