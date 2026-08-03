import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionManagerDialog } from "../ExtensionManagerDialog";
import { useExtensionManagementStore } from "../../store/useExtensionManagementStore";
import { VLO_EXTENSION_SDK_VERSION } from "../../constants";
import type { ExtensionInventoryItem } from "../../services/extensionManagementApi";

const originalFetch = globalThis.fetch;
const digest = `sha256:${"a".repeat(64)}`;

function extensionItem(
  status: "pending_approval" | "approved",
): ExtensionInventoryItem {
  return {
    id: "example.dialog",
    sourcePath: "/extensions/example.dialog",
    status,
    digest,
    errors: [],
    manifest: {
      manifestVersion: 1,
      id: "example.dialog",
      name: "Dialog Extension",
      version: "1.0.0",
      sdk: ">=1.0.0 <2.0.0",
      frontend: { entry: "frontend/dist/index.js" },
      backend: {
        mode: "in_process",
        entry: "backend.dialog:create_extension",
      },
      capabilities: ["timeline.read", "backend.jobs"],
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
      status: status === "approved" ? "restart_required" : "inactive",
      message:
        status === "approved"
          ? "Ready to run. Restart vlo to start it."
          : "Not running, because this extension is not allowed.",
      digest: status === "approved" ? digest : null,
    },
    frontendEntryUrl:
      status === "approved"
        ? `/app/extensions/example.dialog/frontend/${digest}/index.js`
        : null,
    preflight: null,
  };
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ExtensionManagerDialog", () => {
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

  it("requires a second explicit trust confirmation for the exact digest", async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        response({ extensions: [extensionItem("pending_approval")] }),
      )
      .mockResolvedValueOnce(
        response({ extension: extensionItem("approved") }),
      );

    render(<ExtensionManagerDialog open onClose={vi.fn()} />);

    expect(await screen.findByText("Dialog Extension")).toBeInTheDocument();
    expect(
      screen.getByText(/Extensions are not sandboxed/i),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Allow" }),
    );

    expect(
      screen.getByRole("heading", { name: "Allow this extension to run?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/only starts when vlo restarts/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Extensions load when vlo starts, so this takes effect/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(digest)).toHaveLength(2);

    await user.click(
      screen.getByRole("button", { name: "Yes, allow it" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Allow this extension to run?",
        }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect(
      screen.getByText(/background service: ready to run/i),
    ).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("renders the Python dependency preflight checklist with install hints", async () => {
    const item = {
      ...extensionItem("pending_approval"),
      preflight: {
        satisfied: false,
        dependencies: [
          {
            module: "torch",
            distribution: "torch",
            purpose: "GPU inference",
            satisfied: false,
            detail: "Not installed in the backend environment.",
          },
        ],
        installHints: ["/venv/bin/python -m pip install torch"],
        environment: "/venv",
        isolated: true,
      },
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response({ extensions: [item] }),
    );

    render(<ExtensionManagerDialog open onClose={vi.fn()} />);

    expect(
      await screen.findByText("Extra software this extension needs"),
    ).toBeInTheDocument();
    expect(screen.getByText("GPU inference")).toBeInTheDocument();
    expect(
      screen.getByText(/pip install torch/i),
    ).toBeInTheDocument();
  });

  it("shows structured inventory failures without hiding the trust warning", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response(
        {
          error: {
            code: "extension_inventory_unavailable",
            message: "Extension inventory is unavailable.",
          },
        },
        500,
      ),
    );

    render(<ExtensionManagerDialog open onClose={vi.fn()} />);

    expect(
      await screen.findByText("Extension inventory is unavailable."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Extensions are not sandboxed/i),
    ).toBeInTheDocument();
  });

  it("allows a hung approval request to be cancelled", async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        response({ extensions: [extensionItem("pending_approval")] }),
      )
      .mockImplementationOnce((_url, init) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      });

    render(<ExtensionManagerDialog open onClose={vi.fn()} />);
    await screen.findByText("Dialog Extension");
    await user.click(
      screen.getByRole("button", { name: "Allow" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Yes, allow it" }),
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    await user.click(cancel);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Allow this extension to run?",
        }),
      ).not.toBeInTheDocument();
    });
    expect(useExtensionManagementStore.getState().mutation).toBeNull();
    expect(useExtensionManagementStore.getState().error).toBeNull();
  });

  it("blocks approval when the declared SDK range is incompatible", async () => {
    const incompatible = extensionItem("pending_approval");
    if (!incompatible.manifest) throw new Error("fixture manifest missing");
    incompatible.manifest.sdk = ">=2.0.0";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response({ extensions: [incompatible] }),
    );

    render(<ExtensionManagerDialog open onClose={vi.fn()} />);

    expect(
      await screen.findByText(/built for a different version of vlo/i),
    ).toBeInTheDocument();
    // The unusable range is still stated, just not as the headline.
    expect(
      screen.getAllByText(
        new RegExp(VLO_EXTENSION_SDK_VERSION.replace(/\./g, "\\.")),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Allow" }),
    ).not.toBeInTheDocument();
  });

  it("blocks an incompatible VLO range", async () => {
    const incompatible = extensionItem("pending_approval");
    if (!incompatible.manifest) throw new Error("fixture manifest missing");
    incompatible.manifest.vlo = ">=0.3.0";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response({ extensions: [incompatible] }),
    );

    render(<ExtensionManagerDialog open onClose={vi.fn()} />);

    expect(
      await screen.findByText(/does not support vlo/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow" }),
    ).not.toBeInTheDocument();
  });

  // Declared capabilities are not enforced, so the approval panel must not
  // present them as a scope: it states the real trust boundary instead, for
  // every code-bearing package rather than only self-declared raw-access ones.
  it("never presents declared capabilities as a limit on access", async () => {
    const item = extensionItem("pending_approval");
    if (!item.manifest) throw new Error("fixture manifest missing");
    item.manifest.capabilities = ["ui.custom", "assets.read"];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response({ extensions: [item] }),
    );

    render(<ExtensionManagerDialog open onClose={vi.fn()} />);

    expect(
      await screen.findByText(/Extensions are not sandboxed/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("ui.custom")).not.toBeInTheDocument();
    expect(screen.queryByText("assets.read")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/what the author says it does/i),
    ).not.toBeInTheDocument();
  });
});
