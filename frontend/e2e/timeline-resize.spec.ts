import { test, expect } from './fixtures';

test.describe('Clip Resize & Snapping', () => {

    test('Resize clip from right edge shortens clip', async ({ editorWithClips }) => {
        const { timeline, page } = editorWithClips;

        // Select clip to reveal resize handles
        await timeline.clickClip(0);
        const clip = timeline.getClip(0);
        const rightHandle = timeline.getClipResizeHandle(0, 'right');
        await expect(rightHandle).toBeVisible();

        // Measure initial clip width
        const initialBox = await clip.boundingBox();
        expect(initialBox).toBeTruthy();
        const initialWidth = initialBox!.width;

        // Drag the right handle to the left to shrink the clip
        const handleBox = await rightHandle.boundingBox();
        expect(handleBox).toBeTruthy();
        const startX = handleBox!.x + handleBox!.width / 2;
        const startY = handleBox!.y + handleBox!.height / 2;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX - 60, startY, { steps: 10 });
        await page.mouse.up();

        // Clip should be narrower now
        const finalBox = await clip.boundingBox();
        expect(finalBox).toBeTruthy();
        expect(finalBox!.width).toBeLessThan(initialWidth);
    });

    test('Resize clip from left edge shortens clip and shifts start', async ({ editorWithClips }) => {
        const { timeline, page } = editorWithClips;

        // Select clip to reveal resize handles
        await timeline.clickClip(0);
        const clip = timeline.getClip(0);
        const leftHandle = timeline.getClipResizeHandle(0, 'left');
        await expect(leftHandle).toBeVisible();

        // Measure initial clip position and width
        const initialBox = await clip.boundingBox();
        expect(initialBox).toBeTruthy();
        const initialWidth = initialBox!.width;
        const initialLeft = initialBox!.x;

        // Drag the left handle to the right to shrink the clip
        const handleBox = await leftHandle.boundingBox();
        expect(handleBox).toBeTruthy();
        const startX = handleBox!.x + handleBox!.width / 2;
        const startY = handleBox!.y + handleBox!.height / 2;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 60, startY, { steps: 10 });
        await page.mouse.up();

        // Clip should be narrower and shifted right
        const finalBox = await clip.boundingBox();
        expect(finalBox).toBeTruthy();
        expect(finalBox!.width).toBeLessThan(initialWidth);
        expect(finalBox!.x).toBeGreaterThan(initialLeft);
    });

    test('Resize bounded by minimum duration', async ({ editorWithClips }) => {
        const { timeline, page } = editorWithClips;

        // Select clip to reveal resize handles
        await timeline.clickClip(0);
        const clip = timeline.getClip(0);
        const rightHandle = timeline.getClipResizeHandle(0, 'right');

        // Drag the right handle very far left to exceed minimum
        const handleBox = await rightHandle.boundingBox();
        expect(handleBox).toBeTruthy();
        const startX = handleBox!.x + handleBox!.width / 2;
        const startY = handleBox!.y + handleBox!.height / 2;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX - 2000, startY, { steps: 20 });
        await page.mouse.up();

        // Clip should still have positive width (minimum enforced)
        const finalBox = await clip.boundingBox();
        expect(finalBox).toBeTruthy();
        expect(finalBox!.width).toBeGreaterThan(0);
    });

    test('Snap indicator appears near snap point', async ({ editorWithClips }) => {
        const { timeline, page } = editorWithClips;

        // Ensure snapping is enabled (default)
        await expect(timeline.snappingToggle).toHaveAttribute('aria-pressed', 'true');

        // Select clip 0 and resize its right handle toward clip 1's start — triggers snap
        await timeline.clickClip(0);
        const rightHandle = timeline.getClipResizeHandle(0, 'right');
        await expect(rightHandle).toBeVisible();

        const clip1Box = await timeline.getClip(1).boundingBox();
        expect(clip1Box).toBeTruthy();
        const snapTargetX = clip1Box!.x;

        const handleBox = await rightHandle.boundingBox();
        expect(handleBox).toBeTruthy();
        const startX = handleBox!.x + handleBox!.width / 2;
        const startY = handleBox!.y + handleBox!.height / 2;

        // Drag the right handle toward the start of clip 1 (snap point)
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(snapTargetX, startY, { steps: 20 });

        // Snap indicator should become visible while resizing near snap point
        await expect(timeline.snapIndicator).toBeVisible();

        await page.mouse.up();
    });

    test('Snapping disabled hides indicator', async ({ editorWithClips }) => {
        const { timeline, page } = editorWithClips;

        // Disable snapping
        await timeline.toggleSnapping();
        await expect(timeline.snappingToggle).toHaveAttribute('aria-pressed', 'false');

        // Select clip 0 and resize its right handle toward clip 1's start
        await timeline.clickClip(0);
        const rightHandle = timeline.getClipResizeHandle(0, 'right');
        await expect(rightHandle).toBeVisible();

        const clip1Box = await timeline.getClip(1).boundingBox();
        expect(clip1Box).toBeTruthy();
        const snapTargetX = clip1Box!.x;

        const handleBox = await rightHandle.boundingBox();
        expect(handleBox).toBeTruthy();
        const startX = handleBox!.x + handleBox!.width / 2;
        const startY = handleBox!.y + handleBox!.height / 2;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(snapTargetX, startY, { steps: 20 });

        // Snap indicator should NOT appear with snapping disabled
        await expect(timeline.snapIndicator).not.toBeVisible();

        await page.mouse.up();
    });

});
