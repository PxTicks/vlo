import { test, expect } from './fixtures';

interface PersistedManifest {
    title: string;
    config: {
        fps?: number;
    };
}

interface PersistedTimeline {
    clips: Array<{
        id: string;
        type: string;
        depth?: number | 'all';
        retimingMode?: string;
        transformations: Array<{
            type: string;
            effectMask?: {
                enabled: boolean;
                expression: unknown;
            };
        }>;
    }>;
}

test.describe('Critical editor journeys', () => {
    test('@smoke current project persists editor changes across reopen', async ({
        editorWithClips,
    }) => {
        const { page, timeline, fileSystem } = editorWithClips;

        const title = page.getByTestId('project-title-display');
        await title.click();
        const titleInput = page.getByTestId('project-title-input').locator('input');
        await titleInput.fill('Persisted E2E Project');
        await titleInput.press('Enter');

        await page.getByTestId('project-settings-button').click();
        await page.getByRole('menuitem', { name: '24 fps' }).click();

        await timeline.addAdjustmentClip();
        await expect(timeline.clips).toHaveCount(3);

        await expect.poll(() => {
            const manifest = fileSystem.readJson<PersistedManifest>(
                '.vloproject/project.json',
            );
            return { title: manifest.title, fps: manifest.config.fps };
        }).toEqual({ title: 'Persisted E2E Project', fps: 24 });

        await expect.poll(() => {
            const persisted = fileSystem.readJson<PersistedTimeline>(
                '.vloproject/timeline.json',
            );
            return persisted.clips.filter((clip) => clip.type === 'adjustment').length;
        }).toBe(1);

        await editorWithClips.reopenProject();
        await expect(page.getByTestId('project-title-display')).toHaveText(
            'Persisted E2E Project',
        );
        await expect(timeline.clips).toHaveCount(3);
    });

    test('@smoke legacy project is backed up and migrated to split documents', async ({
        legacyEditor,
    }) => {
        const { fileSystem } = legacyEditor;

        await expect.poll(() =>
            fileSystem.exists('.vloproject/project.legacy-v2.json'),
        ).toBe(true);

        for (const filePath of [
            '.vloproject/project.json',
            '.vloproject/timeline.json',
            '.vloproject/assets.json',
            '.vloproject/composites.json',
        ]) {
            expect(fileSystem.exists(filePath), `${filePath} should exist`).toBe(true);
        }

        const manifest = fileSystem.readJson<{
            documentType: string;
            schemaVersion: number;
        }>('.vloproject/project.json');
        expect(manifest).toMatchObject({
            documentType: 'vlo.project',
            schemaVersion: 3,
        });

        await expect(legacyEditor.timeline.clips).toHaveCount(2);
    });

    test('@smoke adjustment clip exposes only supported controls and persists policy', async ({
        editorWithClips,
    }) => {
        const {
            timeline,
            rightSidebar,
            transformationPanel,
            fileSystem,
            page,
        } = editorWithClips;

        await timeline.addAdjustmentClip();
        await timeline.clickClip((await timeline.clips.count()) - 1);
        await expect(rightSidebar.getTab('Transform')).toBeVisible();
        await expect(rightSidebar.getTab('Mask')).toHaveCount(0);
        await expect(transformationPanel.adjustmentDepthSection).toBeVisible();

        await page.getByLabel('Ripple timeline timing').click();
        await page.getByLabel('All tracks below').click();

        await expect.poll(() => {
            const persisted = fileSystem.readJson<PersistedTimeline>(
                '.vloproject/timeline.json',
            );
            const adjustment = persisted.clips.find(
                (clip) => clip.type === 'adjustment',
            );
            return {
                depth: adjustment?.depth,
                retimingMode: adjustment?.retimingMode,
            };
        }).toEqual({ depth: 3, retimingMode: 'ripple' });
    });

    test('filter can be scoped to a clip mask and the effect mask persists', async ({
        editorWithClips,
    }) => {
        const {
            timeline,
            rightSidebar,
            maskPanel,
            transformationPanel,
            fileSystem,
        } = editorWithClips;

        await timeline.clickClip(0);
        await rightSidebar.switchToTab('Mask');
        await maskPanel.addMask('Rectangle');
        await maskPanel.backButton.click();

        await rightSidebar.switchToTab('Transform');
        await transformationPanel.addTransform('Blur');
        await expect(transformationPanel.effectMaskButtons.first()).toBeVisible();
        await transformationPanel.effectMaskButtons.first().click();
        await expect(transformationPanel.effectMaskDialog).toBeVisible();

        const maskChip = transformationPanel.effectMaskDialog.getByTestId(
            /^mask-variable-chip-/,
        ).first();
        await maskChip.dragTo(
            transformationPanel.effectMaskDialog.getByTestId('mask-equation'),
        );
        await transformationPanel.effectMaskDialog
            .getByTestId('mask-equation-enabled')
            .click();
        await transformationPanel.effectMaskDialog
            .getByTestId('effect-mask-dialog-close')
            .click();

        await expect.poll(() => {
            const persisted = fileSystem.readJson<PersistedTimeline>(
                '.vloproject/timeline.json',
            );
            const maskedTransform = persisted.clips[0]?.transformations.find(
                (transform) => transform.effectMask,
            );
            return Boolean(
                maskedTransform?.effectMask?.enabled &&
                maskedTransform.effectMask.expression,
            );
        }).toBe(true);
    });

});
