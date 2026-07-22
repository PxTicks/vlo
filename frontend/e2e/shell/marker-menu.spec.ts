import { test, expect } from '../fixtures';

/**
 * Phase 3.4 of docs/e2e-coverage-plan.md — `timeline.marker.context`.
 *
 * Markers render through the clip overlay layer, which stamps
 * `data-overlay-item-id="clip-marker:<id>"` on each item
 * (`TimelineClipOverlayLayer.tsx:402`). The marker glyph itself is
 * `pointer-events: none`, so the overlay wrapper is the event target.
 */
const MARKER_SELECTOR = '[data-overlay-item-id^="clip-marker:"]';

/**
 * Moves the playhead away from the clip's left edge before adding a marker.
 *
 * A marker dropped at tick 0 renders underneath `timeline-clip-resize-handle-left`,
 * which paints over the overlay item and swallows the right-click — the clip
 * context menu opens instead of the marker's. That occlusion is a real (if
 * minor) interaction issue in its own right; these specs sidestep it so they
 * test the menu rather than the overlap.
 */
async function movePlayheadIntoClip(page: import('@playwright/test').Page) {
    const ruler = page.getByTestId('timeline-ruler');
    const box = await ruler.boundingBox();
    if (!box) throw new Error('Timeline ruler has no bounding box');
    await page.mouse.click(box.x + 160, box.y + box.height / 2);
}

test.describe('Timeline marker context menu', () => {
    test('@smoke marker menu deletes the marker it targets', async ({
        editorWithClips,
    }) => {
        const { timeline, shell, page } = editorWithClips;

        await timeline.clickClip(0);
        await movePlayheadIntoClip(page);
        await page.getByTestId('timeline-add-marker').click();

        const markers = page.locator(MARKER_SELECTOR);
        await expect(markers).toHaveCount(1);

        // The add-marker tooltip stays under the cursor and would intercept the
        // right-click, so move the pointer off it first.
        await page.mouse.move(5, 5);
        await expect(page.getByRole('tooltip')).toHaveCount(0);

        await shell.openContextMenu(markers.first());
        await expect(shell.getItem('Delete marker')).toBeVisible();

        await shell.getItem('Delete marker').click();
        await expect(shell.menu).toHaveCount(0);
        await expect(markers).toHaveCount(0);
    });

    test('dismissing the marker menu leaves the marker in place', async ({
        editorWithClips,
    }) => {
        const { timeline, shell, page } = editorWithClips;

        await timeline.clickClip(0);
        await page.getByTestId('timeline-add-marker').click();

        const markers = page.locator(MARKER_SELECTOR);
        await expect(markers).toHaveCount(1);

        await page.mouse.move(5, 5);
        await expect(page.getByRole('tooltip')).toHaveCount(0);

        await shell.openContextMenu(markers.first());
        await shell.closeWithEscape();

        await expect(markers).toHaveCount(1);
    });
});
