import { expect, test } from './fixtures';

/**
 * Live playback A/V contract (plan §4.2).
 *
 * This canary deliberately asserts only what is independent of how fast the
 * runner can rasterise. Under the lane's software rasteriser the render loop
 * sustains roughly 59% of realtime on `project_current`, so the playhead stalls
 * while the audio clock keeps running and observed A/V drift grows to ~10
 * frames. That drift measures the runner, not the product.
 *
 * Sustained live-playback A/V alignment is therefore explicitly *not* covered
 * here — it needs a hardware-GPU runner. The enforceable A/V claim lives in the
 * deterministic offline export canary. What remains genuinely provable in a
 * browser, and is proved below, is the anchoring and monotonicity contract.
 */

/** project_current runs at 16 fps; TICKS_PER_SECOND is 96000. */
const TICKS_PER_FRAME = 6000;

/**
 * The presentation clock is allowed to sit slightly ahead of audio at the
 * instant playback starts, before the first frame settles. It must not lead
 * materially — a video clock running ahead of audio is a real defect, whereas
 * lagging is what a slow rasteriser produces.
 */
const MAX_PRESENTATION_LEAD_TICKS = 2 * TICKS_PER_FRAME;

interface Diagnostics {
    isPlaying: boolean;
    playheadTicks: number;
    presentationFrameTicks: number;
    audioTicks: number;
    audioAnchorTime: number;
    audioContextTime: number | null;
    audioContextState: string | null;
    audioSampleRate: number | null;
}

async function read(page: import('@playwright/test').Page): Promise<Diagnostics> {
    const diagnostics = await page.evaluate(() =>
        window.__vloE2E?.getPlaybackDiagnostics(),
    );
    expect(
        diagnostics,
        'playback diagnostics bridge missing — build without VITE_E2E_DIAGNOSTICS?',
    ).toBeTruthy();
    return diagnostics as Diagnostics;
}

test.describe('live playback A/V contract', () => {
    test('anchors the audio clock on play and advances all clocks monotonically', async ({
        editorCurrent,
    }) => {
        const page = editorCurrent.page;

        const idle = await read(page);
        expect(idle.isPlaying).toBe(false);
        expect(idle.audioContextState).toBe('running');
        expect(idle.audioSampleRate).toBeGreaterThan(0);

        // `isPlaying` flips before the playback effect calls notifyPlay, so the
        // anchor — not the flag — is what marks the audio clock as valid.
        const anchorBeforePlay = idle.audioAnchorTime;
        await editorCurrent.player.play();
        await expect
            .poll(async () => (await read(page)).audioAnchorTime, {
                message: 'audio clock was never anchored by notifyPlay',
                timeout: 10000,
            })
            .not.toBe(anchorBeforePlay);

        const samples: Diagnostics[] = [];
        for (let index = 0; index < 6; index += 1) {
            await page.waitForTimeout(200);
            samples.push(await read(page));
        }
        await editorCurrent.player.pause();

        for (const sample of samples) {
            expect(sample.isPlaying).toBe(true);
            expect(sample.audioContextState).toBe('running');
            // Frame alignment is a product invariant, independent of speed.
            expect(sample.presentationFrameTicks % TICKS_PER_FRAME).toBe(0);
            // Video may lag audio arbitrarily on a slow rasteriser; leading it
            // is what would indicate a genuine scheduling defect.
            expect(
                sample.presentationFrameTicks - sample.audioTicks,
                'presentation clock is running ahead of the audio clock',
            ).toBeLessThanOrEqual(MAX_PRESENTATION_LEAD_TICKS);
        }

        const monotonic = (
            values: number[],
            label: string,
        ): void => {
            for (let index = 1; index < values.length; index += 1) {
                expect(
                    values[index],
                    `${label} went backwards: ${values[index - 1]} -> ${values[index]}`,
                ).toBeGreaterThanOrEqual(values[index - 1]);
            }
        };
        monotonic(samples.map((s) => s.audioTicks), 'audio clock');
        monotonic(samples.map((s) => s.playheadTicks), 'playhead');
        monotonic(
            samples.map((s) => s.presentationFrameTicks),
            'presentation clock',
        );

        // The audio clock must actually be running, not merely non-decreasing.
        expect(
            samples[samples.length - 1].audioTicks,
        ).toBeGreaterThan(samples[0].audioTicks);
    });

    test('re-anchors the audio clock on each play after pause', async ({
        editorCurrent,
    }) => {
        const page = editorCurrent.page;

        const firstAnchor = (await read(page)).audioAnchorTime;
        await editorCurrent.player.play();
        await expect
            .poll(async () => (await read(page)).audioAnchorTime, {
                timeout: 10000,
            })
            .not.toBe(firstAnchor);
        const playingAnchor = (await read(page)).audioAnchorTime;

        await editorCurrent.player.pause();
        await expect
            .poll(async () => (await read(page)).isPlaying, { timeout: 10000 })
            .toBe(false);

        // A stale anchor after restart is exactly what would desynchronise
        // audio from the playhead on resume.
        await editorCurrent.player.play();
        await expect
            .poll(async () => (await read(page)).audioAnchorTime, {
                message: 'restarting playback did not re-anchor the audio clock',
                timeout: 10000,
            })
            .not.toBe(playingAnchor);

        await editorCurrent.player.pause();
    });
});
