import { test, expect } from './fixtures';
import { ADJUST_SECTIONS } from './components/RightSidebarComponent';

test.describe('Right Sidebar & Transformation Panel', () => {

    test('Only Generate tab visible when no clip selected', async ({ editor }) => {
        const { rightSidebar } = editor;

        await expect(rightSidebar.tabs).toBeVisible();
        await expect(rightSidebar.getTab('Generate')).toBeVisible();
        await expect(rightSidebar.getTab('Transform')).toHaveCount(0);
        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);
    });

    test('@smoke Selecting clip reveals Transform and Mask tabs', async ({ editorWithClips }) => {
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

        await expect(transformationPanel.effectsPanel).toBeVisible();
        // A freshly selected clip carries no effects; the panel no longer shows
        // default Layout/Volume sections, only what has been added to the clip.
        await expect(transformationPanel.effectsPanel).toContainText(
            'No effects have been added to this clip.',
        );
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

    test('Adjust tab exposes the built-in clip property sections', async ({
        editorWithClips,
    }) => {
        const { rightSidebar, timeline } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Adjust');

        // Successor to the old "default transformation sections" coverage: the
        // former Layout and Volume sections now live here as Display and Audio,
        // with Layout, Fit Mode and Blend Mode unified into Display.
        for (const section of ADJUST_SECTIONS) {
            await expect(rightSidebar.getAdjustSection(section)).toBeVisible();
        }
    });

    test('Adjust sections are selectable and Display is the default', async ({
        editorWithClips,
    }) => {
        const { rightSidebar, timeline, transformationPanel } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Adjust');

        await expect(
            transformationPanel.adjustPanel.getByRole('heading', { name: 'Display' }),
        ).toBeVisible();

        await rightSidebar.getAdjustSection('Speed').click();
        await expect(rightSidebar.getAdjustSection('Speed')).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });

    test('Add transformation by dragging from the effects library', async ({
        editorWithClips,
    }) => {
        const { rightSidebar, timeline, transformationPanel, leftSidebar } =
            editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Transform');

        // The effects library lives in the left sidebar; a transform is added by
        // dragging its card onto the target clip rather than via an add-menu.
        await leftSidebar.switchTo('Effects');
        await expect(transformationPanel.libraryPanel).toBeVisible();

        await transformationPanel.addTransform(
            'BlurFilter',
            timeline.clips.first(),
        );

        await expect(
            transformationPanel.effectsPanel.getByRole('heading', { name: 'Blur' }),
        ).toBeVisible();
    });

});
