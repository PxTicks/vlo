import { Page, Locator } from '@playwright/test';

/**
 * Component Object Model for the Generation Panel.
 * Wraps: GenerationPanel.tsx
 */
export class GenerationPanelComponent {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    get panel() {
        return this.page.getByTestId('generation-panel');
    }

    get connectionChip() {
        return this.page.getByTestId('generation-connection-chip');
    }

    get workflowSelect() {
        return this.page.getByTestId('generation-workflow-select');
    }

    get generateButton() {
        return this.page.getByTestId('generation-generate-button');
    }

    get progressBar() {
        return this.page.getByTestId('generation-progress-bar');
    }

    get sendToTimelineButton() {
        return this.page.getByTestId('generation-send-to-timeline-button');
    }

    async clickGenerate() {
        await this.generateButton.click();
    }

    async clickCancel() {
        await this.generateButton.click();
    }

    async selectWorkflow(name: string) {
        await this.workflowSelect.click();
        await this.page.getByRole('option', { name }).click();
    }
}
