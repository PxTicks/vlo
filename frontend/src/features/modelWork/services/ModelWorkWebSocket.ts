import { API_BASE_URL } from "../../../config";
import { parseModelWorkMessage, type ModelWorkMessage } from "./modelWorkApi";

export type ModelWorkConnectionState = "connected" | "disconnected";

const RECONNECT_DELAY_MS = 3000;

/**
 * Project-agnostic feed for the model-work ledger.
 *
 * Deliberately not the generation-delivery socket: that one hard-requires a
 * `projectId`, and GPU activity is machine-global.
 */
export class ModelWorkWebSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private readonly messageHandlers = new Set<(message: ModelWorkMessage) => void>();
  private readonly connectionHandlers = new Set<
    (state: ModelWorkConnectionState) => void
  >();

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.shouldReconnect = true;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(
      `${protocol}//${window.location.host}${API_BASE_URL}/app/model-work/ws`,
    );
    this.ws.onopen = () => {
      this.clearReconnectTimer();
      this.notifyConnection("connected");
    };
    this.ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      const message = parseModelWorkMessage(event.data);
      if (!message) {
        return;
      }
      for (const handler of [...this.messageHandlers]) {
        handler(message);
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.notifyConnection("disconnected");
      if (!this.shouldReconnect) {
        return;
      }
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
  }

  onMessage(handler: (message: ModelWorkMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onConnectionChange(
    handler: (state: ModelWorkConnectionState) => void,
  ): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private notifyConnection(state: ModelWorkConnectionState): void {
    for (const handler of [...this.connectionHandlers]) {
      handler(state);
    }
  }
}
