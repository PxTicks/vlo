import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvailableModels } from "../../../../services/downloadApi";
import { SamAudioModelDownloadOverlay } from "../SamAudioModelDownloadOverlay";

const { controller, panelMock } = vi.hoisted(() => ({
  controller: {
    activeDownloads: {},
    error: null,
    dismissError: vi.fn(),
    anyLocalDownloadActive: false,
    handleDownload: vi.fn(),
    handleCancel: vi.fn(),
    handleDownloadAll: vi.fn(),
    adoptExternalJob: vi.fn(),
  },
  panelMock: vi.fn(),
}));

vi.mock("../../../../services/downloadApi", () => ({
  getAvailableModels: vi.fn(),
  startModelDownload: vi.fn(),
  startModelDownloadBatch: vi.fn(),
}));

vi.mock("../../../../shared/hooks/useModelDownloadController", () => ({
  useModelDownloadController: vi.fn(() => controller),
}));

vi.mock("../../../../shared/components/ModelDownloadPanel", () => ({
  ModelDownloadPanel: (props: Record<string, unknown>) => {
    panelMock(props);
    return <div data-testid="model-panel" />;
  },
}));

describe("SamAudioModelDownloadOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads registry models and notifies when one is installed", async () => {
    const models = [
      {
        key: "sam-audio",
        label: "SAM Audio",
        description: "Model",
        installed: true,
      },
    ];
    vi.mocked(getAvailableModels).mockResolvedValue({ sam2: [], samAudio: models });
    const onModelsInstalled = vi.fn();
    render(
      <SamAudioModelDownloadOverlay onModelsInstalled={onModelsInstalled} />,
    );

    await waitFor(() => expect(onModelsInstalled).toHaveBeenCalledTimes(1));
    expect(panelMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        models,
        loading: false,
        variant: "plain",
        fillHeight: true,
      }),
    );
  });

  it("uses the gated fallback for empty or failed registry responses", async () => {
    vi.mocked(getAvailableModels)
      .mockResolvedValueOnce({ sam2: [], samAudio: [] })
      .mockRejectedValueOnce(new Error("offline"));

    const first = render(
      <SamAudioModelDownloadOverlay onModelsInstalled={vi.fn()} />,
    );
    await waitFor(() =>
      expect(panelMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          models: [
            expect.objectContaining({
              key: "sam-audio-large-tv",
              gated: true,
            }),
          ],
          loading: false,
        }),
      ),
    );
    first.unmount();

    render(<SamAudioModelDownloadOverlay onModelsInstalled={vi.fn()} />);
    await waitFor(() =>
      expect(panelMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          models: [
            expect.objectContaining({ key: "sam-audio-large-tv" }),
          ],
        }),
      ),
    );
  });

  it("polls silently and ignores stale earlier requests", async () => {
    vi.useFakeTimers();
    let resolveInitial: (value: { sam2: []; samAudio: [] }) => void =
      () => undefined;
    vi.mocked(getAvailableModels)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
      )
      .mockResolvedValueOnce({
        sam2: [],
        samAudio: [
          {
            key: "new",
            label: "New",
            description: "Latest",
            installed: false,
          },
        ],
      });
    const { unmount } = render(
      <SamAudioModelDownloadOverlay onModelsInstalled={vi.fn()} />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getAvailableModels).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveInitial({ sam2: [], samAudio: [] });
      await Promise.resolve();
    });
    expect(panelMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        models: [expect.objectContaining({ key: "new" })],
      }),
    );

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getAvailableModels).toHaveBeenCalledTimes(2);
  });
});
