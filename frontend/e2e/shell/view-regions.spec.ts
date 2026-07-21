import { test, expect } from '../fixtures';

/**
 * Phase 3.5 of docs/e2e-coverage-plan.md.
 *
 * The shell view registry owns which views a region shows, in what order, and
 * persists user overrides to `vlo.shell.view-layout.v1`. Unit tests cover the
 * registry; these drive the real UI and — critically — the persistence, which
 * only a reopen can exercise.
 */
test.describe('Shell view regions', () => {
    const RIGHT_SIDEBAR_VIEWS = [
        'Generate',
        'Transition',
        'Adjust',
        'Transform',
        'Mask',
    ];

    async function openRightSidebarLayout(page: import('@playwright/test').Page) {
        await page.getByTestId('view-layout-button-right-sidebar').click();
        await expect(page.getByRole('dialog')).toBeVisible();
    }

    test('@smoke panel manager lists every registered right-sidebar view', async ({
        editorWithClips,
    }) => {
        const { timeline, page } = editorWithClips;

        await timeline.clickClip(0);
        await openRightSidebarLayout(page);

        for (const view of RIGHT_SIDEBAR_VIEWS) {
            await expect(
                page.getByRole('checkbox', { name: `Show ${view}` }),
            ).toBeVisible();
        }
    });

    test('hiding a view removes its tab from the region', async ({
        editorWithClips,
    }) => {
        const { timeline, rightSidebar, page } = editorWithClips;

        await timeline.clickClip(0);
        await expect(rightSidebar.getTab('Mask')).toBeVisible();

        await openRightSidebarLayout(page);
        await page.getByRole('checkbox', { name: 'Show Mask' }).click();
        await page.keyboard.press('Escape');

        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);
        // Hiding one view must not disturb its neighbours.
        await expect(rightSidebar.getTab('Adjust')).toBeVisible();
    });

    test('a hidden view stays hidden after reopening the project', async ({
        editorWithClips,
    }) => {
        const { timeline, rightSidebar, page } = editorWithClips;

        await timeline.clickClip(0);
        await openRightSidebarLayout(page);
        await page.getByRole('checkbox', { name: 'Show Mask' }).click();
        await page.keyboard.press('Escape');
        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);

        await editorWithClips.reopenProject();
        await timeline.clickClip(0);

        // Layout overrides live in browser storage, not the project document,
        // so they must survive a reload of the same project.
        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);
        await expect(rightSidebar.getTab('Adjust')).toBeVisible();
    });

    test('restoring visibility brings the tab back', async ({
        editorWithClips,
    }) => {
        const { timeline, rightSidebar, page } = editorWithClips;

        await timeline.clickClip(0);
        await openRightSidebarLayout(page);
        await page.getByRole('checkbox', { name: 'Show Mask' }).click();
        await page.keyboard.press('Escape');
        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);

        await openRightSidebarLayout(page);
        await page.getByRole('checkbox', { name: 'Show Mask' }).click();
        await page.keyboard.press('Escape');

        await expect(rightSidebar.getTab('Mask')).toBeVisible();
    });
});
