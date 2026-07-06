import { useState, useRef, useEffect, useCallback } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  IconButton,
  Dialog,
  Tooltip,
  Typography,
  CircularProgress,
} from "@mui/material";
import {
  Close,
  OpenInNew,
  PhotoLibrary,
  Settings,
  Timeline,
} from "@mui/icons-material";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import type { Asset, AssetType } from "../../../types/Asset";
import { useGenerationStore } from "../useGenerationStore";
import { dropAssetIntoComfyCanvas } from "../services/comfyAssetDrop";
import {
  buildWorkflowResultFromGraphData,
  type WorkflowReadResult,
} from "../services/workflowBridge";
import {
  iframeBridge,
  type BridgeHealth,
  type BridgeWorkflowSnapshot,
} from "../services/iframeBridgeClient";
import {
  injectWorkflowAndRead,
  readWorkflowWithRetry,
  waitForAppReady,
  type ShouldAbort,
} from "../services/workflowSyncController";
import {
  adoptIframeGeneration,
  reportIframeGenerationProgress,
} from "../services/generationDeliveryApi";
import { useProjectStore } from "../../project";
import { useExtractStore } from "../../../core/extract/useExtractStore";
import { playbackClock } from "../../../core/playback/PlaybackClock";
import { usePlayerStore } from "../../player";
import {
  createTimelineSelection,
  getDefaultSelectionEnd,
  useTimelineSelectionStore,
} from "../../timelineSelection";
import {
  createDefaultIframeTimelineSelectionSettings,
  getIframeTimelineSelectionGenerationMetadata,
  processIframeTimelineSelection,
  useIframeTimelineSelectionStore,
  type IframeTimelineSelectionSettings,
} from "../iframeTimelineSelection";
import {
  IframeAssetDock,
  type IframeAssetDockTab,
} from "../iframeTimelineSelection/IframeAssetDock";
import { IframeTimelineSelectionSettingsDialog } from "../iframeTimelineSelection/IframeTimelineSelectionSettingsDialog";

const HEALTH_WATCHDOG_MS = 10_000;
const IFRAME_PROGRESS_THROTTLE_MS = 250;
const APP_READY_TIMEOUT_MS = 10_000;
const RECOVERY_POLL_MS = 3000;
const MAX_CONSECUTIVE_READ_FAILURES = 3;
const MAX_CONSECUTIVE_BACKEND_DISCONNECTS = 3;
const RECOVERY_RELOAD_COOLDOWN_MS = 2000;
const VISIBILITY_RESUME_GRACE_MS = 5000;
const CONNECTING_HELPER_TEXT = "Connecting to ComfyUI...";
const RECONNECTING_HELPER_TEXT = "Reconnecting to ComfyUI...";
const ASSET_DOCK_WIDTH = 396;
const DROP_FEEDBACK_TTL_MS = 4000;

/** Droppable over the ComfyUI canvas while an asset drag is active. The
 * Editor's collision detection gives it top priority. */
export const COMFYUI_CANVAS_DROP_ID = "comfyui-editor-canvas-drop";
/** Full-screen droppable sink under the canvas zone that swallows drops so
 * they never reach droppables hidden beneath the editor overlay (timeline
 * tracks, generation panel slots). */
export const COMFYUI_EDITOR_DROP_SINK_ID = "comfyui-editor-drop-sink";

const CANVAS_DROP_ACCEPT: AssetType[] = ["video", "image", "audio"];

interface ComfyUIEditorProps {
  open: boolean;
  onClose: () => void;
}

interface DropFeedback {
  tone: "pending" | "success" | "error";
  message: string;
}

function ComfyUIDropSink() {
  const { setNodeRef } = useDroppable({
    id: COMFYUI_EDITOR_DROP_SINK_ID,
    // An asset-slot that accepts nothing: useAssetDrag swallows the drop
    // without invoking timeline insertion for droppables hidden underneath.
    data: { type: "asset-slot", accept: [] },
  });

  return (
    <Box
      ref={setNodeRef}
      data-testid="comfyui-editor-drop-sink"
      sx={{ position: "absolute", inset: 0, zIndex: 20 }}
    />
  );
}

