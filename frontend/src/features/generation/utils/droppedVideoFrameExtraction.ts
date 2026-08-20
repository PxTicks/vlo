import { tickToMediaSeconds } from "../../../core/time";
import { captureVideoFrameFile } from "../../../core/media";
import {
  useMiniEditorStore,
  type ResolvedEditorSource,
} from "../../miniEditor";

interface DroppedVideoFrameExtractionOptions {
  inputId: string;
  title: string;
  prepare: () => Promise<ResolvedEditorSource>;
  setMediaInputFrame: (inputId: string, file: File) => void;
}

/**
 * Opens a dropped video as a pending image-slot transaction. Nothing is
 * committed until frame extraction succeeds, so closing the editor is a no-op.
 */
export async function openDroppedVideoFrameExtraction({
  inputId,
  title,
  prepare,
  setMediaInputFrame,
}: DroppedVideoFrameExtractionOptions): Promise<void> {
  const openerId = `generation-image-drop:${inputId}`;
  const onExtractFrame = async (
    playheadTicks: number,
    source: ResolvedEditorSource,
  ): Promise<void> => {
    const frame = await captureVideoFrameFile(
      source.sourceUrl,
      tickToMediaSeconds(playheadTicks),
      `generation-frame-${Date.now()}.png`,
    );
    const current = useMiniEditorStore.getState();
    if (
      current._internal.openerId !== openerId ||
      current._internal.onExtractFrame !== onExtractFrame
    ) {
      return;
    }
    setMediaInputFrame(inputId, frame);
    current.close();
  };

  await useMiniEditorStore.getState().open({
    openerId,
    title: `Extract frame: ${title}`,
    prepare,
    onExtractFrame,
    closeOnExtractionCancel: true,
  });

  // Preparation may have been cancelled while it was in flight. The store
  // guards this transition, so this becomes a no-op after close/escape.
  const current = useMiniEditorStore.getState();
  if (
    current._internal.openerId === openerId &&
    current._internal.onExtractFrame === onExtractFrame
  ) {
    current.beginFrameExtraction();
  }
}
