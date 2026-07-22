import { expect, test } from './fixtures';

/**
 * The browser-media lane's own guard (plan §4.6).
 *
 * If this spec fails, the Phase 4 A/V canary and the Phase 5 pixel-parity
 * canary in this lane are not trustworthy — they would be asserting against a
 * degraded browser. It runs first so a misconfigured lane reports as a
 * capability problem rather than as an unrelated media assertion failure.
 */
test.describe('browser-media lane capabilities', () => {
    test('exercises real WebGL, WebCodecs and Web Audio', async ({
        mediaCapabilities,
    }) => {
        // The auto fixture has already thrown on failure; these assertions
        // document the contract and keep the report visible in the run output.
        expect(
            mediaCapabilities.webgl.ok,
            `WebGL2 draw failed: ${mediaCapabilities.webgl.error}`,
        ).toBe(true);
        expect(mediaCapabilities.webgl.drawnPixel).toEqual([255, 0, 0, 255]);

        expect(mediaCapabilities.webCodecs.interfaces).toEqual({
            VideoDecoder: true,
            VideoEncoder: true,
            AudioDecoder: true,
            AudioEncoder: true,
        });

        // Every configuration the canaries will actually run — decode of the
        // H.264 sources, VP9/Opus of the baked composite, AAC of the .m4a, and
        // the VP9/Opus encode pair a Phase 5.3 bake produces.
        const unsupported = mediaCapabilities.webCodecs.configs.filter(
            (result) => !result.supported,
        );
        expect(
            unsupported.map((result) => `${result.kind} ${result.codec}`),
        ).toEqual([]);
        expect(mediaCapabilities.webCodecs.configs.length).toBeGreaterThan(0);

        expect(mediaCapabilities.webAudio.ok).toBe(true);
        expect(mediaCapabilities.webAudio.clockAdvanced).toBe(true);
        expect(mediaCapabilities.webAudio.sampleRate).toBeGreaterThan(0);
        // TrackAudioRenderer and CompositeAudioTrackRenderer both require it.
        expect(mediaCapabilities.webAudio.offlineAudioContext).toBe(true);
    });

    test('renders a Pixi-backed player canvas, not a stub', async ({
        editorCurrent,
    }) => {
        // Proves the lane reaches the real renderer: the app's own canvas must
        // exist and carry a WebGL context, which is the substrate the Phase 5
        // parity captures read from.
        const canvas = editorCurrent.player.canvasContainer.locator('canvas');
        await expect(canvas.first()).toBeVisible();

        const contextType = await canvas.first().evaluate((element) => {
            const target = element as HTMLCanvasElement;
            // Pixi has already acquired the context; re-requesting the same
            // type returns it, while a mismatched type returns null.
            return {
                webgl2: target.getContext('webgl2') !== null,
                width: target.width,
                height: target.height,
            };
        });

        expect(contextType.webgl2).toBe(true);
        expect(contextType.width).toBeGreaterThan(0);
        expect(contextType.height).toBeGreaterThan(0);
    });
});
