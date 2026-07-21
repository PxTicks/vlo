import { test, expect } from '../fixtures';

/**
 * Phase 3.1/3.2/3.4 of docs/e2e-coverage-plan.md.
 *
 * `core/shell` carries unit coverage for its registries in isolation; what was
 * untested is that a real render, a real right-click and a real dispatch reach
 * the right command. These specs drive the declared host menus at the GUI.
 */
test.describe('Shell host menus', () => {
    test('@smoke clip context menu renders its declared items and dispatches', async ({
        editorWithClips,
    }) => {
        const { shell, timeline } = editorWithClips;

        const clipsBefore = await timeline.clips.count();
        await shell.openContextMenu(timeline.clips.first());

        // Subject-scoped items for `timeline.clip.context`.
        for (const label of ['Delete', 'Copy', 'Extract Audio', 'Reverse Clip', 'Mute']) {
            await expect(shell.getItem(label)).toBeVisible();
        }

        // Dispatch must produce the observable effect, not merely close the menu.
        await shell.getItem('Delete').click();
        await expect(shell.menu).toHaveCount(0);
        await expect(timeline.clips).toHaveCount(clipsBefore - 1);
    });

    test('track context menu is scoped to its own subject', async ({
        editorWithClips,
    }) => {
        const { shell, page } = editorWithClips;

        await shell.openContextMenu(
            page.getByTestId('timeline-track-header').first(),
        );

        await expect(shell.getItem('Hide track')).toBeVisible();
        await expect(shell.getItem('Mute track')).toBeVisible();
        // Clip-scoped commands must not leak into the track subject.
        await expect(shell.getItem('Extract Audio')).toHaveCount(0);
    });

    test('player canvas context menu renders player commands', async ({
        editorWithClips,
    }) => {
        const { shell, page } = editorWithClips;

        await shell.openContextMenu(page.getByTestId('player-canvas-container'));

        for (const label of ['Play', 'Fit to screen', 'Export…']) {
            await expect(shell.getItem(label)).toBeVisible();
        }
    });

    test('library browser context menu exposes import and sort options', async ({
        editorWithClips,
    }) => {
        const { shell, page } = editorWithClips;

        await page
            .getByTestId('asset-browser')
            .click({ button: 'right', position: { x: 5, y: 5 } });
        await shell.menu.first().waitFor({ state: 'visible' });

        await expect(shell.getItem('Import assets…')).toBeVisible();
        await expect(shell.getItem('Newest First')).toBeVisible();
        await expect(shell.getItem('Name (A-Z)')).toBeVisible();
    });

    test('menus dismiss on Escape and on outside click', async ({
        editorWithClips,
    }) => {
        const { shell, timeline } = editorWithClips;

        await shell.openContextMenu(timeline.clips.first());
        await shell.closeWithEscape();
        await expect(shell.menu).toHaveCount(0);

        await shell.openContextMenu(timeline.clips.first());
        await shell.closeWithOutsideClick();
        await expect(shell.menu).toHaveCount(0);
    });

    test('dismissing a menu does not dispatch its commands', async ({
        editorWithClips,
    }) => {
        const { shell, timeline } = editorWithClips;

        const clipsBefore = await timeline.clips.count();

        await shell.openContextMenu(timeline.clips.first());
        await shell.getItem('Delete').hover();
        await shell.closeWithEscape();

        await expect(timeline.clips).toHaveCount(clipsBefore);
    });
});
