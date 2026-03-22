import { test, expect } from './fixtures';

test.describe('Right Sidebar & Transformation Panel', () => {

    test('Only Generate tab visible when no clip selected', async ({ editor }) => {
        const { rightSidebar } = editor;

        await expect(rightSidebar.tabs).toBeVisible();
        await expect(rightSidebar.getTab('Generate')).toBeVisible();
        await expect(rightSidebar.getTab('Transform')).toHaveCount(0);
        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);
    });

    test('Selecting clip reveals Transform and Mask tabs', async ({ editorWithClips }) => {
        const { rightSidebar, timeline } = editorWithClips;

        // Initially no clip selected — only Generate tab
        await timeline.deselectAll();
        await expect(rightSidebar.getTab('Transform')).toHaveCount(0);
        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);

        // Select a clip — all 3 tabs should appear
        await timeline.clickClip(0);
        await expect(rightSidebar.getTab('Generate')).toBeVisible();
        await expect(rightSidebar.getTab('Transform')).toBeVisible();
        await expect(rightSidebar.getTab('Mask')).toBeVisible();
    });

    test('Switch to Transform tab shows panel', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, transformationPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Transform');

        await expect(transformationPanel.panel).toBeVisible();
        await expect(transformationPanel.addButton).toBeVisible();
    });

    test('Switch to Mask tab shows panel', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, maskPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');

        // Mask panel content should be present
        await expect(maskPanel.addMaskChip).toBeVisible();
    });

    test('Deselecting clip returns to Generate tab', async ({ editorWithClips }) => {
        const { rightSidebar, timeline } = editorWithClips;

        // Select clip and switch to Transform tab
        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Transform');
        await expect(rightSidebar.getTab('Transform')).toBeVisible();

        // Deselect — should reset to Generate-only
        await timeline.deselectAll();
        await expect(rightSidebar.getTab('Generate')).toBeVisible();
        await expect(rightSidebar.getTab('Transform')).toHaveCount(0);
        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);
    });

    test('Add transformation from menu', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, transformationPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Transform');

        // Click the add button to open the menu
        await transformationPanel.addButton.click();
        await expect(transformationPanel.addMenu).toBeVisible();

        // Pick a transform from the menu (e.g. Blur)
        await editorWithClips.page.getByRole('menuitem', { name: 'Blur', exact: true }).click();

        // Menu should close and a new section should appear with the transform name
        await expect(transformationPanel.addMenu).not.toBeVisible();
        await expect(transformationPanel.panel.getByRole('heading', { name: 'Blur' })).toBeVisible();
    });

    test('Default transformation sections visible for video clip', async ({ editorWithClips }) => {
        const { rightSidebar, timeline, transformationPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Transform');

        // Default sections for a video clip: Layout and Volume
        await expect(transformationPanel.panel.getByRole('heading', { name: 'Layout' })).toBeVisible();
        await expect(transformationPanel.panel.getByRole('heading', { name: 'Volume' })).toBeVisible();
    });

});
