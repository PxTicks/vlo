import type {
  GenerationDeliveryMessage,
} from "./generationDeliveryApi";
import { parseGenerationDeliveryMessage } from "./generationDeliveryApi";
import {
  parseBinaryPreviewPayload,
  type ParsedBinaryPreview,
  type PreviewSequenceMetadata,
} from "./previewBinary";

export type GenerationDeliveryConnectionState = "connected" | "disconnected";
export type GenerationDeliveryMessageHandler = (
  message: GenerationDeliveryMessage,
) => void;
export type GenerationDeliveryPreviewHandler = (
  preview: ParsedBinaryPreview,
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
  private readonly previewHandlers =
    new Set<GenerationDeliveryPreviewHandler>();
  private readonly connectionChangeHandlers =
    new Set<GenerationDeliveryConnectionChangeHandler>();
  private readonly previewSequenceMetadataByNodeId = new Map<
    string,
    PreviewSequenceMetadata
  >();

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
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.notifyConnectionChange("connected");
    };
    this.ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const parsed = parseBinaryPreviewPayload(event.data, (nodeId) =>
          this.findPreviewSequenceMetadata(nodeId),
        );
        if (!parsed) {
          return;
        }
        for (const handler of this.previewHandlers) {
          handler(parsed);
        }
        return;
      }
      if (typeof event.data !== "string") {
        return;
      }
      if (this.tryAbsorbPreviewSequenceMetadata(event.data)) {
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

  onPreview(handler: GenerationDeliveryPreviewHandler): () => void {
    this.previewHandlers.add(handler);
    return () => {
      this.previewHandlers.delete(handler);
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

  private tryAbsorbPreviewSequenceMetadata(data: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { type?: unknown }).type !== "VHS_latentpreview"
    ) {
      return false;
    }
    const payload = (parsed as { data?: unknown }).data;
    if (!payload || typeof payload !== "object") {
      return true;
    }
    const { id, rate, length } = payload as {
      id?: unknown;
      rate?: unknown;
      length?: unknown;
    };
    if (
      typeof id !== "string" ||
      typeof rate !== "number" ||
      typeof length !== "number"
    ) {
      return true;
    }
    this.previewSequenceMetadataByNodeId.set(id, {
      frameRate: rate,
      nodeId: id,
      totalFrames: length,
    });
    return true;
  }

  private findPreviewSequenceMetadata(
    nodeId: string,
  ): PreviewSequenceMetadata | null {
    const exactMatch = this.previewSequenceMetadataByNodeId.get(nodeId);
    if (exactMatch) {
      return exactMatch;
    }
    for (const [knownNodeId, metadata] of this.previewSequenceMetadataByNodeId) {
      if (knownNodeId.startsWith(nodeId) || nodeId.startsWith(knownNodeId)) {
        return metadata;
      }
    }
    return null;
  }
}