function ComfyUICanvasDropZone({
  leftOffset,
  onDropAsset,
}: {
  leftOffset: number;
  onDropAsset: (
    asset: Asset,
    pointer: { clientX: number; clientY: number } | null,
  ) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: COMFYUI_CANVAS_DROP_ID,
    data: {
      type: "asset-slot",
      accept: CANVAS_DROP_ACCEPT,
      onDrop: onDropAsset,
    },
  });

  return (
    <Box
      ref={setNodeRef}
      data-testid="comfyui-canvas-drop-zone"
      sx={{
        position: "absolute",
        top: 0,
        bottom: 0,
        right: 0,
        left: leftOffset,
        zIndex: 21,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        border: isOver ? "2px dashed #4dabf5" : "2px dashed transparent",
        bgcolor: isOver ? "rgba(77, 171, 245, 0.08)" : "transparent",
        transition: "background-color 0.15s, border-color 0.15s",
      }}
    >
      {isOver && (
        <Typography
          variant="caption"
          sx={{
            mt: 6,
            px: 2,
            py: 0.75,
            borderRadius: 1,
            bgcolor: "rgba(18, 18, 18, 0.92)",
            color: "#c9d1d9",
            pointerEvents: "none",
          }}
        >
          Drop to add to the ComfyUI graph
        </Typography>
      )}
    </Box>
  );
}

/**
 * Returns a same-origin URL for the ComfyUI iframe.
 *
 * Same-origin is required by the authenticated postMessage bridge and by the
 * backend's hosted ComfyUI extension-module proxy.
 */
