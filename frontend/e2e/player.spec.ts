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
        expect(await editor.player.isPlaying()).toBe(false);

        // Click Play -> Pause button appears
        await editor.player.play();
        await expect(editor.player.pauseButton).toBeVisible();
        expect(await editor.player.isPlaying()).toBe(true);

        // Click Pause -> Play button reappears
        await editor.player.pause();
        await expect(editor.player.playButton).toBeVisible();
        expect(await editor.player.isPlaying()).toBe(false);
    });

    test('Fit View Interaction', async ({ editor }) => {
        const fitButton = editor.player.fitToScreenButton;
        await expect(fitButton).toBeVisible();

        await fitButton.click();

        // Button remains visible and no errors occurred
        await expect(fitButton).toBeVisible();
    });

    test('All control buttons are present', async ({ editor }) => {
        await expect(editor.player.playButton).toBeVisible();
        await expect(editor.player.fitToScreenButton).toBeVisible();
        await expect(editor.player.fullscreenButton).toBeVisible();
        await expect(editor.player.extractButton).toBeVisible();
    });

});

test.describe('Extract Dialog', () => {

    test('Opens and shows three extraction options', async ({ editor }) => {
        await editor.player.openExtractDialog();

        const dialog = editor.page.getByRole('dialog');
        await expect(dialog).toBeVisible();

        // Three options: Extract Frame, Extract Selection, Export
        await expect(dialog.getByText('Extract Frame')).toBeVisible();
        await expect(dialog.getByText('Extract Selection')).toBeVisible();
        await expect(dialog.getByText('Export')).toBeVisible();
    });

    test('Cancel closes the dialog', async ({ editor }) => {
        await editor.player.openExtractDialog();

        const dialog = editor.page.getByRole('dialog');
        await expect(dialog).toBeVisible();

        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
    });

    test('Export option shows resolution selector', async ({ editor }) => {
        await editor.player.openExtractDialog();

        const dialog = editor.page.getByRole('dialog');

        // Navigate via the export option button instead of the descriptive copy.
        await dialog.getByRole('button', { name: /^Export\b/i }).click();

        // Should now show Export Project view with resolution dropdown
        await expect(dialog.getByText('Export Project')).toBeVisible();
        await expect(dialog.getByLabel('Resolution')).toBeVisible();

        // Back button returns to the choose view
        await dialog.getByRole('button', { name: 'Back' }).click();
        await expect(dialog.getByText('Extract Frame')).toBeVisible();
    });

    test('Export resolution selector has all options', async ({ editor }) => {
        await editor.player.openExtractDialog();

        const dialog = editor.page.getByRole('dialog');

        // Navigate to Export view
        await dialog.getByRole('button', { name: /^Export\b/i }).click();
        await expect(dialog.getByText('Export Project')).toBeVisible();

        // Open the resolution dropdown
        await dialog.getByLabel('Resolution').click();

        // All resolution options should be visible in the dropdown
        const listbox = editor.page.getByRole('listbox');
        await expect(listbox.getByText('480p (SD)')).toBeVisible();
        await expect(listbox.getByText('720p (HD)')).toBeVisible();
        await expect(listbox.getByText('1080p (FHD)')).toBeVisible();
        await expect(listbox.getByText('4K (UHD)')).toBeVisible();
    });

});

test.describe('Player with Pre-loaded Clips', () => {

    test('Play/pause with pre-loaded clips', async ({ editorWithClips }) => {
        const { player } = editorWithClips;

        // Should start paused
        await expect(player.playButton).toBeVisible();
        expect(await player.isPlaying()).toBe(false);

        // Play
        await player.play();
        await expect(player.pauseButton).toBeVisible();
        expect(await player.isPlaying()).toBe(true);

        // Pause
        await player.pause();
        await expect(player.playButton).toBeVisible();
        expect(await player.isPlaying()).toBe(false);
    });

    test('Extract button is visible with pre-loaded clips', async ({ editorWithClips }) => {
        const { player } = editorWithClips;
        await expect(player.extractButton).toBeVisible();
        await expect(player.extractButton).toBeEnabled();
    });

});
