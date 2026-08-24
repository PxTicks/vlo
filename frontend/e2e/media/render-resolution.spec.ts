import { expect, test } from './fixtures';

/**
 * Render-resolution consistency canary
 * (docs/render-resolution-consistency-plan.md §4).
 *
 * The defect this guards: the selection path used to copy its output size from
 * the *logical canvas*, which is fixed-height (1080) rather than short-edge.
 * The two conventions agree in landscape and diverge in portrait, so a 9:16
 * project exported at 1080x1920 while the same project's selections — the
 * video handed to generation — encoded at 608x1080.
 *
 * Unit coverage asserts the resolved `ExportConfig`. This asserts the property
 * that actually matters downstream: the pixel dimensions a real VP9 encoder
 * wrote into a real file, read back off that file.
 *
 * One export per test, deliberately. A second selection export in the same
 * page renders a clip blank ("no prepared decoder source"), which reproduces
 * on unmodified `main` and is unrelated to resolution — sharing a page here
 * would import that failure into this canary.
 */

/** The A/V canary's nested window: five frames of real content. */
const WINDOW_START_TICK = 1734000;
const WINDOW_END_TICK = 1764000;

interface ProbeDimensions {
    frameWidth: number | null;
    frameHeight: number | null;
    encodedVideo: { width: number; height: number } | null;
}

/**
 * Park the playhead inside the window and let the paused render settle.
 *
 * Cold mock-filesystem hydration on this lane can leave a clip's decoder
 * source unprepared when an export starts; the renderer then reports a blank
 * strict frame and the `diagnostics` fixture fails the run on a console error
 * that has nothing to do with resolution. This reproduces on unmodified
 * `main` in `export-av-alignment.spec.ts`, so it is a property of the lane,
 * not of this change.
 *
 * Rendering the window interactively first is what a user does before
 * extracting, and it prepares the source the export path then finds. Waiting
 * on two consecutive identical canvas captures — rather than a fixed sleep —
 * ties the wait to the render actually having settled.
 */
async function warmWindow(editor: {
    page: import('@playwright/test').Page;
    timeline: { seekToTick: (tick: number) => Promise<number> };
    player: { canvasContainer: import('@playwright/test').Locator };
}): Promise<void> {
    await editor.timeline.seekToTick(WINDOW_START_TICK);

    const canvas = editor.player.canvasContainer;
    let previous = '';
    await expect
        .poll(
            async () => {
                const current = (await canvas.screenshot()).toString('base64');
                const settled = current === previous;
                previous = current;
                return settled;
            },
            { timeout: 60_000, intervals: [1000] },
        )
        .toBe(true);
}

async function exportSelectionDimensions(
    page: import('@playwright/test').Page,
): Promise<ProbeDimensions> {
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
                const result = await window.__vloE2E?.runSelectionExportProbe?.(
                    { startTick, endTick },
                );
                return { ok: true as const, result };
            } catch (error) {
                return { ok: false as const, error: String(error) };
            }
        },
        [WINDOW_START_TICK, WINDOW_END_TICK],
    );

    if (!outcome.ok) {
        throw new Error(`selection export probe failed: ${outcome.error}`);
    }
    return outcome.result as ProbeDimensions;
}

async function setOutputResolution(
    page: import('@playwright/test').Page,
    label: string,
): Promise<void> {
    await page.getByTestId('project-settings-button').click();
    await page.getByRole('menuitem', { name: label }).click();
    await expect(page.getByRole('menu')).toBeHidden();
}

async function setAspectRatio(
    page: import('@playwright/test').Page,
    label: string,
): Promise<void> {
    await page.getByTestId('project-settings-button').click();
    await page.getByRole('menuitem', { name: label }).click();
    await expect(page.getByRole('menu')).toBeHidden();
}

test.describe('render resolution consistency', () => {
    test('encodes a landscape selection at 1920x1080', async ({
        editorCurrent,
    }, testInfo) => {
        test.setTimeout(180000);

        // The control. Logical canvas and short-edge agree at 16:9, so this is
        // what the old code produced too — it pins what the fix must not move.
        await warmWindow(editorCurrent);
        const dimensions = await exportSelectionDimensions(editorCurrent.page);
        await testInfo.attach('landscape-dimensions.json', {
            body: JSON.stringify(dimensions, null, 2),
            contentType: 'application/json',
        });

        expect(dimensions.encodedVideo).toEqual({ width: 1920, height: 1080 });
        expect(dimensions.frameWidth).toBe(1920);
        expect(dimensions.frameHeight).toBe(1080);
    });

    test('encodes a portrait selection at 1080x1920', async ({
        editorCurrent,
    }, testInfo) => {
        test.setTimeout(180000);
        const page = editorCurrent.page;

        await setAspectRatio(page, '9:16 (Story)');
        await warmWindow(editorCurrent);

        const dimensions = await exportSelectionDimensions(page);
        await testInfo.attach('portrait-dimensions.json', {
            body: JSON.stringify(dimensions, null, 2),
            contentType: 'application/json',
        });

        // The regression: 608x1080 here means the selection path is reading
        // the logical canvas as a resolution again. The short edge must be
        // 1080 in both orientations — it is the number a workflow's
        // `target_resolution` is compared against.
        expect(dimensions.encodedVideo).toEqual({ width: 1080, height: 1920 });
        expect(dimensions.frameWidth).toBe(1080);
        expect(dimensions.frameHeight).toBe(1920);
        expect(
            Math.min(
                dimensions.encodedVideo!.width,
                dimensions.encodedVideo!.height,
            ),
        ).toBe(1080);
    });

    // Phase 2: the project's own resolution, not a hard-coded 1080. Selections
    // had no resolution control at all before it.
    test('encodes a selection at the project output resolution', async ({
        editorCurrent,
    }, testInfo) => {
        test.setTimeout(180000);
        const page = editorCurrent.page;

        await setOutputResolution(page, '720p (HD)');
        await warmWindow(editorCurrent);

        const dimensions = await exportSelectionDimensions(page);
        await testInfo.attach('project-resolution-dimensions.json', {
            body: JSON.stringify(dimensions, null, 2),
            contentType: 'application/json',
        });

        expect(dimensions.encodedVideo).toEqual({ width: 1280, height: 720 });
        expect(dimensions.frameWidth).toBe(1280);
        expect(dimensions.frameHeight).toBe(720);
    });

    test('carries the project resolution into portrait', async ({
        editorCurrent,
    }, testInfo) => {
        test.setTimeout(180000);
        const page = editorCurrent.page;

        await setAspectRatio(page, '9:16 (Story)');
        await setOutputResolution(page, '480p (SD)');
        await warmWindow(editorCurrent);

        const dimensions = await exportSelectionDimensions(page);
        await testInfo.attach('portrait-480-dimensions.json', {
            body: JSON.stringify(dimensions, null, 2),
            contentType: 'application/json',
        });

        // Short edge 480 pinned on the *width* in portrait — the whole point of
        // the short-edge convention.
        expect(dimensions.encodedVideo).toEqual({ width: 480, height: 854 });
    });
});
