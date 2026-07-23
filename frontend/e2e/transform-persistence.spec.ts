import { timelineDocumentSchema } from '../src/features/project/schemas/projectPersistenceSchemas';
import { expect, test } from './fixtures';

/**
 * Phase 4.3 — transformation persistence.
 *
 * The current fixture's `clip_ccf0…` carries both a speed transform and a
 * color-grade filter. This edits one scalar of each through the real panels
 * (Adjust → Speed → Factor, Adjust → Color → Exposure), then proves the change
 * survives a project reopen — both in the on-disk timeline document and in the
 * reopened UI, so neither the save path nor the read-back path can regress
 * silently.
 */

const CCF0 = 'clip_ccf0d014-2442-4ad9-af61-41ee24a516a1';
const PROJECT_DIRECTORY = '.vloproject';
const TIMELINE_PATH = `${PROJECT_DIRECTORY}/timeline.json`;

const NEW_SPEED_FACTOR = 1.75;
const NEW_EXPOSURE = 0.5;

/** Set a labelled SliderControl's numeric input and commit it. */
async function setAdjustValue(
    editor: import('./components').EditorComponent,
    name: string,
    value: number,
) {
    const input = editor.transformationPanel.adjustPanel.getByRole('spinbutton', {
        name,
        exact: true,
    });
    await input.fill(String(value));
    await input.press('Enter');
}

async function readAdjustValue(
    editor: import('./components').EditorComponent,
    name: string,
): Promise<number> {
    const input = editor.transformationPanel.adjustPanel.getByRole('spinbutton', {
        name,
        exact: true,
    });
    return Number(await input.inputValue());
}

/** The committed scalar for a given transform type on the target clip. */
function readPersistedScalar(
    editor: import('./components').EditorComponent,
    transformType: 'speed' | 'filter',
    read: (parameters: Record<string, unknown>) => number,
): number {
    const timeline = timelineDocumentSchema.parse(
        editor.fileSystem.readJson(TIMELINE_PATH),
    );
    const clip = timeline.clips.find((candidate) => candidate.id === CCF0);
    if (!clip) throw new Error(`clip ${CCF0} not found in persisted timeline`);
    const transform = (clip.transformations ?? []).find(
        (candidate) => candidate.type === transformType,
    );
    if (!transform) {
        throw new Error(`clip ${CCF0} has no ${transformType} transform`);
    }
    return read(transform.parameters as Record<string, unknown>);
}

test.describe('Transformation persistence', () => {
    test('speed factor and color-grade exposure survive reopen', async ({
        editorCurrent,
    }) => {
        const editor = editorCurrent;
        const { page, rightSidebar } = editor;

        await editor.timeline.clickClipById(CCF0);

        // --- edit speed factor -----------------------------------------
        await rightSidebar.switchToAdjustSection('Speed');
        const timelineSavedAfterSpeed = page.waitForResponse(
            (response) =>
                response.request().method() === 'PUT' &&
                new URL(response.url()).pathname.endsWith(
                    `/__mock-fs/${TIMELINE_PATH}`,
                ) &&
                response.status() === 204,
        );
        await setAdjustValue(editor, 'Factor', NEW_SPEED_FACTOR);
        await timelineSavedAfterSpeed;

        // --- edit color-grade exposure ---------------------------------
        await rightSidebar.switchToAdjustSection('Color');
        const timelineSavedAfterExposure = page.waitForResponse(
            (response) =>
                response.request().method() === 'PUT' &&
                new URL(response.url()).pathname.endsWith(
                    `/__mock-fs/${TIMELINE_PATH}`,
                ) &&
                response.status() === 204,
        );
        await setAdjustValue(editor, 'Exposure', NEW_EXPOSURE);
        await timelineSavedAfterExposure;

        // --- on-disk model reflects both edits -------------------------
        await expect
            .poll(() =>
                readPersistedScalar(editor, 'filter', (p) => Number(p.exposure)),
            )
            .toBe(NEW_EXPOSURE);
        const persistedSpeed = readPersistedScalar(editor, 'speed', (p) => {
            const factor = p.factor as
                | number
                | { points?: Array<{ value: number }> };
            // The fixture's speed is a spline; editing Factor sets the scalar
            // the UI exposes. Accept either the scalar or the leading spline
            // point so the assertion tracks the value the user typed.
            if (typeof factor === 'number') return factor;
            return factor.points?.[0]?.value ?? NaN;
        });
        expect(persistedSpeed).toBe(NEW_SPEED_FACTOR);

        // --- reopen and confirm the UI reads the edited values back ----
        await editor.reopenProject();
        await editor.timeline.clickClipById(CCF0);

        await rightSidebar.switchToAdjustSection('Speed');
        expect(await readAdjustValue(editor, 'Factor')).toBe(NEW_SPEED_FACTOR);

        await rightSidebar.switchToAdjustSection('Color');
        expect(await readAdjustValue(editor, 'Exposure')).toBe(NEW_EXPOSURE);
    });
});
