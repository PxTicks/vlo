import { test, expect } from './fixtures';
import { dragAssetToTimeline } from './helpers/drag';

test.describe('Player Interactions', () => {

    test('Smoke Test: Player components are visible', async ({ editor }) => {
        await expect(editor.player.canvasContainer).toBeVisible();
        await expect(editor.player.controls).toBeVisible();
    });

    test('Play/Pause Interaction', async ({ editor }) => {
        // Add a clip so there's something to play
        await dragAssetToTimeline(editor.page);
        await expect(editor.timeline.clips.first()).toBeVisible();

        // Initial State: Play button visible (paused)
        await expect(editor.player.playButton).toBeVisible();

        // Click Play -> Pause button appears
        await editor.player.play();
        await expect(editor.player.pauseButton).toBeVisible();

        // Click Pause -> Play button reappears
        await editor.player.pause();
        await expect(editor.player.playButton).toBeVisible();
    });

    test('Fit View Interaction', async ({ editor }) => {
        const fitButton = editor.player.fitToScreenButton;
        await expect(fitButton).toBeVisible();

        await fitButton.click();

        // Button remains visible and no errors occurred
        await expect(fitButton).toBeVisible();
    });

});
