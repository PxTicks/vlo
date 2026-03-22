import { test, expect } from './fixtures';

// Fixture project_v1: title="Penguin", defaults: 16:9, 30fps, compact layout

test.describe('Project Title', () => {

    test('Displays the project title', async ({ editor }) => {
        const title = editor.page.getByTestId('project-title-display');
        await expect(title).toBeVisible();
        await expect(title).toHaveText('Penguin');
    });

    test('Click to edit, rename with Enter', async ({ editor }) => {
        const title = editor.page.getByTestId('project-title-display');
        await title.click();

        // Edit mode: text field appears
        const input = editor.page.getByTestId('project-title-input').locator('input');
        await expect(input).toBeVisible();
        await expect(input).toHaveValue('Penguin');

        // Type a new name and press Enter
        await input.fill('My Renamed Project');
        await input.press('Enter');

        // Back to display mode with new name
        await expect(editor.page.getByTestId('project-title-display')).toHaveText('My Renamed Project');
    });

    test('Cancel editing with Escape', async ({ editor }) => {
        const title = editor.page.getByTestId('project-title-display');
        await title.click();

        const input = editor.page.getByTestId('project-title-input').locator('input');
        await input.fill('Some Other Name');
        await input.press('Escape');

        // Should revert to original title
        await expect(editor.page.getByTestId('project-title-display')).toHaveText('Penguin');
    });

});

test.describe('Project Settings Menu', () => {

    test('Opens settings menu with gear icon', async ({ editor }) => {
        const settingsBtn = editor.page.getByTestId('project-settings-button');
        await expect(settingsBtn).toBeVisible();
        await settingsBtn.click();

        // Menu is visible with section headers
        const menu = editor.page.getByRole('menu');
        await expect(menu).toBeVisible();
        await expect(menu.getByText('LAYOUT', { exact: true })).toBeVisible();
        await expect(menu.getByText('FPS', { exact: true })).toBeVisible();
        await expect(menu.getByText('ASPECT RATIO', { exact: true })).toBeVisible();
    });

    test('Shows all layout options with current selection checked', async ({ editor }) => {
        await editor.page.getByTestId('project-settings-button').click();
        const menu = editor.page.getByRole('menu');

        // Both layout options present
        const fullHeight = menu.getByRole('menuitem', { name: /Full Height Sidebars/i });
        const classic = menu.getByRole('menuitem', { name: /Classic.*Wide Timeline/i });
        await expect(fullHeight).toBeVisible();
        await expect(classic).toBeVisible();

        // Default is "compact" — Classic should have a check icon
        await expect(classic.getByTestId('CheckIcon')).toBeVisible();
    });

    test('Shows all FPS options with current selection checked', async ({ editor }) => {
        await editor.page.getByTestId('project-settings-button').click();
        const menu = editor.page.getByRole('menu');

        // All 5 FPS options present
        for (const fps of [16, 24, 25, 30, 60]) {
            await expect(menu.getByRole('menuitem', { name: `${fps} fps` })).toBeVisible();
        }

        // Default is 30fps — should have a check
        const fps30 = menu.getByRole('menuitem', { name: '30 fps' });
        await expect(fps30.getByTestId('CheckIcon')).toBeVisible();
    });

    test('Shows all aspect ratio options with current selection checked', async ({ editor }) => {
        await editor.page.getByTestId('project-settings-button').click();
        const menu = editor.page.getByRole('menu');

        // All 5 aspect ratio options present
        const ratios = ['16:9 (Landscape)', '4:3 (Standard)', '1:1 (Square)', '3:4 (Portrait)', '9:16 (Story)'];
        for (const ratio of ratios) {
            await expect(menu.getByRole('menuitem', { name: ratio })).toBeVisible();
        }

        // Default is 16:9 — should have a check
        const ratio169 = menu.getByRole('menuitem', { name: '16:9 (Landscape)' });
        await expect(ratio169.getByTestId('CheckIcon')).toBeVisible();
    });

    test('Change FPS setting', async ({ editor }) => {
        // Open menu and select 24 fps
        await editor.page.getByTestId('project-settings-button').click();
        await editor.page.getByRole('menuitem', { name: '24 fps' }).click();

        // Menu closes after selection
        await expect(editor.page.getByRole('menu')).toBeHidden();

        // Re-open and verify 24 fps now has check
        await editor.page.getByTestId('project-settings-button').click();
        const fps24 = editor.page.getByRole('menuitem', { name: '24 fps' });
        await expect(fps24.getByTestId('CheckIcon')).toBeVisible();

        // 30 fps should no longer have check
        const fps30 = editor.page.getByRole('menuitem', { name: '30 fps' });
        await expect(fps30.getByTestId('CheckIcon')).toHaveCount(0);
    });

    test('Change aspect ratio setting', async ({ editor }) => {
        // Open menu and select 1:1
        await editor.page.getByTestId('project-settings-button').click();
        await editor.page.getByRole('menuitem', { name: '1:1 (Square)' }).click();

        await expect(editor.page.getByRole('menu')).toBeHidden();

        // Re-open and verify 1:1 now has check
        await editor.page.getByTestId('project-settings-button').click();
        const square = editor.page.getByRole('menuitem', { name: '1:1 (Square)' });
        await expect(square.getByTestId('CheckIcon')).toBeVisible();

        // 16:9 should no longer have check
        const landscape = editor.page.getByRole('menuitem', { name: '16:9 (Landscape)' });
        await expect(landscape.getByTestId('CheckIcon')).toHaveCount(0);
    });

    test('Change layout setting', async ({ editor }) => {
        // Open menu and select Full Height Sidebars
        await editor.page.getByTestId('project-settings-button').click();
        await editor.page.getByRole('menuitem', { name: /Full Height Sidebars/i }).click();

        await expect(editor.page.getByRole('menu')).toBeHidden();

        // Re-open and verify Full Height now has check
        await editor.page.getByTestId('project-settings-button').click();
        const fullHeight = editor.page.getByRole('menuitem', { name: /Full Height Sidebars/i });
        await expect(fullHeight.getByTestId('CheckIcon')).toBeVisible();

        // Classic should no longer have check
        const classic = editor.page.getByRole('menuitem', { name: /Classic.*Wide Timeline/i });
        await expect(classic.getByTestId('CheckIcon')).toHaveCount(0);
    });

});
