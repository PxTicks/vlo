import { test, expect } from '../fixtures';

/**
 * The editor's centre is mounted from registered surfaces
 * (docs/configurable-docking-and-dedicated-workspaces-plan.md §7 Phase D
 * acceptance: the default editor stays visually and behaviourally the same).
 */

test.describe('Editor stage surfaces', () => {
    test('the default editor renders through its registered stage surfaces', async ({
        editorWithClips,
    }) => {
        const { page, timeline, player } = editorWithClips;

        const mainStage = page.locator('[data-shell-stage="main-stage"]');
        const lowerStage = page.locator('[data-shell-stage="lower-stage"]');

        await expect(mainStage).toHaveAttribute(
            'data-shell-surface',
            'host.player',
        );
        await expect(lowerStage).toHaveAttribute(
            'data-shell-surface',
            'host.timeline',
        );
        await expect(mainStage).toHaveAttribute('data-editor-region', 'canvas');
        await expect(lowerStage).toHaveAttribute(
            'data-editor-region',
            'timeline',
        );

        // The picture sits above the timeline, both stages have real extent,
        // and the player canvas still fills the main stage.
        const mainBox = (await mainStage.boundingBox())!;
        const lowerBox = (await lowerStage.boundingBox())!;
        const canvasBox = (await player.canvasContainer.boundingBox())!;
        expect(mainBox.height).toBeGreaterThan(100);
        expect(lowerBox.height).toBeGreaterThan(100);
        expect(mainBox.y + mainBox.height).toBeLessThanOrEqual(lowerBox.y + 1);
        expect(canvasBox.width).toBeGreaterThan(mainBox.width - 4);

        // Timeline editing still works through the surface mount.
        await timeline.clickClip(0);
        const clip = timeline.getClip(0);
        const initial = (await clip.boundingBox())!;
        const handle = timeline.getClipResizeHandle(0, 'right');
        const handleBox = (await handle.boundingBox())!;
        await page.mouse.move(
            handleBox.x + handleBox.width / 2,
            handleBox.y + handleBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
            handleBox.x + handleBox.width / 2 - 60,
            handleBox.y + handleBox.height / 2,
            { steps: 10 },
        );
        await page.mouse.up();
        expect((await clip.boundingBox())!.width).toBeLessThan(initial.width);
    });
});