function getSameOriginUrl(): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/comfyui-frame/`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildWorkflowSignature(
  graphData: Record<string, unknown> | null,
  workflowId: string | null,
): string | null {
  if (!graphData) return workflowId;

  try {
    return JSON.stringify({
      workflowId,
      graphData,
    });
  } catch {
    return workflowId;
  }
}

export function ComfyUIEditor({ open, onClose }: ComfyUIEditorProps) {
  const comfyuiDirectUrl = useGenerationStore((s) => s.comfyuiDirectUrl);
  const registerEditor = useGenerationStore((s) => s.registerEditor);
  const unregisterEditor = useGenerationStore((s) => s.unregisterEditor);
  const registerWorkflowFromEditor = useGenerationStore(
    (s) => s.registerWorkflowFromEditor,
  );
  const inputNodeMap = useGenerationStore((s) => s.inputNodeMap);
  const rawObjectInfo = useGenerationStore((s) => s.rawObjectInfo);
  const editorNeedsReconnect = useGenerationStore(
    (s) => s.editorNeedsReconnect,
  );
  const editorReconnectSignal = useGenerationStore(
    (s) => s.editorReconnectSignal,
  );
  const setEditorNeedsReconnect = useGenerationStore(
    (s) => s.setEditorNeedsReconnect,
  );
  const connectionStatus = useGenerationStore((s) => s.connectionStatus);
  const comfyQueueRemaining = useGenerationStore((s) => s.comfyQueueRemaining);
  const [loading, setLoading] = useState(true);
  const [appReady, setAppReady] = useState(false);
  const [assetDockOpen, setAssetDockOpen] = useState(false);
  const [assetDockTab, setAssetDockTab] =
    useState<IframeAssetDockTab>("assets");
  const [selectionSettingsOpen, setSelectionSettingsOpen] = useState(false);
  const [selectionSettings, setSelectionSettings] =
    useState<IframeTimelineSelectionSettings>(() =>
      createDefaultIframeTimelineSelectionSettings(),
    );
  const [selectionProcessing, setSelectionProcessing] = useState(false);
  const [dropFeedback, setDropFeedback] = useState<DropFeedback | null>(null);
  const dropFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const dropRequestIdRef = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const { active: activeDrag } = useDndContext();
  const isAssetDragActive =
    open && activeDrag?.data.current?.type === "asset";

  const iframeRefCb = useCallback(
    (node: HTMLIFrameElement | null) => {
      if (node) {
        registerEditor(node);
      } else {
        unregisterEditor();
      }
      iframeRef.current = node;
    },
    [registerEditor, unregisterEditor],
  );

  const wasOpenRef = useRef(open);
  const lastDirectUrlRef = useRef<string | null>(comfyuiDirectUrl);
  const pollingRef = useRef(false);
  const consecutiveReadFailuresRef = useRef(0);
  const consecutiveBackendDisconnectsRef = useRef(0);
  const initRunIdRef = useRef(0);
  const initPromiseRef = useRef<Promise<boolean> | null>(null);
  const lastRecoveryAtRef = useRef(0);
  const lastWorkflowSignatureRef = useRef<string | null>(null);
  const visibilityResumeGraceUntilRef = useRef(0);

  const iframeUrl = comfyuiDirectUrl ? getSameOriginUrl() : null;

  const showTransientDropFeedback = useCallback(
    (tone: "success" | "error", message: string) => {
      setDropFeedback({ tone, message });
      if (dropFeedbackTimerRef.current) {
        clearTimeout(dropFeedbackTimerRef.current);
      }
      dropFeedbackTimerRef.current = setTimeout(() => {
        dropFeedbackTimerRef.current = null;
        setDropFeedback(null);
      }, DROP_FEEDBACK_TTL_MS);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (dropFeedbackTimerRef.current) {
        clearTimeout(dropFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleCanvasAssetDrop = useCallback(
    (asset: Asset, pointer: { clientX: number; clientY: number } | null) => {
      const iframe = iframeRef.current;
      if (!iframe || !pointer) return;
      const iframeRect = iframe.getBoundingClientRect();
      const requestId = ++dropRequestIdRef.current;

      if (dropFeedbackTimerRef.current) {
        clearTimeout(dropFeedbackTimerRef.current);
        dropFeedbackTimerRef.current = null;
      }
      setDropFeedback({
        tone: "pending",
        message: `Adding ${asset.name} to ComfyUI...`,
      });

      const { inputNodeMap, rawObjectInfo } = useGenerationStore.getState();
      void dropAssetIntoComfyCanvas({
        asset,
        clientX: pointer.clientX - iframeRect.left,
        clientY: pointer.clientY - iframeRect.top,
        inputNodeMap,
        rawObjectInfo,
      })
        .then((result) => {
          if (requestId !== dropRequestIdRef.current) return;
          useIframeTimelineSelectionStore
            .getState()
            .bindNodeToAsset(result.nodeId, asset.id);
          showTransientDropFeedback(
            "success",
            result.action === "updated"
              ? `Updated ${result.classType || "loader"} with ${asset.name}`
              : `Added ${result.classType || "loader"} for ${asset.name}`,
          );
        })
        .catch((error) => {
          if (requestId !== dropRequestIdRef.current) return;
          console.warn("[ComfyUIEditor] Asset drop failed", error);
          showTransientDropFeedback(
            "error",
            error instanceof Error
              ? error.message
              : "Failed to add the asset to ComfyUI",
          );
        });
    },
    [showTransientDropFeedback],
  );

  const handleSelectFromTimeline = useCallback(() => {
    if (selectionProcessing) return;

    const playerStore = usePlayerStore.getState();
    if (playerStore.isPlaying) {
      playerStore.setIsPlaying(false);
    }

    const selectionStore = useTimelineSelectionStore.getState();
    selectionStore.clearSelectionRecommendations();
    selectionStore.setSelectionFpsOverride(null);
    selectionStore.setSelectionFrameStep(1);
    const startTick = playbackClock.time;
    const endTick = getDefaultSelectionEnd(startTick);
    const settingsSnapshot = structuredClone(selectionSettings);
    const extractStore = useExtractStore.getState();

    extractStore.setOnCancelSelection(() => {
      useGenerationStore.getState().setEditorOpen(true);
    });
    extractStore.setOnConfirmSelection(() => {
      void (async () => {
        const currentSelectionStore = useTimelineSelectionStore.getState();
        const timelineSelection = createTimelineSelection(
          currentSelectionStore.selectionStartTick,
          currentSelectionStore.selectionEndTick,
        );
        currentSelectionStore.exitSelectionMode();
        const currentExtractStore = useExtractStore.getState();
        currentExtractStore.setOnConfirmSelection(null);
        currentExtractStore.setOnCancelSelection(null);
        useGenerationStore.getState().setEditorOpen(true);

        setSelectionProcessing(true);
        setDropFeedback({
          tone: "pending",
          message: "Rendering timeline selection...",
        });
        try {
          const processed = await processIframeTimelineSelection(
            timelineSelection,
            settingsSnapshot,
          );
          await useIframeTimelineSelectionStore
            .getState()
            .storeProcessedSelection(processed);
          setAssetDockTab("temporary");
          setAssetDockOpen(true);
          showTransientDropFeedback(
            "success",
            processed.mask
              ? "Timeline video and transparency mask are ready"
              : "Timeline video is ready",
          );
        } catch (error) {
          console.error("[ComfyUIEditor] Timeline selection failed", error);
          showTransientDropFeedback(
            "error",
            error instanceof Error
              ? error.message
              : "Failed to render timeline selection",
          );
        } finally {
          setSelectionProcessing(false);
        }
      })();
    });

    useGenerationStore.getState().setEditorOpen(false);
    selectionStore.enterSelectionMode(startTick, endTick, {
      message: "Choose which timeline tracks to include in the ComfyUI input.",
      includeTracks: true,
      allowIncludeAll: true,
    });
  }, [selectionProcessing, selectionSettings, showTransientDropFeedback]);

  const rememberWorkflowSignature = useCallback(
    (
      graphData: Record<string, unknown> | null,
      workflowId: string | null,
    ) => {
      const signature = buildWorkflowSignature(graphData, workflowId);
      lastWorkflowSignatureRef.current = signature;
    },
    [],
  );

  const buildWorkflowResult = useCallback(
    (snapshot: BridgeWorkflowSnapshot) =>
      buildWorkflowResultFromGraphData(snapshot.graphData, snapshot.filename, {
        inputNodeMap,
        objectInfo: rawObjectInfo,
        workflowInstanceId: snapshot.workflowInstanceId,
        revision: snapshot.revision,
      }),
    [inputNodeMap, rawObjectInfo],
  );

  const commitWorkflowResult = useCallback(
    async (result: WorkflowReadResult, force = false) => {
      const workflowId =
        result.filename ?? useGenerationStore.getState().selectedWorkflowId;
      const signature = buildWorkflowSignature(result.graphData, workflowId);
      if (!force && signature === lastWorkflowSignatureRef.current) {
        return;
      }

      lastWorkflowSignatureRef.current = signature;
      await registerWorkflowFromEditor(
        result.workflow,
        result.graphData,
        result.inputs,
        result.filename,
        typeof result.workflowInstanceId === "string" &&
        typeof result.revision === "number"
          ? {
              workflowInstanceId: result.workflowInstanceId,
              revision: result.revision,
            }
          : null,
      );
    },
    [registerWorkflowFromEditor],
  );

  const recoverIframe = useCallback(
    (reason: string) => {
      const now = Date.now();
      if (now - lastRecoveryAtRef.current < RECOVERY_RELOAD_COOLDOWN_MS) return;
      lastRecoveryAtRef.current = now;

      const iframe = iframeRef.current;
      if (!iframe) return;

      // Cancel any in-flight init/poll attempt before forcing a reload.
      initRunIdRef.current += 1;
      initPromiseRef.current = null;
      consecutiveReadFailuresRef.current = 0;
      consecutiveBackendDisconnectsRef.current = 0;
      lastWorkflowSignatureRef.current = null;
      setAppReady(false);
      setLoading(true);
      setEditorNeedsReconnect(false);
      useGenerationStore.getState().setWorkflowLoading(true);
      useGenerationStore.setState({
        iframeWorkflowInstanceId: null,
        iframeWorkflowRevision: null,
      });

      console.warn(`[ComfyUIEditor] Recovering iframe: ${reason}`);

      try {
        iframe.contentWindow?.location.reload();
      } catch {
        // Fallback if contentWindow navigation is blocked.
        const currentSrc = iframe.getAttribute("src");
        if (currentSrc) {
          iframe.setAttribute("src", currentSrc);
        } else if (iframeUrl) {
          iframe.src = iframeUrl;
        }
      }
      // Pending bridge requests belong to the old document.
      iframeBridge.notifyIframeReloaded();
    },
    [iframeUrl, setEditorNeedsReconnect],
  );

  const initializeIframe = useCallback(() => {
    if (initPromiseRef.current) return initPromiseRef.current;

    const runId = ++initRunIdRef.current;
    setLoading(true);
    setAppReady(false);
    setEditorNeedsReconnect(false);
    lastWorkflowSignatureRef.current = null;

    const promise = (async () => {
      // Wait for the iframe element to mount
      while (!iframeRef.current) {
        if (runId !== initRunIdRef.current) return false;
        await sleep(100);
      }

      const iframe = iframeRef.current;
      const shouldAbort: ShouldAbort = () =>
        runId !== initRunIdRef.current ||
        iframeRef.current !== iframe ||
        !iframe.isConnected;

      // 1. Wait for the ComfyUI app object
      const ready = await waitForAppReady(
        iframe,
        shouldAbort,
        APP_READY_TIMEOUT_MS,
      );
      if (!ready) {
        if (!shouldAbort()) {
          setEditorNeedsReconnect(true);
          // If the backend reports ComfyUI as reachable but the bridge never
          // announced, the iframe likely loaded a dead/stale page (e.g.
          // ComfyUI was down on first load). Trigger recovery.
          if (
            useGenerationStore.getState().connectionStatus === "connected"
          ) {
            recoverIframe("app initialization failed while backend connected");
          }
        }
        return false;
      }

      // 2. Restore selected workflow through the store-owned workflow sync flow.
      const { selectedWorkflowId, loadWorkflow, syncedGraphData, isWorkflowReady } =
        useGenerationStore.getState();

      if (selectedWorkflowId) {
        if (shouldAbort()) return false;

        if (isWorkflowReady && syncedGraphData) {
          // Reuse the already-synced graph when reopening the editor so
          // transient media inputs such as timeline selections remain attached
          // to the current workflow state.
          const syncResult = await injectWorkflowAndRead(
            iframe,
            syncedGraphData,
            selectedWorkflowId,
            shouldAbort,
            inputNodeMap,
            rawObjectInfo,
          );
          if (shouldAbort()) return false;

          useGenerationStore.setState({
            workflowWarning: syncResult.warnings,
          });

          if (!syncResult.workflowResult) {
            setEditorNeedsReconnect(true);
            return false;
          }

          useGenerationStore
            .getState()
            .syncWorkflow(
              syncResult.workflowResult.workflow,
              syncResult.workflowResult.graphData,
              syncResult.workflowResult.inputs,
              {
                bridgeIdentity:
                  typeof syncResult.workflowResult.workflowInstanceId ===
                    "string" &&
                  typeof syncResult.workflowResult.revision === "number"
                    ? {
                        workflowInstanceId:
                          syncResult.workflowResult.workflowInstanceId,
                        revision: syncResult.workflowResult.revision,
                      }
                    : null,
              },
            );
          rememberWorkflowSignature(
            syncResult.workflowResult.graphData,
            selectedWorkflowId,
          );
        } else {
          await loadWorkflow(selectedWorkflowId);
          if (shouldAbort()) return false;
          rememberWorkflowSignature(
            useGenerationStore.getState().syncedGraphData,
            selectedWorkflowId,
          );
        }
      } else {
        // No selected workflow yet: sync the current graph as discovered from iframe.
        const firstResult = await readWorkflowWithRetry(
          iframe,
          shouldAbort,
          APP_READY_TIMEOUT_MS,
          inputNodeMap,
          rawObjectInfo,
        );
        if (!firstResult) {
          if (!shouldAbort()) {
            setEditorNeedsReconnect(true);
          }
          return false;
        }
        useGenerationStore
          .getState()
          .syncWorkflow(
            firstResult.workflow,
            firstResult.graphData,
            firstResult.inputs,
            {
              bridgeIdentity:
                typeof firstResult.workflowInstanceId === "string" &&
                typeof firstResult.revision === "number"
                  ? {
                      workflowInstanceId: firstResult.workflowInstanceId,
                      revision: firstResult.revision,
                    }
                  : null,
            },
          );
        rememberWorkflowSignature(firstResult.graphData, firstResult.filename);
      }

      if (shouldAbort()) return false;

      consecutiveReadFailuresRef.current = 0;
      consecutiveBackendDisconnectsRef.current = 0;
      setAppReady(true);
      setLoading(false);
      setEditorNeedsReconnect(false);
      return true;
    })();

    initPromiseRef.current = promise;
    return promise.finally(() => {
      if (initPromiseRef.current === promise) {
        initPromiseRef.current = null;
      }
    });
  }, [
    inputNodeMap,
    rawObjectInfo,
    recoverIframe,
    rememberWorkflowSignature,
    setEditorNeedsReconnect,
  ]);

  // Cleanup async guards on unmount
  useEffect(() => {
    return () => {
      initRunIdRef.current += 1;
      initPromiseRef.current = null;
      consecutiveReadFailuresRef.current = 0;
      consecutiveBackendDisconnectsRef.current = 0;
      lastWorkflowSignatureRef.current = null;
    };
  }, []);

  // The iframe src stays constant (/comfyui-frame/), so explicitly reload when
  // the configured upstream ComfyUI URL changes.
  useEffect(() => {
    const prev = lastDirectUrlRef.current;
    lastDirectUrlRef.current = comfyuiDirectUrl;

    if (!prev || !comfyuiDirectUrl || prev === comfyuiDirectUrl) return;
    recoverIframe("ComfyUI URL changed");
  }, [comfyuiDirectUrl, recoverIframe]);

  // Manual reconnect is triggered from GenerationPanel and propagated via store.
  useEffect(() => {
    if (editorReconnectSignal === 0) return;
    recoverIframe("manual reconnect requested");
  }, [editorReconnectSignal, recoverIframe]);

  // The iframe is mounted on first render and stays alive across open/close
  // cycles, but the recovery loop below (and the iframe `onLoad` initializer)
  // are gated on `open`. If the user starts vlo before ComfyUI, the iframe
  // proxy returns 502 on first load; the user typically never opens this
  // dialog, so nothing here notices when ComfyUI later comes up — the iframe
  // stays on the dead 502 page and the panel spins on "Loading inputs..."
  // forever. Watch for the disconnected→connected transition globally and
  // reload the iframe if its app object never appeared.
  useEffect(() => {
    if (connectionStatus !== "connected") return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (iframeBridge.isReady) return;
    recoverIframe("ComfyUI became reachable; iframe app never initialized");
  }, [connectionStatus, recoverIframe]);

  const syncLatestWorkflowFromIframe = useCallback(async () => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const activeWorkflow = await iframeBridge.readActive();
    if (!activeWorkflow) {
      return;
    }

    await commitWorkflowResult(buildWorkflowResult(activeWorkflow), true);
  }, [buildWorkflowResult, commitWorkflowResult]);

  // Graph edits are pushed by the hosted vlo bridge (debounced inside the
  // iframe), replacing the previous full-graph read poll.
  useEffect(() => {
    return iframeBridge.onGraphChanged((snapshot) => {
      void commitWorkflowResult(buildWorkflowResult(snapshot));
    });
  }, [buildWorkflowResult, commitWorkflowResult]);

  const applyHealth = useCallback(
    (health: BridgeHealth) => {
      if (health.appReady && health.backendConnected) {
        consecutiveReadFailuresRef.current = 0;
        consecutiveBackendDisconnectsRef.current = 0;
        setEditorNeedsReconnect(false);
        return;
      }
      consecutiveReadFailuresRef.current += 1;
      if (!health.backendConnected) {
        if (Date.now() < visibilityResumeGraceUntilRef.current) return;
        consecutiveBackendDisconnectsRef.current += 1;
        setEditorNeedsReconnect(true);
        if (
          consecutiveBackendDisconnectsRef.current >=
          MAX_CONSECUTIVE_BACKEND_DISCONNECTS
        ) {
          recoverIframe("backend socket disconnected");
        }
        return;
      }
      consecutiveBackendDisconnectsRef.current = 0;
      if (consecutiveReadFailuresRef.current >= MAX_CONSECUTIVE_READ_FAILURES) {
        recoverIframe("repeated bridge health failures");
      }
    },
    [recoverIframe, setEditorNeedsReconnect],
  );

  useEffect(() => iframeBridge.onHealthChanged(applyHealth), [applyHealth]);

  // Adopt generations the user launches from inside the ComfyUI editor. The
  // bridge observes the iframe's own execution events; we attach the active
  // project (attribution ComfyUI can't do) so outputs import as deliveries.
  // The backend backstop owns settlement — this only starts and reports
  // progress, so failures here are non-fatal.
  useEffect(() => {
    const lastProgressAt = new Map<string, number>();
    return iframeBridge.onIframeGeneration((generation) => {
      const projectId = useProjectStore.getState().project?.id;
      if (!projectId) return;

      if (generation.phase === "started") {
        void adoptIframeGeneration(projectId, generation.promptId, {
          generationMetadata: getIframeTimelineSelectionGenerationMetadata(),
        }).catch(
          (error) => {
            console.warn(
              "[ComfyUIEditor] Failed to adopt in-editor generation",
              error,
            );
          },
        );
        return;
      }

      if (generation.phase === "finished") {
        lastProgressAt.delete(generation.promptId);
        return;
      }

      if (
        generation.value === null ||
        generation.max === null ||
        generation.max <= 0
      ) {
        return;
      }
      const now = Date.now();
      if (
        now - (lastProgressAt.get(generation.promptId) ?? 0) <
        IFRAME_PROGRESS_THROTTLE_MS
      ) {
        return;
      }
      lastProgressAt.set(generation.promptId, now);
      const progress = Math.max(
        0,
        Math.min(100, Math.round((generation.value / generation.max) * 100)),
      );
      void reportIframeGenerationProgress(projectId, generation.promptId, {
        progress,
        node: generation.node,
      }).catch(() => {
        // Best-effort; the backstop still settles the delivery.
      });
    });
  }, []);

  const pollWorkflow = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      const iframe = iframeRef.current;
      if (!iframe) return;

      if (!iframeBridge.isReady) {
        applyHealth({ appReady: false, backendConnected: false });
        return;
      }
      try {
        applyHealth(await iframeBridge.health());
      } catch {
        applyHealth({ appReady: false, backendConnected: false });
      }
    } finally {
      pollingRef.current = false;
    }
  }, [applyHealth]);

  // On close, always do one last read to capture unsynced edits.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;

    if (wasOpen && !open) {
      void syncLatestWorkflowFromIframe();
    }
  }, [open, syncLatestWorkflowFromIframe]);

  // Unified health-check interval: retries init when not ready, polls when ready.
  useEffect(() => {
    if (!open) return;

    const tick = () => {
      if (appReady) {
        pollWorkflow();
      } else {
        initializeIframe();
      }
    };

    tick();

    const interval = appReady ? HEALTH_WATCHDOG_MS : RECOVERY_POLL_MS;
    const timer = setInterval(tick, interval);
    return () => clearInterval(timer);
  }, [open, appReady, initializeIframe, pollWorkflow]);

  // Re-derive panel inputs when the parsing context (object_info / node map)
  // changes; the graph itself is unchanged so force a re-commit.
  useEffect(() => {
    if (!open || !appReady) {
      return;
    }

    lastWorkflowSignatureRef.current = null;
    void syncLatestWorkflowFromIframe();
  }, [open, appReady, inputNodeMap, rawObjectInfo, syncLatestWorkflowFromIframe]);

  // When the user returns to the tab, do a quick health check. We give the
  // iframe a short grace period because browsers can briefly suspend sockets
  // while the page is backgrounded, and an immediate forced reload would wipe
  // unsaved ComfyUI edits.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !open) return;
      visibilityResumeGraceUntilRef.current =
        Date.now() + VISIBILITY_RESUME_GRACE_MS;

      const iframe = iframeRef.current;
      if (!iframe) return;

      if (!iframeBridge.isReady) {
        setAppReady(false);
        void initializeIframe();
        return;
      }

      if (appReady) {
        pollWorkflow();
      } else {
        initializeIframe();
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [open, appReady, initializeIframe, pollWorkflow]);

  if (!iframeUrl) {
    if (!open) return null;
    return (
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <Box sx={{ p: 4, textAlign: "center" }}>
          <Typography color="text.secondary">
            ComfyUI URL not available. Check that the backend is connected.
          </Typography>
        </Box>
      </Dialog>
    );
  }

  // Fixed-position overlay instead of Dialog to keep the iframe alive across
  // open/close cycles (Dialog reparents children via Portal, causing reload).
  return (
    <Box
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        bgcolor: "#1e1e1e",
        display: open ? "flex" : "none",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          px: 2,
          py: 1,
          bgcolor: "#111",
          borderBottom: "1px solid #333",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Typography variant="subtitle1" sx={{ color: "#ccc" }}>
            ComfyUI Node Editor
          </Typography>
          <Button
            size="small"
            startIcon={<PhotoLibrary fontSize="small" />}
            onClick={() => setAssetDockOpen((current) => !current)}
            aria-pressed={assetDockOpen}
            data-testid="comfyui-asset-dock-toggle"
            sx={{
              color: assetDockOpen ? "#4dabf5" : "#888",
              textTransform: "none",
              minWidth: 0,
            }}
          >
            Assets
          </Button>
          <ButtonGroup
            size="small"
            variant="outlined"
            disabled={selectionProcessing}
            data-testid="comfyui-timeline-selection-controls"
          >
            <Button
              startIcon={
                selectionProcessing ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <Timeline fontSize="small" />
                )
              }
              onClick={handleSelectFromTimeline}
              data-testid="comfyui-select-from-timeline"
              sx={{ color: "#aaa", textTransform: "none" }}
            >
              Select from timeline
            </Button>
            <Tooltip title="Timeline selection settings">
              <span>
                <Button
                  aria-label="Timeline selection settings"
                  onClick={() => setSelectionSettingsOpen(true)}
                  disabled={selectionProcessing}
                  data-testid="comfyui-timeline-selection-settings"
                  sx={{ color: "#aaa", minWidth: 34, px: 0.75 }}
                >
                  <Settings fontSize="small" />
                </Button>
              </span>
            </Tooltip>
          </ButtonGroup>
          {typeof comfyQueueRemaining === "number" && comfyQueueRemaining > 0 && (
            <Typography
              variant="caption"
              sx={{ color: "#f0a020", whiteSpace: "nowrap" }}
            >
              {comfyQueueRemaining} in ComfyUI queue
            </Typography>
          )}
        </Box>
        <Box>
          <IconButton
            size="small"
            component="a"
            href={iframeUrl}
            target="_blank"
            rel="noopener noreferrer"
            sx={{ color: "text.secondary", mr: 1 }}
          >
            <OpenInNew fontSize="small" />
          </IconButton>
          <IconButton
            size="small"
            onClick={onClose}
            aria-label="Close editor"
            sx={{ color: "text.secondary" }}
          >
            <Close />
          </IconButton>
        </Box>
      </Box>

      {/* Iframe */}
      <Box sx={{ flexGrow: 1, position: "relative" }}>
        {loading && open && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: "#1e1e1e",
              zIndex: 10,
              gap: 1.5,
            }}
          >
            {editorNeedsReconnect ? (
              <Typography variant="caption" sx={{ color: "#c9c9c9" }}>
                {RECONNECTING_HELPER_TEXT}
              </Typography>
            ) : (
              <>
                <CircularProgress />
                <Typography variant="caption" sx={{ color: "#c9c9c9" }}>
                  {CONNECTING_HELPER_TEXT}
                </Typography>
              </>
            )}
          </Box>
        )}
        <iframe
          ref={iframeRefCb}
          src={iframeUrl}
          onLoad={() => {
            if (open) {
              initializeIframe();
            }
          }}
          title="ComfyUI Node Editor"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
          }}
        />

        {/* Collapsible asset browser floating over the canvas. Mounted only
            while the editor is open: the browser is a singleton and the left
            sidebar's instance yields to this one (see EditorLeftSidebar). */}
        {open && assetDockOpen && (
          <Box
            data-testid="comfyui-asset-dock"
            sx={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: ASSET_DOCK_WIDTH,
              zIndex: 15,
              display: "flex",
              flexDirection: "column",
              bgcolor: "#121212",
              borderRight: "1px solid #333",
              boxShadow: "4px 0 12px rgba(0, 0, 0, 0.5)",
            }}
          >
            <IframeAssetDock
              activeTab={assetDockTab}
              onTabChange={setAssetDockTab}
            />
          </Box>
        )}

        {/* While an asset drag is live, cover the iframe so the parent keeps
            receiving pointer events and dnd-kit can resolve the drop. */}
        {isAssetDragActive && (
          <ComfyUICanvasDropZone
            leftOffset={assetDockOpen ? ASSET_DOCK_WIDTH : 0}
            onDropAsset={handleCanvasAssetDrop}
          />
        )}

        {dropFeedback && (
          <Box
            data-testid="comfyui-drop-feedback"
            sx={{
              position: "absolute",
              top: 12,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 30,
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 2,
              py: 0.75,
              borderRadius: 1,
              pointerEvents: "none",
              bgcolor:
                dropFeedback.tone === "error"
                  ? "rgba(211, 47, 47, 0.92)"
                  : dropFeedback.tone === "success"
                    ? "rgba(46, 125, 50, 0.92)"
                    : "rgba(18, 18, 18, 0.92)",
            }}
          >
            {dropFeedback.tone === "pending" && (
              <CircularProgress size={14} sx={{ color: "#c9d1d9" }} />
            )}
            <Typography variant="caption" sx={{ color: "#f1f3f4" }}>
              {dropFeedback.message}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Swallow drops anywhere over the editor (header, dock) so hidden
          droppables underneath never receive them. */}
      {isAssetDragActive && <ComfyUIDropSink />}
      <IframeTimelineSelectionSettingsDialog
        open={selectionSettingsOpen}
        settings={selectionSettings}
        onChange={setSelectionSettings}
        onClose={() => setSelectionSettingsOpen(false)}
      />
    </Box>
  );
}
