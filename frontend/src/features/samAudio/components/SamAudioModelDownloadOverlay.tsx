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

interface SamAudioModelDownloadOverlayProps {
  onModelsInstalled: () => void;
}

const FALLBACK_SAM_AUDIO_MODELS: DownloadableModel[] = [
  {
    key: "sam-audio-large-tv",
    label: "SAM-Audio Large TV",
    description:
      "High-quality audio separation; gated on Hugging Face. First load may also need authenticated cached dependencies.",
    installed: false,
    gated: true,
    gatedRepoUrl: "https://huggingface.co/facebook/sam-audio-large-tv",
  },
];

const EXTERNAL_POLL_INTERVAL_MS = 5000;

export function SamAudioModelDownloadOverlay({
  onModelsInstalled,
}: SamAudioModelDownloadOverlayProps) {
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
          response.samAudio && response.samAudio.length > 0
            ? response.samAudio
            : FALLBACK_SAM_AUDIO_MODELS;
        setModels(nextModels);
        if (nextModels.some((model) => model.installed)) {
          onModelsInstalled();
        }
      } catch {
        if (requestIdRef.current !== requestId) return;
        setModels(FALLBACK_SAM_AUDIO_MODELS);
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
    startDownload: (modelKey, context) =>
      startModelDownload("sam-audio", modelKey, context),
    startBatch: (modelKeys, context) =>
      startModelDownloadBatch("sam-audio", modelKeys, context),
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
      title="SAM-Audio Model Required"
      description="Download the gated SAM-Audio model to enable sound isolation. Keep the backend authenticated for first-load dependencies such as PE-AV, T5, and the judge model."
      models={models}
      loading={loading}
      loadingLabel="Loading available SAM-Audio models..."
      error={error}
      activeDownloads={activeDownloads}
      anyLocalDownloadActive={anyLocalDownloadActive}
      onDownload={handleDownload}
      onDownloadAll={handleDownloadAll}
      onCancel={handleCancel}
      onDismissError={dismissError}
      onAdoptExternalJob={adoptExternalJob}
      variant="plain"
    />
  );
}
