import { test, expect } from './fixtures';

test.describe('Mask Panel (Shape Masks)', () => {

    test('Empty mask state shows "Add a mask"', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // No masks yet — placeholder text and add chip visible
        await expect(maskPanel.panel.getByText('Add a mask to start editing.')).toBeVisible();
        await expect(maskPanel.addMaskChip).toBeVisible();
        // No mask chips should exist
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
    });

    test('Mask mode switching', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // Add a rectangle mask to access mode controls
        await maskPanel.addMask('Rectangle');

        // Default mode is Apply — verify all three buttons are visible
        await expect(maskPanel.getModeButton('apply')).toBeVisible();
        await expect(maskPanel.getModeButton('preview')).toBeVisible();
        await expect(maskPanel.getModeButton('off')).toBeVisible();

        // Switch to Preview
        await maskPanel.setMode('Preview');
        // Switch to Off
        await maskPanel.setMode('Off');
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
        await expect(maskPanel.maskChips).toHaveCount(1);
        await expect(maskPanel.deleteButton).toBeVisible();

        // Delete it
        await maskPanel.deleteMask();

        // Should return to empty state
        await expect(maskPanel.maskChips).toHaveCount(0);
        await expect(maskPanel.panel.getByText('Add a mask to start editing.')).toBeVisible();
    });

    test('Multiple mask chips and switching', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // Add two masks
        await maskPanel.addMask('Circle');
        await expect(maskPanel.maskChips).toHaveCount(1);

        await maskPanel.addMask('Rectangle');
        await expect(maskPanel.maskChips).toHaveCount(2);

        // Verify chip labels
        await expect(maskPanel.maskChips.nth(0)).toHaveText('Mask 1');
        await expect(maskPanel.maskChips.nth(1)).toHaveText('Mask 2');

        // Click first chip to switch back
        await maskPanel.maskChips.nth(0).click();
        // Mode controls should still be visible (mask is selected)
        await expect(maskPanel.getModeButton('apply')).toBeVisible();
    });

});
