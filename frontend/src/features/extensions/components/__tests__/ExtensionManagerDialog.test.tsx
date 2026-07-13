import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionManagerDialog } from "../ExtensionManagerDialog";
import { useExtensionManagementStore } from "../../store/useExtensionManagementStore";
import { VLO_EXTENSION_SDK_VERSION } from "../../constants";

const originalFetch = globalThis.fetch;
const digest = `sha256:${"a".repeat(64)}`;

function extensionItem(status: "pending_approval" | "approved") {
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
          ? "Approved backend code will activate after restart."
          : "Backend extension is not approved for activation.",
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
    expect(screen.getByText("timeline.read")).toBeInTheDocument();
    expect(screen.getByText("backend.jobs")).toBeInTheDocument();
    expect(
      screen.getByText(/trusted extension system, not a sandbox/i),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Approve current digest" }),
    );

    expect(
      screen.getByRole("heading", { name: "Trust and approve extension?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/backend activation requires an application restart/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/frontend code activates at the next page load/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(digest)).toHaveLength(2);

    await user.click(
      screen.getByRole("button", { name: "Approve exact digest" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Trust and approve extension?",
        }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(
      screen.getByText(/backend runtime: approved backend code will activate/i),
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
      await screen.findByText("Python dependency preflight"),
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
      screen.getByText(/trusted extension system, not a sandbox/i),
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
      screen.getByRole("button", { name: "Approve current digest" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Approve exact digest" }),
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    await user.click(cancel);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Trust and approve extension?",
        }),
      ).not.toBeInTheDocument();
    });
    expect(useExtensionManagementStore.getState().mutation).toBeNull();
    expect(useExtensionManagementStore.getState().error).toBeNull();
  });

  it("blocks approval when the declared SDK range is incompatible", async () => {
    const incompatible = extensionItem("pending_approval");
    incompatible.manifest.sdk = ">=2.0.0";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      response({ extensions: [incompatible] }),
    );

    render(<ExtensionManagerDialog open onClose={vi.fn()} />);

    expect(
      await screen.findByText(
        new RegExp(
          `cannot activate with extension SDK ${VLO_EXTENSION_SDK_VERSION.replace(/\./g, "\\.")}`,
          "i",
        ),
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve current digest" }),
    ).not.toBeInTheDocument();
  });
});
