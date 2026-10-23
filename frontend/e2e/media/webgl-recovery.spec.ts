import { expect, test } from './fixtures';

for (const recovery of ['restored event', 'timeout fallback']) {
    test(`rebuilds a paused masked preview after WebGL loss via ${recovery}`, async ({
        editorWithMaskGrade: editor,
    }) => {
        const { page, timeline, player } = editor;
        const tick = 48_000;
        await timeline.seekToTick(tick);
        await expect.poll(() => page.evaluate((target) => {
            const frame = window.__vloE2E?.getLiveFramePresentation();
            return frame?.tick === target && frame.exact;
        }, tick), { timeout: 30_000 }).toBe(true);

        const canvas = player.canvasContainer.locator('canvas');
        const before = await canvas.screenshot();
        const sequence = await page.evaluate(() =>
            window.__vloE2E!.getLiveFramePresentation()!.sequence,
        );
        const oldCanvas = await canvas.elementHandle();
        await canvas.evaluate((element, restore) => {
            const gl = (element as HTMLCanvasElement).getContext('webgl2');
            const extension = gl?.getExtension('WEBGL_lose_context');
            if (!extension) throw new Error('WEBGL_lose_context unavailable');
            if (restore) {
                element.addEventListener('webglcontextlost', () => {
                    setTimeout(() => extension.restoreContext(), 100);
                }, { once: true });
            }
            extension.loseContext();
        }, recovery === 'restored event');

        await expect.poll(() => oldCanvas!.evaluate((element) => element.isConnected)).toBe(false);
        await expect.poll(() => page.evaluate(({ target, previous }) => {
            const frame = window.__vloE2E?.getLiveFramePresentation();
            return !!frame && frame.tick === target && frame.exact && frame.sequence > previous;
        }, { target: tick, previous: sequence }), { timeout: 30_000 }).toBe(true);
        await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(true);
        await expect(page.getByText('Restoring preview…')).toBeHidden();
        await expect(player.playButton).toBeVisible();
    });
}
