import { useState, useRef, useEffect, useCallback } from "react";
import {
  Box,
  IconButton,
  Dialog,
  Typography,
  CircularProgress,
} from "@mui/material";
import { Close, OpenInNew } from "@mui/icons-material";
import { useGenerationStore } from "../useGenerationStore";
import {
  readWorkflowFromIframe,
  isIframeAppReady,
  isIframeBackendConnected,
} from "../services/workflowBridge";
import {
  injectWorkflowAndRead,
  readWorkflowWithRetry,
  waitForAppReady,
  type ShouldAbort,
} from "../services/workflowSyncController";

const POLL_INTERVAL_MS = 2000;
const APP_READY_TIMEOUT_MS = 10_000;
const RECOVERY_POLL_MS = 3000;
const MAX_CONSECUTIVE_READ_FAILURES = 3;
const RECOVERY_RELOAD_COOLDOWN_MS = 2000;
const CONNECTING_HELPER_TEXT = "Connecting to ComfyUI...";
const RECONNECTING_HELPER_TEXT = "Reconnecting to ComfyUI...";

interface ComfyUIEditorProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Returns a same-origin URL for the ComfyUI iframe.
 *
 * Same-origin is required so that the workflowBridge can access
 * iframe.contentWindow.app (different ports = different origin).
 */
function getSameOriginUrl(): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/comfyui-frame/`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ReadWorkflowResult = NonNullable<
  Awaited<ReturnType<typeof readWorkflowFromIframe>>
>;

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
  const editorNeedsReconnect = useGenerationStore(
    (s) => s.editorNeedsReconnect,
  );
  const editorReconnectSignal = useGenerationStore(
    (s) => s.editorReconnectSignal,
  );
  const setEditorNeedsReconnect = useGenerationStore(
    (s) => s.setEditorNeedsReconnect,
  );
  const [loading, setLoading] = useState(true);
  const [appReady, setAppReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
  const initRunIdRef = useRef(0);
  const initPromiseRef = useRef<Promise<boolean> | null>(null);
  const lastRecoveryAtRef = useRef(0);
  const lastWorkflowSignatureRef = useRef<string | null>(null);

  const iframeUrl = comfyuiDirectUrl ? getSameOriginUrl() : null;

  const rememberWorkflowSignature = useCallback(
    (
      graphData: Record<string, unknown> | null,
      workflowId: string | null,
    ) => {
      lastWorkflowSignatureRef.current = buildWorkflowSignature(
        graphData,
        workflowId,
      );
    },
    [],
  );

  const commitWorkflowResult = useCallback(
    async (result: ReadWorkflowResult, force = false) => {
      const workflowId =
        result.filename ?? useGenerationStore.getState().selectedWorkflowId;
      const signature = buildWorkflowSignature(
        result.graphData,
        workflowId,
      );
      if (!force && signature === lastWorkflowSignatureRef.current) {
        return;
      }

      lastWorkflowSignatureRef.current = signature;
      await registerWorkflowFromEditor(
        result.workflow,
        result.graphData,
        result.inputs,
        result.filename,
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
      lastWorkflowSignatureRef.current = null;
      setAppReady(false);
      setLoading(true);
      setEditorNeedsReconnect(false);
      useGenerationStore.getState().setWorkflowLoading(true);

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
      const ready = await waitForAppReady(iframe, shouldAbort, APP_READY_TIMEOUT_MS);
      if (!ready) {
        if (!shouldAbort()) {
          setEditorNeedsReconnect(true);
          // If the backend is reported as reachable but the app object never
          // appeared, the iframe likely loaded a dead/stale page (e.g. ComfyUI
          // was down on first load). Trigger recovery.
          if (isIframeBackendConnected(iframe)) {
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
          );
        rememberWorkflowSignature(firstResult.graphData, firstResult.filename);
      }

      if (shouldAbort()) return false;

      consecutiveReadFailuresRef.current = 0;
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
  }, [recoverIframe, rememberWorkflowSignature, setEditorNeedsReconnect]);

  // Cleanup async guards on unmount
  useEffect(() => {
    return () => {
      initRunIdRef.current += 1;
      initPromiseRef.current = null;
      consecutiveReadFailuresRef.current = 0;
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

  const syncLatestWorkflowFromIframe = useCallback(async () => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const result = await readWorkflowFromIframe(iframe);
    if (!result) return;

    await commitWorkflowResult(result, true);
  }, [commitWorkflowResult]);

  const pollWorkflow = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      const iframe = iframeRef.current;
      if (!iframe) return;

      if (!isIframeBackendConnected(iframe)) {
        recoverIframe("backend socket disconnected");
        return;
      }

      const result = await readWorkflowFromIframe(iframe);
      if (!result) {
        consecutiveReadFailuresRef.current += 1;
        if (
          consecutiveReadFailuresRef.current >= MAX_CONSECUTIVE_READ_FAILURES
        ) {
          recoverIframe("repeated workflow read failures");
        }
        return;
      }
      await commitWorkflowResult(result);
      consecutiveReadFailuresRef.current = 0;
    } finally {
      pollingRef.current = false;
    }
  }, [commitWorkflowResult, recoverIframe]);

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

    const interval = appReady ? POLL_INTERVAL_MS : RECOVERY_POLL_MS;
    const timer = setInterval(tick, interval);
    return () => clearInterval(timer);
  }, [open, appReady, initializeIframe, pollWorkflow]);

  // When the user returns to the tab, do a quick health check. If the iframe
  // has gone stale (e.g. browser suspended it), flip to init-retry mode.
  // If healthy, trigger an immediate poll to sync any changes.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !open) return;

      const iframe = iframeRef.current;
      if (!iframe) return;

      if (!isIframeAppReady(iframe) || !isIframeBackendConnected(iframe)) {
        recoverIframe("tab became visible with unhealthy iframe");
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
  }, [
    open,
    appReady,
    initializeIframe,
    pollWorkflow,
    recoverIframe,
  ]);

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
        <Typography variant="subtitle1" sx={{ color: "#ccc" }}>
          ComfyUI Node Editor
        </Typography>
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
      </Box>
    </Box>
  );
}
