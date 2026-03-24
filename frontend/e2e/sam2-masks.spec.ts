import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installApiMock } from './mocks/apiMock';
import { EditorComponent } from './components';

async function setupSam2Editor(page: Page, options: Parameters<typeof installApiMock>[1] = {}) {
    await installApiMock(page, options);

    const editor = new EditorComponent(page);
    await editor.setup('project_v2_with_clips');
    await editor.timeline.clickClip(0);
    await editor.rightSidebar.switchToTab('Mask');

    return editor;
}

async function waitForSam2Preview(page: Page) {
    await page.waitForFunction(async () => {
        const [{ useMaskViewStore }, { useTimelineStore }] = await Promise.all([
            import('/src/features/masks/store/useMaskViewStore.ts'),
            import('/src/features/timeline/useTimelineStore.ts'),
        ]);

        const clipId = useTimelineStore.getState().selectedClipIds[0] ?? null;
        if (!clipId) return false;

        return Boolean(useMaskViewStore.getState().sam2LivePreviewByClipId[clipId]);
    });
}

async function addSam2PointAtCurrentFrame(page: Page) {
    await page.evaluate(async () => {
        const [{ useTimelineStore }, { useMaskViewStore }] = await Promise.all([
            import('/src/features/timeline/useTimelineStore.ts'),
            import('/src/features/masks/store/useMaskViewStore.ts'),
        ]);

        const clipId = useTimelineStore.getState().selectedClipIds[0] ?? null;
        if (!clipId) {
            throw new Error('No selected clip for SAM2 point insertion');
        }

        const maskId = useMaskViewStore.getState().selectedMaskByClipId[clipId] ?? null;
        if (!maskId) {
            throw new Error('No selected SAM2 mask for point insertion');
        }

        useTimelineStore.getState().updateClipMask(clipId, maskId, {
            maskPoints: [
                {
                    x: 0.5,
                    y: 0.5,
                    label: 1,
                    timeTicks: 0,
                },
            ],
        });
    });
}

test.describe('SAM2 Mask Flow', () => {
    test('SAM2 mask option available when SAM2 healthy', async ({ page }) => {
        const editor = await setupSam2Editor(page, {
            runtimeStatus: {
                sam2: { status: 'available', error: null },
            },
            sam2Health: { status: 'ok' },
        });

        await editor.maskPanel.addMaskChip.click();

        const sam2Option = page.getByRole('menuitem', { name: 'Sam2' });
        await expect(sam2Option).toBeVisible();
        await expect(sam2Option).toBeEnabled();
    });

    test('SAM2 panel shows point tools', async ({ page }) => {
        const editor = await setupSam2Editor(page, {
            runtimeStatus: {
                sam2: { status: 'available', error: null },
            },
            sam2Health: { status: 'ok' },
        });

        await editor.maskPanel.addMask('Sam2');

        await expect(editor.maskPanel.sam2Panel).toBeVisible();
        await expect(editor.maskPanel.sam2AddPointButton).toBeVisible();
        await expect(editor.maskPanel.sam2RemovePointButton).toBeVisible();
        await expect(editor.maskPanel.sam2GenerateButton).toBeVisible();
    });

    test('Generate mask frame preview', async ({ page }) => {
        const editor = await setupSam2Editor(page, {
            runtimeStatus: {
                sam2: { status: 'available', error: null },
            },
            sam2Health: { status: 'ok' },
        });

        await editor.maskPanel.addMask('Sam2');
        await editor.maskPanel.sam2AddPointButton.click();

        await addSam2PointAtCurrentFrame(page);
        await expect(editor.maskPanel.panel.getByText(/Current frame: 1 point/)).toBeVisible();

        await editor.maskPanel.sam2PreviewButton.click();
        await waitForSam2Preview(page);
    });

    test('SAM2 unavailable shows disabled state', async ({ page }) => {
        const editor = await setupSam2Editor(page, {
            runtimeStatus: {
                sam2: { status: 'unavailable', error: 'SAM2 offline for test' },
            },
            sam2Health: { status: 'error' },
        });

        await editor.maskPanel.addMaskChip.click();

        const sam2Option = page.getByRole('menuitem', { name: 'Sam2' });
        await expect(sam2Option).toBeVisible();
        await expect(sam2Option).toBeDisabled();
    });
});
