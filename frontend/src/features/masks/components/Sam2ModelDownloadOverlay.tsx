import { useCallback, useEffect, useRef, useState } from "react";
import { CloudDownload } from "@mui/icons-material";
import {
  getAvailableModels,
  startModelDownload,
  startModelDownloadBatch,
  type DownloadableModel,
} from "../../../services/downloadApi";
import { ModelDownloadPanel } from "../../../shared/components/ModelDownloadPanel";
import { useModelDownloadController } from "../../../shared/hooks/useModelDownloadController";

interface Sam2ModelDownloadOverlayProps {
  onModelsInstalled: () => void;
}

const FALLBACK_SAM2_MODELS: DownloadableModel[] = [
  {
    key: "sam2.1_hiera_small",
    label: "SAM2.1 Small",
    description: "Faster, ~185 MB",
    installed: false,
  },
  {
    key: "sam2.1_hiera_large",
    label: "SAM2.1 Large",
    description: "Higher quality, ~900 MB",
    installed: false,
  },
];

const EXTERNAL_POLL_INTERVAL_MS = 5000;

export function Sam2ModelDownloadOverlay({
  onModelsInstalled,
}: Sam2ModelDownloadOverlayProps) {
  const [models, setModels] = useState<DownloadableModel[]>([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  const fetchModels = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (!options.silent) {
        setLoading(true);
      }
      try {
        const response = await getAvailableModels();
        if (requestIdRef.current !== requestId) return;
        const nextModels =
          response.sam2.length > 0 ? response.sam2 : FALLBACK_SAM2_MODELS;
        setModels(nextModels);

        if (response.sam2.some((model) => model.installed)) {
          onModelsInstalled();
        }
      } catch {
        if (requestIdRef.current !== requestId) return;
        setModels(FALLBACK_SAM2_MODELS);
      } finally {
        if (requestIdRef.current === requestId && !options.silent) {
          setLoading(false);
        }
      }
    },
    [onModelsInstalled],
  );

  const {
    activeDownloads,
    error,
    dismissError,
    anyLocalDownloadActive,
    handleDownload,
    handleCancel,
    handleDownloadAll,
    adoptExternalJob,
  } = useModelDownloadController({
    startDownload: (modelKey) => startModelDownload("sam2", modelKey),
    startBatch: (modelKeys) => startModelDownloadBatch("sam2", modelKeys),
    onDownloadComplete: () => {
      void fetchModels({ silent: true });
    },
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    const interval = globalThis.setInterval(() => {
      void fetchModels({ silent: true });
    }, EXTERNAL_POLL_INTERVAL_MS);
    return () => globalThis.clearInterval(interval);
  }, [fetchModels]);

  return (
    <ModelDownloadPanel
      icon={<CloudDownload sx={{ fontSize: 40, color: "text.secondary" }} />}
      title="SAM2 Models Required"
      description="Download a model to enable AI-powered mask generation."
      models={models}
      loading={loading}
      loadingLabel="Loading available SAM2 models..."
      error={error}
      activeDownloads={activeDownloads}
      anyLocalDownloadActive={anyLocalDownloadActive}
      onDownload={handleDownload}
      onDownloadAll={handleDownloadAll}
      onCancel={handleCancel}
      onDismissError={dismissError}
      onAdoptExternalJob={adoptExternalJob}
    />
  );
}
