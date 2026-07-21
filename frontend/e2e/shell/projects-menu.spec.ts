import { test, expect } from '../fixtures';

/**
 * Phase 3.4 of docs/e2e-coverage-plan.md — `projects.item.context`.
 *
 * This menu lives on the landing page rather than the editor, so it is reached
 * by opening a project (which records a recent entry) and reloading back to the
 * launcher.
 */
test.describe('Projects page context menu', () => {
    test('recent project entry offers open and remove', async ({
        editorWithClips,
    }) => {
        const { shell, page } = editorWithClips;

        await page.reload();
        const entry = page.getByRole('listitem').first();
        await expect(entry).toBeVisible();

        await shell.openContextMenu(entry);
        await expect(shell.getItem('Open project')).toBeVisible();
        await expect(shell.getItem('Remove from recents')).toBeVisible();

        // Settle before teardown: the launcher lists the project directory on
        // load, and ending the test mid-flight tears down the mock filesystem
        // routes under that request, surfacing as a console error.
        await shell.closeWithEscape();
        await page.waitForLoadState('networkidle');
    });

    test('removing a recent dispatches and drops the entry', async ({
        editorWithClips,
    }) => {
        const { shell, page } = editorWithClips;

        await page.reload();
        const entries = page.getByRole('listitem');
        await expect(entries).toHaveCount(1);

        await shell.openContextMenu(entries.first());
        await shell.getItem('Remove from recents').click();

        // Dispatch must reach the recents service, not merely close the menu.
        await expect(shell.menu).toHaveCount(0);
        await expect(entries).toHaveCount(0);

        await page.waitForLoadState('networkidle');
    });
});
