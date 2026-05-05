import { test, expect } from './fixtures';

test.describe('Mask Panel (Shape Masks)', () => {

    test('Empty mask state shows "Add a mask"', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // No masks yet — the home view shows the add action and an empty equation.
        await expect(maskPanel.addMaskChip).toBeVisible();
        await expect(maskPanel.equation).toBeVisible();
        await expect(maskPanel.maskChips).toHaveCount(0);
    });

    test('Add mask menu shows all shape types', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel, page } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // Open the add mask menu
        await maskPanel.addMaskChip.click();
        await expect(maskPanel.addMenu).toBeVisible();

        // Verify all mask type options are present
        await expect(page.getByRole('menuitem', { name: 'Circle' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Rectangle' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Triangle' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Sam2' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Brush' })).toBeVisible();
    });

    test('Mask mode switching', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // Add a rectangle mask to access mode controls
        await maskPanel.addMask('Rectangle');

        // Default mode is Apply — verify the current apply/preview controls.
        await expect(maskPanel.getModeButton('apply')).toBeVisible();
        await expect(maskPanel.getModeButton('preview')).toBeVisible();

        // Switch to Preview
        await maskPanel.setMode('Preview');
        // Switch back to Apply
        await maskPanel.setMode('Apply');
    });

    test('Mask inversion toggle', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // Add a rectangle mask to access inversion controls
        await maskPanel.addMask('Rectangle');

        // Verify both inversion buttons are visible
        await expect(maskPanel.getInversionButton('normal')).toBeVisible();
        await expect(maskPanel.getInversionButton('inverted')).toBeVisible();

        // Toggle to Inverted
        await maskPanel.setInversion('Inverted');
        // Toggle back to Normal
        await maskPanel.setInversion('Normal');
    });

    test('Delete a mask returns to empty state', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // Add a mask
        await maskPanel.addMask('Circle');
        await expect(maskPanel.deleteButton).toBeVisible();

        // Delete it
        await maskPanel.deleteMask();

        // Should return to empty state
        await expect(maskPanel.maskChips).toHaveCount(0);
        await expect(maskPanel.addMaskChip).toBeVisible();
    });

    test('Multiple mask chips and switching', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // Add two masks
        await maskPanel.addMask('Circle');
        await expect(maskPanel.backButton).toBeVisible();
        await maskPanel.backButton.click();
        await expect(maskPanel.maskChips).toHaveCount(1);

        await maskPanel.addMask('Rectangle');
        await expect(maskPanel.backButton).toBeVisible();
        await maskPanel.backButton.click();
        await expect(maskPanel.maskChips).toHaveCount(2);

        // Verify chip labels
        await expect(maskPanel.maskChips.nth(0)).toHaveText('Mask 1');
        await expect(maskPanel.maskChips.nth(1)).toHaveText('Mask 2');

        // Clicking a chip selects it in the equation builder.
        await maskPanel.maskChips.nth(0).click();
        await expect(maskPanel.maskChips.nth(0)).toHaveAttribute('aria-label', 'Mask 1');
    });

});
