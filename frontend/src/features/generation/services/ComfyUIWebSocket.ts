export interface ComfyUIStatusEvent {
  type: "status";
  data: { status: { exec_info: { queue_remaining: number } }; sid?: string };
}

export interface ComfyUIProgressEvent {
  type: "progress";
  data: { value: number; max: number; prompt_id: string; node: string };
}

export interface ComfyUIExecutingEvent {
  type: "executing";
  data: { node: string | null; display_node?: string; prompt_id: string };
}

export interface ComfyUIExecutedEvent {
  type: "executed";
  data: {
    node: string;
    display_node?: string;
    prompt_id: string;
    output: {
      images?: Array<{ filename: string; subfolder: string; type: string }>;
      gifs?: Array<{ filename: string; subfolder: string; type: string }>;
      videos?: Array<{ filename: string; subfolder: string; type: string }>;
    };
  };
}

export interface ComfyUIExecutionErrorEvent {
  type: "execution_error";
  data: {
    prompt_id: string;
    node_id: string;
    node_type: string;
    exception_message: string;
    exception_type: string;
    traceback: string[];
  };
}

export interface ComfyUIProxyErrorEvent {
  type: "error";
  data: { message: string };
}

interface ComfyUIFeatureFlagsEvent {
  type: "feature_flags";
  data: Record<string, unknown>;
}

interface ComfyUIVhsLatentPreviewEvent {
  type: "VHS_latentpreview";
  data: { length: number; rate: number; id: string };
}

export type ComfyUIEvent =
  | ComfyUIStatusEvent
  | ComfyUIProgressEvent
  | ComfyUIExecutingEvent
  | ComfyUIExecutedEvent
  | ComfyUIExecutionErrorEvent
  | ComfyUIProxyErrorEvent;

const BINARY_PREVIEW_IMAGE = 1;
const BINARY_PREVIEW_IMAGE_WITH_METADATA = 4;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const VHS_LATENT_PREVIEW_NODE_ID_OFFSET = 16;
const VHS_LATENT_PREVIEW_NODE_ID_LENGTH = 16;
const VHS_LATENT_PREVIEW_FRAME_INDEX_OFFSET = 12;
const VHS_LATENT_PREVIEW_IMAGE_OFFSET = 32;
const MAX_PREVIEW_SIGNATURE_OFFSET = 256;
const PREVIEW_METADATA_FEATURE_FLAGS = JSON.stringify({
  type: "feature_flags",
  data: {
    supports_preview_metadata: true,
  },
});

interface PreviewSequenceMetadata {
  frameRate: number;
  nodeId: string;
  totalFrames: number;
}

export interface ComfyUIPreview {
  blob: Blob;
  frameIndex?: number;
  frameRate?: number;
  nodeId?: string;
  promptId?: string;
  totalFrames?: number;
}

export type ComfyUIConnectionState = "connected" | "disconnected";
export type ComfyUIEventHandler = (event: ComfyUIEvent) => void;
export type ComfyUIPreviewHandler = (preview: ComfyUIPreview) => void;
export type ComfyUIConnectionChangeHandler = (
  state: ComfyUIConnectionState,
) => void;

export class ComfyUIWebSocket {
  private ws: WebSocket | null = null;
  private readonly clientId: string;
  private readonly baseUrl: string;
  private eventHandlers = new Set<ComfyUIEventHandler>();
  private previewHandlers = new Set<ComfyUIPreviewHandler>();
  private connectionChangeHandlers = new Set<ComfyUIConnectionChangeHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private readonly previewSequenceMetadataByNodeId = new Map<
    string,
    PreviewSequenceMetadata
  >();
  private readonly textDecoder = new TextDecoder();

