import { test, expect } from '../fixtures';

test.describe('Portable dock panels', () => {
    test('moves scopes between the bottom dock and the right sidebar', async ({
        editorWithClips,
    }) => {
        const { page } = editorWithClips;
        const sidebarScopesTab = page.getByTestId('right-sidebar-tab-scopes');

        await page.getByRole('button', { name: 'Toggle video scopes' }).click();
        const dock = page.getByTestId('editor-bottom-dock');
        await expect(dock).toBeVisible();
        await expect(dock.getByRole('tab', { name: 'Scopes' })).toBeVisible();
        await expect(dock.locator('canvas')).toBeVisible();

        await page.getByTestId('view-layout-button-bottom-dock').click();
        await page
            .getByRole('button', { name: 'Move Scopes to another region' })
            .click();
        await page.getByTestId('view-move-to-right-sidebar').click();

        // The dock existed only for scopes, so it goes with them.
        await expect(dock).toHaveCount(0);
        await expect(sidebarScopesTab).toBeVisible();
        await expect(sidebarScopesTab).toHaveAttribute(
            'aria-selected',
            'true',
        );
        const sidebarScopes = page
            .locator('#shell-region-right-sidebar canvas')
            .first();
        await expect(sidebarScopes).toBeVisible();

        // Placement is personal state, so it has to survive a reload.
        await editorWithClips.reopenProject();
        await expect(sidebarScopesTab).toBeVisible();
        await expect(page.getByTestId('editor-bottom-dock')).toHaveCount(0);

        await page.getByTestId('view-layout-button-right-sidebar').click();
        await page
            .getByRole('button', { name: 'Move Scopes to another region' })
            .click();
        await page.getByTestId('view-move-to-bottom-dock').click();

        await expect(page.getByTestId('editor-bottom-dock')).toBeVisible();
        await expect(sidebarScopesTab).toHaveCount(0);
        await expect(
            page.getByTestId('editor-bottom-dock').getByRole('tab', { name: 'Scopes' }),
        ).toBeVisible();
    });

    test('keeps a moved panel put while the clip selection changes', async ({
        editorWithClips,
    }) => {
        const { page, timeline } = editorWithClips;
        const sidebarScopesTab = page.getByTestId('right-sidebar-tab-scopes');

        await page.getByRole('button', { name: 'Toggle video scopes' }).click();
        await page.getByTestId('view-layout-button-bottom-dock').click();
        await page
            .getByRole('button', { name: 'Move Scopes to another region' })
            .click();
        await page.getByTestId('view-move-to-right-sidebar').click();
        await expect(sidebarScopesTab).toHaveAttribute(
            'aria-selected',
            'true',
        );

        // Selecting a clip normally snaps this sidebar to Adjust.
        await timeline.clickClip(0);
        await expect(sidebarScopesTab).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });
});
