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
        expect(await editor.timeline.isClipSelected(0)).toBe(false);

        await clip.click();
        expect(await editor.timeline.isClipSelected(0)).toBe(true);

        // Deselect again
        await editor.timeline.deselectAll();
        expect(await editor.timeline.isClipSelected(0)).toBe(false);
    });

});

test.describe('Timeline with Pre-loaded Clips', () => {

    test('Pre-loaded project shows clips on timeline', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        // project_v2_with_clips has 2 clips: clip_001 and clip_002
        await expect(timeline.clips).toHaveCount(2);

        // Verify clip names are visible
        await expect(timeline.getClipByName('A_woman_in')).toBeVisible();
        await expect(timeline.getClipByName('Professional_Mode')).toBeVisible();

        // Two tracks should be present
        await expect(timeline.rows).toHaveCount(2);
    });

    test('Clip selection toggles state and shows resize handles', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        // Deselect first
        await timeline.deselectAll();
        expect(await timeline.isClipSelected(0)).toBe(false);
        await expect(timeline.getClipResizeHandle(0, 'left')).toHaveCount(0);
        await expect(timeline.getClipResizeHandle(0, 'right')).toHaveCount(0);

        // Click the first clip to select it
        await timeline.clickClip(0);
        expect(await timeline.isClipSelected(0)).toBe(true);
        await expect(timeline.getClipResizeHandle(0, 'left')).toBeVisible();
        await expect(timeline.getClipResizeHandle(0, 'right')).toBeVisible();

        // Deselect by clicking background
        await timeline.deselectAll();
        expect(await timeline.isClipSelected(0)).toBe(false);
        await expect(timeline.getClipResizeHandle(0, 'left')).toHaveCount(0);
        await expect(timeline.getClipResizeHandle(0, 'right')).toHaveCount(0);
    });

    test('Delete clip removes it from timeline', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        await expect(timeline.clips).toHaveCount(2);

        // Select and delete the first clip
        await timeline.clickClip(0);
        await timeline.deleteSelected();

        await expect(timeline.clips).toHaveCount(1);
    });

    test('Undo restores deleted clip', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        // Delete a clip
        await timeline.clickClip(0);
        await timeline.deleteSelected();
        await expect(timeline.clips).toHaveCount(1);

        // Undo should restore it
        await timeline.undo();
        await expect(timeline.clips).toHaveCount(2);
    });

    test('Redo re-applies undone deletion', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        // Delete, undo, then redo
        await timeline.clickClip(0);
        await timeline.deleteSelected();
        await expect(timeline.clips).toHaveCount(1);

        await timeline.undo();
        await expect(timeline.clips).toHaveCount(2);

        await timeline.redo();
        await expect(timeline.clips).toHaveCount(1);
    });

    test('Split clip at playhead creates two clips', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        await expect(timeline.clips).toHaveCount(2);

        // Select clip_001 first, then seek to its midpoint and split
        await timeline.clickClip(0);

        // Seek to ~15% of the ruler (within clip_001 which starts at 0 and is 8s)
        await timeline.clickRulerAt(0.15);

        await timeline.splitAtPlayhead();

        // clip_001 should now be split into 2 clips, plus clip_002 = 3 total
        await expect(timeline.clips).toHaveCount(3);
    });

    test('Copy and paste duplicates clip', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        await expect(timeline.clips).toHaveCount(2);

        // Select the first clip, copy, paste
        await timeline.clickClip(0);
        await timeline.copy();
        await timeline.paste();

        // Pasted clip appears above the original track
        await expect(timeline.clips).toHaveCount(3);
    });

    test('Track visibility toggle updates pressed state and clip visibility state', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        // Get the visibility toggle for track 1 (row index 0)
        const toggle = timeline.getTrackVisibilityToggle(0);
        await expect(toggle).toBeVisible();

        const clip = timeline.getClip(0);
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect(clip).toHaveAttribute('data-track-visible', 'true');

        // Toggle visibility off
        await toggle.click();

        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await expect(clip).toHaveAttribute('data-track-visible', 'false');

        // Toggle back on
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect(clip).toHaveAttribute('data-track-visible', 'true');
    });

    test('Track mute toggle updates pressed state', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        // Track 1 is a visual track — it should have a mute toggle
        const muteToggle = timeline.getTrackMuteToggle(0);
        await expect(muteToggle).toBeVisible();

        await expect(muteToggle).toHaveAttribute('aria-pressed', 'false');

        // Click to mute
        await muteToggle.click();

        await expect(muteToggle).toHaveAttribute('aria-pressed', 'true');

        // Toggle back
        await muteToggle.click();
        await expect(muteToggle).toHaveAttribute('aria-pressed', 'false');
    });

    test('Snapping toggle updates pressed state', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;
        const toggle = timeline.snappingToggle;

        await expect(toggle).toHaveAttribute('aria-pressed', 'true');

        // Toggle snapping off
        await toggle.click();

        await expect(toggle).toHaveAttribute('aria-pressed', 'false');

        // Toggle back on
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    });

});
