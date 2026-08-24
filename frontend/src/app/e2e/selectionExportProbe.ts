import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import type { InputAudioTrack, InputVideoTrack } from "mediabunny";
import {
    buildProjectRenderInputs,
    renderSelectionToVideoFile,
} from "../../features/renderer";
import type { RenderedFramePixelCapture } from "../../features/renderer/services/ExportRenderer";
import { prepareBrushMasksForTimelineRender } from "../../features/masks/api";
import { getClipsInSelection } from "../../features/timelineSelection";
import {
    readMediaTimestampRange,
    type MediaTimestampRange,
} from "../../core/time";

/**
 * Purpose-built export probe for the Phase 4.2 offline A/V canary.
 *
 * This is the *callable* half of the E2E bridge and is installed only when
 * `VITE_E2E_DIAGNOSTICS === "true"` — never on the broad development gate. A
 * work-performing entry point is a different risk class from a read-only
 * getter, so the CI E2E build opts into it explicitly and ordinary `npm run
 * dev` does not silently gain it. The module is reached through a dynamic
 * import behind a build-time-constant branch, so a normal production build
 * tree-shakes it out entirely; `scripts/verify-production-bundle.mjs` asserts
 * that.
 *
 * Scope is deliberately narrow. It renders one selection over a validated tick
 * range with a fixed format and fixed options, and returns *measurements*. It
 * exposes no arbitrary render inputs, codecs, callbacks, filenames or storage
 * behaviour, does not reproduce `useExportJobController`, and never adds the
 * result to the asset store. The rendered `File` stays in the browser — only
 * captured ticks and decoded timestamp summaries cross back to Playwright,
 * since serialising a media file through the CDP bridge would be pure waste.
 */

/** Ceiling on probe span, so a bad tick range cannot start a huge render. */
const MAX_SPAN_TICKS = 1_000_000; // ~10.4s at 96000 ticks/second

let probeInFlight = false;

export interface SelectionExportProbeRequest {
    startTick: number;
    endTick: number;
}

export interface DecodedTrackSummary extends MediaTimestampRange {
    packetCount: number;
    /** For video this equals average frame rate; for audio, packets/second. */
    averagePacketRate: number;
    /** Whether this browser can actually decode the track it just produced. */
    canDecode: boolean;
}

/** Coded pixel size of the muxed video track, read back off the file. */
export interface EncodedVideoDimensions {
    width: number;
    height: number;
}

export interface SelectionExportProbeResult {
    requested: SelectionExportProbeRequest;
    /**
     * Project ticks handed to `onBeforeEncodeFrame`, in encode order. This is
     * the input-side record: which source ticks the renderer actually asked
     * for, independent of what the muxer later wrote.
     */
    encodeTicks: number[];
    encodeFrameIndices: number[];
    frameWidth: number | null;
    frameHeight: number | null;
    /**
     * What the encoder actually wrote, as opposed to `frameWidth/Height`,
     * which is what the renderer handed it. The render-resolution canary
     * asserts on this so a mismatch between the two cannot pass unnoticed.
     */
    encodedVideo: EncodedVideoDimensions | null;
    fileSize: number;
    fileType: string;
    video: DecodedTrackSummary | null;
    audio: DecodedTrackSummary | null;
}

function validateRequest(request: SelectionExportProbeRequest): void {
    const { startTick, endTick } = request;
    for (const [name, value] of Object.entries({ startTick, endTick })) {
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
            throw new Error(`selection export probe: ${name} must be an integer tick`);
        }
    }
    if (startTick < 0) {
        throw new Error("selection export probe: startTick must be >= 0");
    }
    if (endTick <= startTick) {
        throw new Error("selection export probe: endTick must be > startTick");
    }
    if (endTick - startTick > MAX_SPAN_TICKS) {
        throw new Error(
            `selection export probe: span ${endTick - startTick} exceeds ${MAX_SPAN_TICKS} ticks`,
        );
    }
}

async function summariseTrack(
    track: InputVideoTrack | InputAudioTrack | null,
): Promise<DecodedTrackSummary | null> {
    if (!track) return null;
    const [timestampRange, stats, canDecode] = await Promise.all([
        readMediaTimestampRange(track),
        track.computePacketStats(),
        track.canDecode(),
    ]);
    if (!timestampRange) {
        throw new Error("selection export probe: invalid track timestamp range");
    }
    return {
        ...timestampRange,
        packetCount: stats.packetCount,
        averagePacketRate: stats.averagePacketRate,
        canDecode,
    };
}

export async function runSelectionExportProbe(
    request: SelectionExportProbeRequest,
): Promise<SelectionExportProbeResult> {
    validateRequest(request);
    if (probeInFlight) {
        throw new Error("selection export probe: a probe is already running");
    }
    probeInFlight = true;

    try {
        const encodeTicks: number[] = [];
        const encodeFrameIndices: number[] = [];
        let frameWidth: number | null = null;
        let frameHeight: number | null = null;

        // `TimelineSelection` carries its own clip set, so the inputs are built
        // once here and reused for both the selection and the render rather
        // than letting `renderSelectionToVideoFile` rebuild them.
        await prepareBrushMasksForTimelineRender();
        const renderInputs = {
            ...buildProjectRenderInputs(),
            brushMasksPrepared: true as const,
        };
        const { projectData } = renderInputs;
        const selection = {
            start: request.startTick,
            end: request.endTick,
            clips: getClipsInSelection(projectData.clips, {
                start: request.startTick,
                end: request.endTick,
                clips: [],
            }),
            tracks: projectData.tracks,
            transitions: projectData.transitions,
            fps: projectData.fps,
        };

        // WebM matches the composite bake path (VP9 + Opus), which is the
        // configuration the capability gate proves and the canary decodes.
        const file = await renderSelectionToVideoFile(selection, {
                renderInputs,
                format: "webm",
                filenamePrefix: "e2e-export-probe",
                onBeforeEncodeFrame: (frame: RenderedFramePixelCapture) => {
                    encodeTicks.push(frame.presentationTick);
                    encodeFrameIndices.push(frame.frameIndex);
                    frameWidth = frame.width;
                    frameHeight = frame.height;
                },
            });

        const input = new Input({
            source: new BlobSource(file),
            formats: ALL_FORMATS,
        });
        try {
            const [videoTrack, audioTrack] = await Promise.all([
                input.getPrimaryVideoTrack(),
                input.getPrimaryAudioTrack(),
            ]);
            const [video, audio] = await Promise.all([
                summariseTrack(videoTrack),
                summariseTrack(audioTrack),
            ]);

            return {
                requested: request,
                encodeTicks,
                encodeFrameIndices,
                frameWidth,
                frameHeight,
                encodedVideo: videoTrack
                    ? {
                          width: videoTrack.codedWidth,
                          height: videoTrack.codedHeight,
                      }
                    : null,
                fileSize: file.size,
                fileType: file.type,
                video,
                audio,
            };
        } finally {
            input.dispose();
        }
    } finally {
        probeInFlight = false;
    }
}
