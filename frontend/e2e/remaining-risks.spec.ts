import { timelineDocumentSchema } from '../src/features/project/schemas/projectPersistenceSchemas';
import type { EditorComponent } from './components';
import { expect, test } from './fixtures';

const TIMELINE_PATH = '.vloproject/timeline.json';

function readTimeline(editor: EditorComponent) {
    return timelineDocumentSchema.parse(editor.fileSystem.readJson(TIMELINE_PATH));
}

function waitForTimelineSave(editor: EditorComponent) {
    return editor.page.waitForResponse(
        (response) =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname.endsWith(
                `/__mock-fs/${TIMELINE_PATH}`,
            ),
    );
}

/**
 * Phase 7 is risk-selected rather than one spec per feature. Color grading is
 * already represented by transform-persistence.spec.ts; this file adds the
 * uncovered text authoring boundary.
 */
test.describe('Remaining risk-selected journeys', () => {
    test('creates, styles and reopens a text clip', async ({ editorCurrent }) => {
        const editor = editorCurrent;
        const { page, timeline, leftSidebar } = editor;
        const initialClipIds = new Set(
            readTimeline(editor).clips.map((clip) => clip.id),
        );

        await timeline.seekToTick(1_200_000);
        await leftSidebar.switchTo('Text');
        const textPanel = page.getByTestId('text-panel');
        const content = textPanel.getByRole('textbox', { name: 'Content' });
        await content.fill('E2E title');

        const created = waitForTimelineSave(editor);
        await textPanel.getByRole('button', { name: 'Add Text Clip' }).click();
        await created;

        const textClip = readTimeline(editor).clips.find(
            (clip) => clip.type === 'text' && !initialClipIds.has(clip.id),
        );
        expect(textClip).toBeTruthy();
        await timeline.seekToTick(1_200_000);
        await timeline.getClipById(textClip!.id).click();
        await expect(
            textPanel.getByText('Selected Text Clip', { exact: true }),
        ).toBeVisible();

        await textPanel.getByRole('textbox', { name: 'Content' }).fill(
            'Reopened E2E title',
        );
        await textPanel.getByRole('spinbutton', { name: 'Size' }).fill('72');
        await textPanel.getByRole('spinbutton', { name: 'Size' }).press('Enter');
        await textPanel.getByRole('button', { name: 'Align right' }).click();
        await expect
            .poll(
                () =>
                    readTimeline(editor).clips.find(
                        (clip) => clip.id === textClip!.id,
                    )?.textData,
                { timeout: 15_000 },
            )
            .toMatchObject({
                content: 'Reopened E2E title',
                fontSize: 72,
                align: 'right',
            });

        await editor.reopenProject();
        await timeline.seekToTick(1_200_000);
        await timeline.getClipById(textClip!.id).click();
        await leftSidebar.switchTo('Text');
        await expect(
            textPanel.getByRole('textbox', { name: 'Content' }),
        ).toHaveText('Reopened E2E title');
        await expect(
            textPanel.getByRole('spinbutton', { name: 'Size' }),
        ).toHaveValue('72');
        await expect(
            textPanel.getByRole('button', { name: 'Align right' }),
        ).toHaveAttribute('aria-pressed', 'true');
    });
});
