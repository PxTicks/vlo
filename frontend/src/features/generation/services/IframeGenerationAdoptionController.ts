import type { GeneratedCreationMetadata } from "../../../types/Asset";
import type { BridgeIframeGeneration } from "./iframeBridgeClient";
import {
  adoptIframeGeneration,
  reportIframeGenerationProgress,
} from "./generationDeliveryApi";

const ADOPTION_RETRY_BASE_MS = 1_000;
const ADOPTION_RETRY_MAX_MS = 30_000;
const ADOPTION_MAX_ATTEMPTS = 8;

type IframeGenerationMetadata = Pick<
  GeneratedCreationMetadata,
  "inputs" | "maskCropMetadata" | "targetResolution"
>;

interface PendingIframeGenerationAdoption {
  projectId: string;
  promptId: string;
  generationMetadata: IframeGenerationMetadata;
  adopted: boolean;
  terminal: boolean;
  attempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  latestProgress: { progress: number; node: string | null } | null;
}

interface IframeGenerationAdoptionDependencies {
  adopt: typeof adoptIframeGeneration;
  reportProgress: typeof reportIframeGenerationProgress;
  warn: (message: string, error: unknown) => void;
}

const DEFAULT_DEPENDENCIES: IframeGenerationAdoptionDependencies = {
  adopt: adoptIframeGeneration,
  reportProgress: reportIframeGenerationProgress,
  warn: (message, error) => console.warn(message, error),
};

export class IframeGenerationAdoptionController {
  private readonly dependencies: IframeGenerationAdoptionDependencies;
  private readonly pendingByPromptId = new Map<
    string,
    PendingIframeGenerationAdoption
  >();

  constructor(
    dependencies: IframeGenerationAdoptionDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.dependencies = dependencies;
  }

  observe(
    projectId: string,
    generation: BridgeIframeGeneration,
    generationMetadata: IframeGenerationMetadata,
  ): void {
    const pending =
      this.pendingByPromptId.get(generation.promptId) ??
      this.createPending(projectId, generation.promptId, generationMetadata);

    if (generation.phase === "finished") {
      pending.terminal = true;
    } else if (
      generation.phase === "progress" &&
      generation.value !== null &&
      generation.max !== null &&
      generation.max > 0
    ) {
      pending.latestProgress = {
        progress: Math.max(
          0,
          Math.min(
            100,
            Math.round((generation.value / generation.max) * 100),
          ),
        ),
        node: generation.node,
      };
    }

    if (pending.adopted) {
      this.reportLatestProgress(pending);
      this.removeIfSettled(pending);
      return;
    }

    this.startAdoption(pending);
  }

  dispose(): void {
    for (const pending of this.pendingByPromptId.values()) {
      if (pending.retryTimer !== null) {
        clearTimeout(pending.retryTimer);
      }
    }
    this.pendingByPromptId.clear();
  }

  private createPending(
    projectId: string,
    promptId: string,
    generationMetadata: IframeGenerationMetadata,
  ): PendingIframeGenerationAdoption {
    const pending: PendingIframeGenerationAdoption = {
      projectId,
      promptId,
      generationMetadata: structuredClone(generationMetadata),
      adopted: false,
      terminal: false,
      attempt: 0,
      retryTimer: null,
      inFlight: null,
      latestProgress: null,
    };
    this.pendingByPromptId.set(promptId, pending);
    return pending;
  }

  private startAdoption(pending: PendingIframeGenerationAdoption): void {
    if (pending.inFlight || pending.retryTimer !== null) {
      return;
    }

    pending.inFlight = this.dependencies
      .adopt(pending.projectId, pending.promptId, {
        generationMetadata: pending.generationMetadata,
      })
      .then(() => {
        if (this.pendingByPromptId.get(pending.promptId) !== pending) {
          return;
        }
        pending.adopted = true;
        pending.attempt = 0;
        this.reportLatestProgress(pending);
        this.removeIfSettled(pending);
      })
      .catch((error: unknown) => {
        if (this.pendingByPromptId.get(pending.promptId) !== pending) {
          return;
        }
        pending.attempt += 1;
        if (pending.attempt === 1) {
          this.dependencies.warn(
            "[ComfyUIEditor] Failed to adopt in-editor generation; retrying",
            error,
          );
        }
        if (pending.attempt >= ADOPTION_MAX_ATTEMPTS) {
          this.pendingByPromptId.delete(pending.promptId);
          this.dependencies.warn(
            "[ComfyUIEditor] Giving up fallback adoption after repeated failures",
            error,
          );
          return;
        }
        const delay = Math.min(
          ADOPTION_RETRY_BASE_MS * 2 ** (pending.attempt - 1),
          ADOPTION_RETRY_MAX_MS,
        );
        pending.retryTimer = setTimeout(() => {
          pending.retryTimer = null;
          this.startAdoption(pending);
        }, delay);
      })
      .finally(() => {
        pending.inFlight = null;
      });
  }

  private reportLatestProgress(
    pending: PendingIframeGenerationAdoption,
  ): void {
    const progress = pending.latestProgress;
    if (!progress) {
      return;
    }
    pending.latestProgress = null;
    void this.dependencies
      .reportProgress(pending.projectId, pending.promptId, progress)
      .catch(() => {
        // Settlement comes from the backend history/queue backstop.
      });
  }

  private removeIfSettled(pending: PendingIframeGenerationAdoption): void {
    if (pending.adopted && pending.terminal) {
      this.pendingByPromptId.delete(pending.promptId);
    }
  }
}

export const iframeGenerationAdoptionController =
  new IframeGenerationAdoptionController();
