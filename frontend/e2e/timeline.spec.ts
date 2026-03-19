import { test, expect } from './fixtures';
import { dragAssetToTimeline } from './helpers/drag';

test.describe('Timeline Interactions', () => {

    test('Smoke Test: Timeline components are visible', async ({ editor }) => {
        await expect(editor.timeline.toolbar).toBeVisible();
        await expect(editor.timeline.ruler).toBeVisible();
        await expect(editor.timeline.rows.first()).toBeVisible();
        await expect(editor.timeline.body).toBeVisible();
    });

    test('Drag and Drop Asset to Timeline', async ({ editor }) => {
        await dragAssetToTimeline(editor.page);
        await expect(editor.timeline.clips.first()).toBeVisible();
    });

    test('Selection: Clicking clips toggles selection', async ({ editor }) => {
        // Drag a clip in first
        await dragAssetToTimeline(editor.page);

        const clip = editor.timeline.getClip(0);
        await expect(clip).toBeVisible();

        // Click timeline background (deselect), then clip (select), then background again
        await editor.timeline.deselectAll();
        await clip.click();
        await expect(clip).toBeVisible();

        // Deselect again
        await editor.timeline.deselectAll();
        await expect(clip).toBeVisible();
    });

});
