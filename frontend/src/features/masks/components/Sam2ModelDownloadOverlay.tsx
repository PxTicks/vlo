import { useCallback, useEffect, useState } from "react";
import { CloudDownload } from "@mui/icons-material";
import {
  getAvailableModels,
  startModelDownload,
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

export function Sam2ModelDownloadOverlay({
  onModelsInstalled,
}: Sam2ModelDownloadOverlayProps) {
  const [models, setModels] = useState<DownloadableModel[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getAvailableModels();
      const nextModels =
        response.sam2.length > 0 ? response.sam2 : FALLBACK_SAM2_MODELS;
      setModels(nextModels);

      if (response.sam2.some((model) => model.installed)) {
        onModelsInstalled();
      }
    } catch {
      setModels(FALLBACK_SAM2_MODELS);
    } finally {
      setLoading(false);
    }
  }, [onModelsInstalled]);

  const {
    activeDownload,
    error,
    handleDownload,
    handleCancel,
  } = useModelDownloadController({
    startDownload: (modelKey) => startModelDownload("sam2", modelKey),
    onDownloadComplete: () => {
      void fetchModels();
    },
  });

  // Fetch-on-mount is the documented escape hatch for the
  // react-hooks/set-state-in-effect rule when no data-fetching library is
  // in play. See https://react.dev/reference/react/useEffect#fetching-data-with-effects
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchModels();
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
      activeDownload={activeDownload}
      onDownload={handleDownload}
      onCancel={handleCancel}
    />
  );
}
