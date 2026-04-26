import type {
  GenerationDeliveryMessage,
} from "./generationDeliveryApi";
import { parseGenerationDeliveryMessage } from "./generationDeliveryApi";

export type GenerationDeliveryConnectionState = "connected" | "disconnected";
export type GenerationDeliveryMessageHandler = (
  message: GenerationDeliveryMessage,
) => void;
export type GenerationDeliveryConnectionChangeHandler = (
  state: GenerationDeliveryConnectionState,
) => void;

export class GenerationDeliveryWebSocket {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private readonly messageHandlers = new Set<GenerationDeliveryMessageHandler>();
  private readonly connectionChangeHandlers =
    new Set<GenerationDeliveryConnectionChangeHandler>();

  constructor(baseUrl: string, projectId: string) {
    this.baseUrl = baseUrl;
    this.projectId = projectId;
  }

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
    const query = new URLSearchParams({ projectId: this.projectId });
    const wsUrl =
      `${protocol}//${window.location.host}${this.baseUrl}` +
      `/app/generation-delivery/ws?${query.toString()}`;

    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.notifyConnectionChange("connected");
    };
    this.ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      const message = parseGenerationDeliveryMessage(event.data);
      if (!message) {
        return;
      }
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.notifyConnectionChange("disconnected");
      if (this.shouldReconnect) {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  acknowledgeDelivery(deliveryId: string): void {
    if (!this.isConnected) {
      return;
    }
    this.ws?.send(
      JSON.stringify({
        type: "ack",
        delivery_id: deliveryId,
      }),
    );
  }

  rejectDelivery(deliveryId: string, error: string): void {
    if (!this.isConnected) {
      return;
    }
    this.ws?.send(
      JSON.stringify({
        type: "nack",
        delivery_id: deliveryId,
        error,
      }),
    );
  }

  onMessage(handler: GenerationDeliveryMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onConnectionChange(
    handler: GenerationDeliveryConnectionChangeHandler,
  ): () => void {
    this.connectionChangeHandlers.add(handler);
    return () => {
      this.connectionChangeHandlers.delete(handler);
    };
  }

  private notifyConnectionChange(
    state: GenerationDeliveryConnectionState,
  ): void {
    for (const handler of this.connectionChangeHandlers) {
      handler(state);
    }
  }
}
