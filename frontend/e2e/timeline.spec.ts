import { test, expect } from '@playwright/test';
import { setupProject, dragAssetToTimeline } from './utils';

test.describe('Timeline Interactions', () => {

    test.beforeEach(async ({ page }) => {
        await setupProject(page);
    });

    test('Smoke Test: Timeline components are visible', async ({ page }) => {
        await expect(page.getByTestId('timeline-toolbar')).toBeVisible();
        await expect(page.getByTestId('timeline-ruler')).toBeVisible();
        await expect(page.getByTestId('timeline-row').first()).toBeVisible();
        await expect(page.getByTestId('timeline-body').first()).toBeVisible();
    });

    test('Drag and Drop Asset to Timeline', async ({ page }) => {
        await dragAssetToTimeline(page);
    });

    test('Selection: Clicking clips toggles selection', async ({ page }) => {
        // Prerequisite: Drag a clip in first
        await dragAssetToTimeline(page);

        const clip = page.locator(`[data-testid="timeline-clip"]`).first();
        await expect(clip).toBeVisible();

        const timelineBody = page.getByTestId('timeline-body').first();
        await expect(timelineBody).toBeVisible();

        // Click timeline background (deselect), then clip (select), then background again.
        await timelineBody.click({ position: { x: 20, y: 20 } });
        
        // Now click clip
        await clip.click();
        await expect(clip).toBeVisible();

        // Deselect again
        await timelineBody.click({ position: { x: 30, y: 20 } });
        await expect(clip).toBeVisible();
    });

});
