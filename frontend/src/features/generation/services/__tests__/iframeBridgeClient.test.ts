import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  IframeBridgeClient,
  IframeBridgeError,
  REQUIRED_BRIDGE_CAPABILITIES,
} from "../iframeBridgeClient";

interface PostedMessage {
  protocol: string;
  version: number;
  channelId: string;
  type: string;
  requestId?: string;
  method?: string;
}

function setupClient() {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const contentWindow = iframe.contentWindow;
  if (!contentWindow) throw new Error("jsdom did not create iframe contentWindow");
  const postMessage = vi.spyOn(contentWindow, "postMessage").mockImplementation(() => {});
  const client = new IframeBridgeClient();
  client.bindIframe(iframe);
  const hello = postMessage.mock.calls.at(-1)?.[0] as PostedMessage;
  return { client, iframe, contentWindow, postMessage, hello };
}

function dispatchFromIframe(
  contentWindow: Window,
  data: Record<string, unknown>,
  origin = window.location.origin,
) {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, source: contentWindow }),
  );
}

function announceReady(
  contentWindow: Window,
  hello: PostedMessage,
  overrides: Record<string, unknown> = {},
) {
  dispatchFromIframe(contentWindow, {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    channelId: hello.channelId,
    type: "ready",
    capabilities: [...REQUIRED_BRIDGE_CAPABILITIES],
    ...overrides,
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("IframeBridgeClient", () => {
  it("handshakes and correlates request responses", async () => {
    const { client, contentWindow, postMessage, hello } = setupClient();
    expect(hello).toMatchObject({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: "hello",
    });
    announceReady(contentWindow, hello);
    expect(client.currentStatus).toBe("ready");

    const promise = client.readActive();
    const request = postMessage.mock.calls.at(-1)?.[0] as PostedMessage;
    expect(request).toMatchObject({ type: "request", method: "read-active" });
    dispatchFromIframe(contentWindow, {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      channelId: hello.channelId,
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        graphData: { nodes: [] },
        filename: "workflow.json",
        isModified: false,
        workflowInstanceId: "workflow-1",
        revision: 4,
      },
    });

    await expect(promise).resolves.toMatchObject({
      workflowInstanceId: "workflow-1",
      revision: 4,
    });
  });

  it("rejects incompatible versions and missing capabilities immediately", async () => {
    const first = setupClient();
    announceReady(first.contentWindow, first.hello, { version: 1 });
    expect(first.client.currentStatus).toBe("incompatible");
    await expect(first.client.waitForReady(100)).rejects.toMatchObject({
      code: "incompatible",
    });

    const second = setupClient();
    announceReady(second.contentWindow, second.hello, { capabilities: ["health"] });
    expect(second.client.currentStatus).toBe("incompatible");
    expect(second.client.currentError?.message).toMatch(/missing capabilities/i);
  });

  it("ignores wrong origins, sources, and stale channels", () => {
    const { client, contentWindow, hello } = setupClient();
    const ready = {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      channelId: hello.channelId,
      type: "ready",
      capabilities: [...REQUIRED_BRIDGE_CAPABILITIES],
    };
    dispatchFromIframe(contentWindow, ready, "https://attacker.invalid");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: ready,
        origin: window.location.origin,
        source: window,
      }),
    );
    dispatchFromIframe(contentWindow, { ...ready, channelId: "stale" });
    expect(client.currentStatus).toBe("handshaking");
  });

  it("rejects pending requests when the iframe reloads", async () => {
    const { client, contentWindow, hello } = setupClient();
    announceReady(contentWindow, hello);
    const pending = client.health();
    client.notifyIframeReloaded();
    await expect(pending).rejects.toMatchObject({ code: "iframe-reloaded" });
    expect(client.currentStatus).toBe("handshaking");
  });

  it("preserves structured remote errors", async () => {
    const { client, contentWindow, postMessage, hello } = setupClient();
    announceReady(contentWindow, hello);
    const pending = client.resolvePrompt(
      { workflowInstanceId: "workflow-1", revision: 2 },
      [],
      [],
    );
    const request = postMessage.mock.calls.at(-1)?.[0] as PostedMessage;
    dispatchFromIframe(contentWindow, {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      channelId: hello.channelId,
      type: "response",
      requestId: request.requestId,
      ok: false,
      error: {
        code: "workflow-changed",
        message: "The workflow changed",
        details: { actualRevision: 3 },
      },
    });

    await expect(pending).rejects.toMatchObject({
      code: "workflow-changed",
      message: "The workflow changed",
      details: { actualRevision: 3 },
    });
  });

  it("fans out graph and health push events", () => {
    const { client, contentWindow, hello } = setupClient();
    announceReady(contentWindow, hello);
    const graphHandler = vi.fn();
    const healthHandler = vi.fn();
    client.onGraphChanged(graphHandler);
    client.onHealthChanged(healthHandler);

    dispatchFromIframe(contentWindow, {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      channelId: hello.channelId,
      type: "event",
      event: "graph-changed",
      data: {
        graphData: { nodes: [] },
        filename: null,
        isModified: true,
        workflowInstanceId: "workflow-2",
        revision: 2,
      },
    });
    dispatchFromIframe(contentWindow, {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      channelId: hello.channelId,
      type: "event",
      event: "health-changed",
      data: { appReady: true, backendConnected: false },
    });

    expect(graphHandler).toHaveBeenCalledWith(
      expect.objectContaining({ workflowInstanceId: "workflow-2", revision: 2 }),
    );
    expect(healthHandler).toHaveBeenCalledWith({
      appReady: true,
      backendConnected: false,
    });
  });

  it("times out unanswered requests with a typed error", async () => {
    vi.useFakeTimers();
    const { client, contentWindow, hello } = setupClient();
    announceReady(contentWindow, hello);
    const promise = client.health();
    const assertion = expect(promise).rejects.toBeInstanceOf(IframeBridgeError);
    await vi.advanceTimersByTimeAsync(3_001);
    await assertion;
  });
});
