import { test, expect } from './fixtures';
import { installApiMock } from './mocks/apiMock';
import { installWebSocketMock, simulateWsEvent, simulateGenerationComplete } from './mocks/websocketMock';

test.describe('Generation Panel', () => {

    test('@smoke Connection chip shows connected status', async ({ page }) => {
        // Install mocks before navigation
        await installWebSocketMock(page);
        await installApiMock(page, {
            runtimeStatus: { comfyui: { status: 'connected' } },
        });

        // Set up editor with default project
        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;
        await expect(generationPanel.connectionChip).toBeVisible();
        await expect(generationPanel.connectionChip).toHaveText('ComfyUI connected');
    });

    test('Connection chip shows disconnected status', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            runtimeStatus: { comfyui: { status: 'disconnected', error: null } },
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;
        await expect(generationPanel.connectionChip).toBeVisible();
        await expect(generationPanel.connectionChip).toHaveText('ComfyUI disconnected');
    });

    test('Workflow selector lists available workflows', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            workflowList: [
                { id: 'wf_a', name: 'Workflow Alpha' },
                { id: 'wf_b', name: 'Workflow Beta' },
                { id: 'wf_c', name: 'Workflow Charlie' },
            ],
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;
        await expect(generationPanel.workflowSelect).toBeVisible();

        // Open the select dropdown
        await generationPanel.workflowSelect.click();

        // Verify all three workflows are listed
        await expect(page.getByRole('option', { name: 'Workflow Alpha' })).toBeVisible();
        await expect(page.getByRole('option', { name: 'Workflow Beta' })).toBeVisible();
        await expect(page.getByRole('option', { name: 'Workflow Charlie' })).toBeVisible();
    });

    test('Generate button disabled without connected backend', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            runtimeStatus: { comfyui: { status: 'disconnected', error: null } },
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;
        await expect(generationPanel.generateButton).toBeVisible();
        await expect(generationPanel.generateButton).toBeDisabled();
    });

    test('Generate happy path with progress', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            promptResponse: {
                prompt_id: 'test-prompt-001',
                number: 1,
                node_errors: {},
            },
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;

        // Generate button should be enabled with connected backend + workflow
        await expect(generationPanel.generateButton).toBeVisible();
        await expect(generationPanel.generateButton).toHaveText('Generate');

        // Wait for workflow to load (button becomes enabled)
        await expect(generationPanel.generateButton).toBeEnabled({ timeout: 10000 });

        // Click generate
        await generationPanel.clickGenerate();

        // Running jobs expose a dedicated cancel control.
        await expect(generationPanel.cancelCurrentButton).toBeVisible();

        // Simulate progress events
        await simulateWsEvent(page, 'executing', {
            node: '3',
            prompt_id: 'test-prompt-001',
        });

        await simulateWsEvent(page, 'progress', {
            value: 50,
            max: 100,
            prompt_id: 'test-prompt-001',
            node: '3',
        });

        // Progress bar should appear
        await expect(generationPanel.progressBar).toBeVisible();

        // Complete generation
        await simulateGenerationComplete(page, 'test-prompt-001', '4', 'output_001.webp');
    });

    test('Cancel generation', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page);

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;

        // Wait for workflow to load so button is enabled
        await expect(generationPanel.generateButton).toBeEnabled({ timeout: 10000 });

        // Start generation
        await generationPanel.clickGenerate();

        await expect(generationPanel.cancelCurrentButton).toBeVisible();

        // Click cancel
        await generationPanel.clickCancel();

        await expect(generationPanel.cancelCurrentButton).toHaveCount(0);
        await expect(generationPanel.generateButton).toHaveText('Generate');
    });

});

test.describe('Workflow menu', () => {
    // The whole menu has to be on screen at once: the drag runs between a
    // workflow row at the bottom of the tree and a folder tile near the top.
    test.use({ viewport: { width: 1900, height: 1400 } });

    test('Drags a workflow into a folder tile', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            runtimeStatus: { comfyui: { status: 'connected' } },
            workflowList: [
                { id: 'vlo_SeedVR2_image.json', name: 'SeedVR2 image' },
                { id: 'unplaced_workflow.json', name: 'Unplaced workflow' },
            ],
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const menu = page.locator('[aria-label="Generation workflows"]');
        await menu.waitFor();
        await menu.getByRole('button', { name: 'Edit' }).first().click();

        // "Enhance" under Image: the folder that already holds SeedVR2 image.
        const tile = menu.getByRole('button', { name: 'Enhance', exact: true }).first();
        const handle = menu.getByRole('button', { name: 'Move Unplaced workflow' });
        await handle.scrollIntoViewIfNeeded();
        const from = (await handle.boundingBox())!;
        const to = (await tile.boundingBox())!;

        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
        // The drag overlay duplicates the label, which proves the drag is live.
        await expect(menu.getByText('Unplaced workflow')).toHaveCount(2);
        await page.mouse.up();

        // The workflow left the root list...
        await expect(
            menu.getByRole('button', { name: 'Unplaced workflow', exact: true }),
        ).toHaveCount(0);
        // ...and is inside the folder it was dropped on.
        await tile.click();
        await expect(
            menu.getByRole('button', { name: 'Unplaced workflow', exact: true }),
        ).toBeVisible();
    });
});