  constructor(baseUrl: string) {
    this.clientId = crypto.randomUUID();
    this.baseUrl = baseUrl;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentClientId(): string {
    return this.clientId;
  }

  connect(): void {
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.shouldReconnect = true;

    // Build an absolute WebSocket URL from the path-based baseUrl.
    // This ensures the WS connection routes through the same proxy as HTTP requests.
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}${this.baseUrl}/comfy/ws?clientId=${this.clientId}`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.ws?.send(PREVIEW_METADATA_FEATURE_FLAGS);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.notifyConnectionChange("connected");
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      } else {
        this.handleTextMessage(event.data as string);
      }
    };

    this.ws.onclose = () => {
      if (this.shouldReconnect) {
        // Don't notify disconnected during reconnect cycles — avoids flickering
        // between error/disconnected states. Status stays as-is (error/connecting).
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      } else {
        this.notifyConnectionChange("disconnected");
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this, triggering reconnect + disconnect notification
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

  onEvent(handler: ComfyUIEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onPreview(handler: ComfyUIPreviewHandler): () => void {
    this.previewHandlers.add(handler);
    return () => {
      this.previewHandlers.delete(handler);
    };
  }

  onConnectionChange(handler: ComfyUIConnectionChangeHandler): () => void {
    this.connectionChangeHandlers.add(handler);
    return () => {
      this.connectionChangeHandlers.delete(handler);
    };
  }

  private handleTextMessage(data: string): void {
    try {
      const event = JSON.parse(data) as
        | ComfyUIEvent
        | ComfyUIFeatureFlagsEvent
        | ComfyUIVhsLatentPreviewEvent;

      if (this.isVhsLatentPreviewEvent(event)) {
        this.previewSequenceMetadataByNodeId.set(event.data.id, {
          frameRate: event.data.rate,
          nodeId: event.data.id,
          totalFrames: event.data.length,
        });
        return;
      }

      if (!this.isComfyUIEvent(event)) {
        return;
      }

      for (const handler of this.eventHandlers) {
        handler(event);
      }
    } catch {
      // ignore unparseable messages (e.g. feature_flags)
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    if (data.byteLength < 4) return;

    const view = new DataView(data);
    const eventType = view.getUint32(0, false); // big-endian

    if (
      eventType === BINARY_PREVIEW_IMAGE ||
      eventType === BINARY_PREVIEW_IMAGE_WITH_METADATA
    ) {
      const parsed = this.parsePreviewImagePayload(eventType, data);
      if (!parsed) return;

      for (const handler of this.previewHandlers) {
        handler(parsed);
      }
    }
  }

  private parsePreviewImagePayload(
    eventType: number,
    data: ArrayBuffer,
  ): ComfyUIPreview | null {
    if (eventType === BINARY_PREVIEW_IMAGE_WITH_METADATA) {
      return this.parsePreviewImageWithMetadataPayload(data);
    }

    const bytes = new Uint8Array(data);
    const view = new DataView(data);

    // SaveImageWebsocket payloads often include an 8-byte header before image bytes.
    const mimeAt8 = this.detectMimeAtOffset(bytes, 8);
    if (mimeAt8) {
      return this.createPreview(data, 8, mimeAt8);
    }

    // Some preview payloads include only a 4-byte event header.
    const mimeAt4 = this.detectMimeAtOffset(bytes, 4);
    if (mimeAt4) {
      return this.createPreview(data, 4, mimeAt4);
    }

    const mimeAtVhsOffset = this.detectMimeAtOffset(
      bytes,
      VHS_LATENT_PREVIEW_IMAGE_OFFSET,
    );
    if (mimeAtVhsOffset) {
      const nodeId = this.decodePascalString(
        bytes.slice(
          VHS_LATENT_PREVIEW_NODE_ID_OFFSET,
          VHS_LATENT_PREVIEW_NODE_ID_OFFSET + VHS_LATENT_PREVIEW_NODE_ID_LENGTH,
        ),
      );
      const sequenceMetadata = nodeId
        ? this.findPreviewSequenceMetadata(nodeId)
        : null;

      return this.createPreview(
        data,
        VHS_LATENT_PREVIEW_IMAGE_OFFSET,
        mimeAtVhsOffset,
        {
          frameIndex: view.getUint32(VHS_LATENT_PREVIEW_FRAME_INDEX_OFFSET, false),
          frameRate: sequenceMetadata?.frameRate,
          nodeId: sequenceMetadata?.nodeId ?? nodeId,
          totalFrames: sequenceMetadata?.totalFrames,
        },
      );
    }

    const discoveredPayload = this.findImagePayload(bytes, 4);
    if (discoveredPayload) {
      return this.createPreview(
        data,
        discoveredPayload.payloadOffset,
        discoveredPayload.mimeType,
      );
    }

    // Fallback: infer MIME from the secondary header value when present.
    if (data.byteLength >= 8) {
      const imageType = view.getUint32(4, false);
      if (imageType === 1) {
        return this.createPreview(data, 8, "image/jpeg");
      }
      if (imageType === 2) {
        return this.createPreview(data, 8, "image/png");
      }
      return this.createPreview(data, 8, "application/octet-stream");
    }

    return this.createPreview(data, 4, "application/octet-stream");
  }

  private parsePreviewImageWithMetadataPayload(
    data: ArrayBuffer,
  ): ComfyUIPreview | null {
    if (data.byteLength < 8) {
      return null;
    }

    const bytes = new Uint8Array(data);
    const view = new DataView(data);
    const metadataLength = view.getUint32(4, false);
    const metadataStart = 8;
    const payloadOffset = metadataStart + metadataLength;

    if (payloadOffset > data.byteLength) {
      return null;
    }

    let metadata:
      | {
          image_type?: string;
          node_id?: string;
          prompt_id?: string;
        }
      | null = null;

    if (metadataLength > 0) {
      try {
        metadata = JSON.parse(
          this.textDecoder.decode(bytes.slice(metadataStart, payloadOffset)),
        ) as {
          image_type?: string;
          node_id?: string;
          prompt_id?: string;
        };
      } catch {
        metadata = null;
      }
    }

    const mimeType =
      metadata?.image_type ??
      this.detectMimeAtOffset(bytes, payloadOffset) ??
      "application/octet-stream";

    return this.createPreview(data, payloadOffset, mimeType, {
      nodeId: metadata?.node_id,
      promptId: metadata?.prompt_id,
    });
  }

  private createPreview(
    data: ArrayBuffer,
    payloadOffset: number,
    mimeType: string,
    metadata: Omit<ComfyUIPreview, "blob"> = {},
  ): ComfyUIPreview {
    const imageData = data.slice(payloadOffset);
    return {
      ...metadata,
      blob: new Blob([imageData], { type: mimeType }),
    };
  }

  private detectMimeAtOffset(bytes: Uint8Array, offset: number): string | null {
    if (offset >= bytes.length) return null;
    if (this.matchesSignature(bytes, offset, PNG_SIGNATURE)) {
      return "image/png";
    }
    if (this.matchesSignature(bytes, offset, JPEG_SIGNATURE)) {
      return "image/jpeg";
    }
    return null;
  }

  private findImagePayload(
    bytes: Uint8Array,
    startOffset: number,
  ): { payloadOffset: number; mimeType: string } | null {
    const maxOffset = Math.min(
      bytes.length,
      Math.max(startOffset, MAX_PREVIEW_SIGNATURE_OFFSET),
    );

    for (let offset = startOffset; offset < maxOffset; offset += 1) {
      const mimeType = this.detectMimeAtOffset(bytes, offset);
      if (mimeType) {
        return { payloadOffset: offset, mimeType };
      }
    }

    return null;
  }

  private decodePascalString(bytes: Uint8Array): string | undefined {
    if (bytes.length === 0) return undefined;
    const stringLength = Math.min(bytes[0], bytes.length - 1);
    if (stringLength <= 0) return undefined;
    return this.textDecoder.decode(bytes.slice(1, stringLength + 1));
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

  private isComfyUIEvent(event: unknown): event is ComfyUIEvent {
    if (!event || typeof event !== "object") {
      return false;
    }

    const eventType = (event as { type?: unknown }).type;
    return (
      eventType === "status" ||
      eventType === "progress" ||
      eventType === "executing" ||
      eventType === "executed" ||
      eventType === "execution_error" ||
      eventType === "error"
    );
  }

  private isVhsLatentPreviewEvent(
    event: unknown,
  ): event is ComfyUIVhsLatentPreviewEvent {
    if (!event || typeof event !== "object") {
      return false;
    }

    return (event as { type?: unknown }).type === "VHS_latentpreview";
  }

  private matchesSignature(
    bytes: Uint8Array,
    offset: number,
    signature: number[],
  ): boolean {
    if (offset + signature.length > bytes.length) return false;
    for (let i = 0; i < signature.length; i += 1) {
      if (bytes[offset + i] !== signature[i]) {
        return false;
      }
    }
    return true;
  }

  private notifyConnectionChange(state: ComfyUIConnectionState): void {
    for (const handler of this.connectionChangeHandlers) {
      handler(state);
    }
  }
}
