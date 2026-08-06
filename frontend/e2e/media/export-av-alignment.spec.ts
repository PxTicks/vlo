import { ENCODE_CONFIGS, probeMediaCapabilities } from './mediaCapabilities';
import { expect, test } from './fixtures';

/**
 * Offline nested-retiming A/V alignment (plan §4.2a).
 *
 * This is the enforceable A/V claim. It exports exactly the five-frame nested
 * window, captures the project ticks the renderer requested via
 * `onBeforeEncodeFrame`, decodes the resulting WebM with the real browser
 * decoder, and compares video against audio.
 *
 * It proves deterministic **export-time** alignment through the real retiming,
 * decode, render, encode and mux path. It does **not** prove sustained live
 * playback drift, which depends on a hardware-accelerated runner and is
 * explicitly uncovered — see `playback-anchor.spec.ts` for the live contract
 * that is provable here.
 *
 * The export is its own capability test: if software VP9 encoding works, this
 * runs and passes. `ENCODE_CONFIGS` is probed only to attach better diagnostics
 * when it fails, never to gate or skip.
 */

/** project_current: 16 fps, TICKS_PER_SECOND 96000. */
const TICKS_PER_FRAME = 6000;
const TICKS_PER_SECOND = 96000;

/**
 * The nested retiming window from plan §2.2a — where the ripple adjustment
 * (2x, innermost) and the static adjustment (1.5x, outermost) both apply.
 * Exactly five frames; sampling outside it proves nothing about composition.
 */
const NESTED_WINDOW_START_TICK = 1734000;
const NESTED_WINDOW_END_TICK = 1764000;
const EXPECTED_FRAME_COUNT =
    (NESTED_WINDOW_END_TICK - NESTED_WINDOW_START_TICK) / TICKS_PER_FRAME;

/**
 * Opus carries encoder delay (pre-skip), so a decoded audio track legitimately
 * starts slightly before or after the video's first timestamp. One project
 * frame is the alignment budget the plan specifies, and it comfortably exceeds
 * Opus's ~6.5ms typical pre-skip.
 */
const ALIGNMENT_TOLERANCE_SECONDS = TICKS_PER_FRAME / TICKS_PER_SECOND;

interface TrackSummary {
    firstTimestampSeconds: number;
    endTimestampSeconds: number;
    durationSeconds: number;
    packetCount: number;
    averagePacketRate: number;
    canDecode: boolean;
}

interface ProbeResult {
    encodeTicks: number[];
    encodeFrameIndices: number[];
    frameWidth: number | null;
    frameHeight: number | null;
    fileSize: number;
    fileType: string;
    video: TrackSummary | null;
    audio: TrackSummary | null;
}

test.describe('offline nested-retiming A/V alignment', () => {
    test('exports the nested window with aligned video and audio', async ({
        editorCurrent,
    }, testInfo) => {
        // A bake round trip decodes, renders, encodes and muxes real media.
        test.setTimeout(180000);
        const page = editorCurrent.page;

        const probeInstalled = await page.evaluate(
            () => typeof window.__vloE2E?.runSelectionExportProbe,
        );
        expect(
            probeInstalled,
            'export probe missing — build/serve without VITE_E2E_DIAGNOSTICS?',
        ).toBe('function');

        const outcome = await page.evaluate(
            async ([startTick, endTick]) => {
                try {
                    const result =
                        await window.__vloE2E?.runSelectionExportProbe?.({
                            startTick,
                            endTick,
                        });
                    return { ok: true as const, result };
                } catch (error) {
                    return { ok: false as const, error: String(error) };
                }
            },
            [NESTED_WINDOW_START_TICK, NESTED_WINDOW_END_TICK],
        );

        if (!outcome.ok) {
            // The export is the authoritative capability test, so a failure
            // here is a real failure. Attach the encode-config probe purely so
            // the reason is legible — an unsupported encoder configuration
            // looks nothing like a retiming bug, and the two should not be
            // confused during triage.
            const capabilities = await probeMediaCapabilities(page);
            const encodeSupport = await page.evaluate(
                async (specs) => {
                    const out: Record<string, boolean | string> = {};
                    for (const spec of specs) {
                        const api =
                            spec.kind === 'video-encode'
                                ? VideoEncoder
                                : AudioEncoder;
                        try {
                            const support = await (
                                api as {
                                    isConfigSupported: (
                                        config: unknown,
                                    ) => Promise<{ supported?: boolean }>;
                                }
                            ).isConfigSupported(spec.config);
                            out[spec.label] = support.supported === true;
                        } catch (error) {
                            out[spec.label] = `threw: ${String(error)}`;
                        }
                    }
                    return out;
                },
                ENCODE_CONFIGS.map((spec) => ({
                    kind: spec.kind,
                    label: spec.label,
                    config: spec.config,
                })),
            );
            await testInfo.attach('encode-capability.txt', {
                body: [
                    `webgl.renderer: ${capabilities.webgl.renderer}`,
                    '',
                    'encode configuration support (diagnostic only):',
                    ...Object.entries(encodeSupport).map(
                        ([label, supported]) => `  ${supported} — ${label}`,
                    ),
                ].join('\n'),
                contentType: 'text/plain',
            });
            throw new Error(`selection export failed: ${outcome.error}`);
        }

        const result = outcome.result as ProbeResult;

        // Attached on success too: the numbers are what make a later regression
        // legible, and they are the evidence that this spec is asserting
        // against a real export rather than passing vacuously.
        await testInfo.attach('export-av-summary.txt', {
            body: JSON.stringify(result, null, 2),
            contentType: 'text/plain',
        });

        // --- input side: which source ticks the renderer actually requested
        expect(
            result.encodeTicks.length,
            'wrong number of frames encoded for the five-frame nested window',
        ).toBe(EXPECTED_FRAME_COUNT);
        expect(result.encodeTicks[0]).toBe(NESTED_WINDOW_START_TICK);
        for (let index = 1; index < result.encodeTicks.length; index += 1) {
            expect(
                result.encodeTicks[index] - result.encodeTicks[index - 1],
                'encode ticks are not one frame apart',
            ).toBe(TICKS_PER_FRAME);
        }
        expect(result.encodeTicks[result.encodeTicks.length - 1]).toBeLessThan(
            NESTED_WINDOW_END_TICK,
        );

        // --- output side: what the muxer actually wrote
        expect(result.fileType).toBe('video/webm');
        expect(result.fileSize).toBeGreaterThan(0);

        const video = result.video;
        expect(video, 'exported file has no video track').toBeTruthy();
        expect(video!.canDecode, 'browser cannot decode its own output').toBe(
            true,
        );
        expect(video!.packetCount).toBe(EXPECTED_FRAME_COUNT);

        const audio = result.audio;
        expect(
            audio,
            'exported nested window has no audio track — the composite on pos5 carries audio',
        ).toBeTruthy();
        expect(audio!.canDecode).toBe(true);

        // --- alignment
        expect(
            Math.abs(
                video!.firstTimestampSeconds - audio!.firstTimestampSeconds,
            ),
            'video and audio start timestamps diverge by more than one frame',
        ).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_SECONDS);

        const expectedDuration =
            (NESTED_WINDOW_END_TICK - NESTED_WINDOW_START_TICK) /
            TICKS_PER_SECOND;
        expect(
            Math.abs(video!.durationSeconds - audio!.durationSeconds),
            'video and audio durations diverge by more than one frame',
        ).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_SECONDS);
        expect(
            Math.abs(video!.durationSeconds - expectedDuration),
            'exported duration does not match the requested nested window',
        ).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE_SECONDS);
    });
});
