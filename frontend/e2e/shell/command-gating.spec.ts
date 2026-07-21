import { test, expect } from '../fixtures';

/**
 * Phase 3.2 of docs/e2e-coverage-plan.md — the half of command coverage that
 * dispatch tests miss.
 *
 * Two distinct mechanisms are at work and it is worth keeping them apart:
 *
 * - `AppMenu` renders a command item **disabled** when its `when` clause fails
 *   (`hostCommandTable.isEnabled`, AppMenu.tsx:133).
 * - The clip context menu gates by **presence**: `canExtractAudio`,
 *   `canReverseClip` and `canMute` decide whether the descriptor is emitted at
 *   all (TimelineClip.tsx:550-585).
 *
 * These specs cover the presence form, which is what the clip menu actually
 * uses, plus the menu label projecting live command state.
 */
test.describe('Shell command gating', () => {
    test('@smoke clip capabilities decide which commands the menu offers', async ({
        editorCurrent,
    }) => {
        const { shell, timeline, page } = editorCurrent;

        // Clip 1 is a video whose asset carries audio.
        await shell.openContextMenu(timeline.clips.nth(1));
        await expect(shell.getItem('Extract Audio')).toBeVisible();
        await expect(shell.getItem('Reverse Clip')).toBeVisible();
        await shell.closeWithEscape();

        // Clip 0 is a video with no audio track: extraction is not offered.
        await shell.openContextMenu(timeline.clips.nth(0));
        await expect(shell.getItem('Extract Audio')).toHaveCount(0);
        await expect(shell.getItem('Reverse Clip')).toBeVisible();
        await shell.closeWithEscape();

        // Clip 2 is an image: neither audio extraction nor reversal applies,
        // while clip-generic commands stay available.
        await shell.openContextMenu(timeline.clips.nth(2));
        await expect(shell.getItem('Extract Audio')).toHaveCount(0);
        await expect(shell.getItem('Reverse Clip')).toHaveCount(0);
        await expect(shell.getItem('Delete')).toBeVisible();
        await expect(shell.getItem('Mute')).toBeVisible();

        await page.keyboard.press('Escape');
    });

    test('menu labels project live command state', async ({
        editorWithClips,
    }) => {
        const { shell, timeline } = editorWithClips;

        await shell.openContextMenu(timeline.clips.first());
        await expect(shell.getItem('Mute')).toBeVisible();
        await expect(shell.getItem('Unmute')).toHaveCount(0);

        await shell.getItem('Mute').click();
        await expect(shell.menu).toHaveCount(0);

        // Re-opening must reflect the new clip state, not a stale descriptor.
        await shell.openContextMenu(timeline.clips.first());
        await expect(shell.getItem('Unmute')).toBeVisible();
        await expect(shell.getItem('Mute')).toHaveCount(0);
    });
});
