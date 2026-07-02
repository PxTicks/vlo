import { beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  waitForReady: vi.fn(),
  readActive: vi.fn(),
  injectWorkflow: vi.fn(),
}));

vi.mock("../iframeBridgeClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../iframeBridgeClient")>();
  return {
    ...actual,
    iframeBridge: {
      waitForReady: bridgeMocks.waitForReady,
      readActive: bridgeMocks.readActive,
      injectWorkflow: bridgeMocks.injectWorkflow,
    },
  };
});

import { IframeBridgeError } from "../iframeBridgeClient";
import {
  injectWorkflowAndRead,
  readWorkflowWithRetry,
  waitForAppReady,
} from "../workflowSyncController";

const snapshot = {
  graphData: { nodes: [{ id: 1, type: "LoadImage" }], links: [] },
  filename: "wf.json",
  isModified: true,
  workflowInstanceId: "workflow-instance",
  revision: 3,
};

describe("workflowSyncController", () => {
  const iframe = {} as HTMLIFrameElement;

  beforeEach(() => {
    vi.resetAllMocks();
    bridgeMocks.waitForReady.mockResolvedValue(true);
    bridgeMocks.readActive.mockResolvedValue(null);
    bridgeMocks.injectWorkflow.mockRejectedValue(
      new IframeBridgeError("timeout", "workflow injection timed out"),
    );
  });

  it("delegates readiness to the versioned bridge handshake", async () => {
    await expect(waitForAppReady(iframe, () => false, 300)).resolves.toBe(true);
    expect(bridgeMocks.waitForReady).toHaveBeenCalledWith(300, expect.any(Function));
  });

  it("reads the exact active workflow identity and revision", async () => {
    bridgeMocks.readActive.mockResolvedValue(snapshot);
    const result = await readWorkflowWithRetry(iframe, () => false, 300);
    expect(result).toMatchObject({
      filename: "wf.json",
      workflow: null,
      workflowInstanceId: "workflow-instance",
      revision: 3,
    });
  });

  it("defers when bridge readiness times out", async () => {
    bridgeMocks.waitForReady.mockResolvedValue(false);
    const result = await injectWorkflowAndRead(iframe, {}, "wf.json", () => false);
    expect(result).toMatchObject({
      ok: false,
      deferred: true,
      reason: "iframe bridge not ready",
    });
    expect(bridgeMocks.injectWorkflow).not.toHaveBeenCalled();
  });

  it("uses the authoritative snapshot returned by injection", async () => {
    bridgeMocks.injectWorkflow.mockResolvedValue({
      warnings: {
        missingNodeTypes: ["CustomNode"],
        missingModels: ["model.safetensors"],
      },
      snapshot,
    });
    const result = await injectWorkflowAndRead(
      iframe,
      snapshot.graphData,
      "wf.json",
      () => false,
    );
    expect(result).toMatchObject({
      ok: true,
      deferred: false,
      warnings: {
        missingNodeTypes: ["CustomNode"],
        missingModels: ["model.safetensors"],
      },
      workflowResult: {
        workflowInstanceId: "workflow-instance",
        revision: 3,
      },
    });
    expect(bridgeMocks.readActive).not.toHaveBeenCalled();
  });

  it("returns a deferred result for retryable bridge errors", async () => {
    const result = await injectWorkflowAndRead(
      iframe,
      { nodes: [] },
      "wf.json",
      () => false,
    );
    expect(result).toMatchObject({
      ok: false,
      deferred: true,
      reason: "workflow injection timed out",
    });
  });

  it("fails without retry for incompatible bridge contracts", async () => {
    bridgeMocks.injectWorkflow.mockRejectedValue(
      new IframeBridgeError("incompatible", "Bridge protocol is incompatible"),
    );
    const result = await injectWorkflowAndRead(
      iframe,
      { nodes: [] },
      "wf.json",
      () => false,
    );
    expect(result).toMatchObject({
      ok: false,
      deferred: false,
      reason: "Bridge protocol is incompatible",
    });
  });

  it("does not commit an injection result after the load is aborted", async () => {
    bridgeMocks.injectWorkflow.mockResolvedValue({ warnings: null, snapshot });
    const result = await injectWorkflowAndRead(
      iframe,
      snapshot.graphData,
      "wf.json",
      () => true,
    );
    expect(result).toMatchObject({
      ok: false,
      deferred: true,
      reason: "workflow load aborted",
    });
  });
});
