import { Page, Locator } from '@playwright/test';

/**
 * Component Object Model for the Generation Panel.
 * Wraps: GenerationPanel.tsx
 *
 * Note: Requires data-testid attributes to be added to GenerationPanel.tsx in Phase 11.
 * For now, uses role-based and text-based locators where possible.
 */
export class GenerationPanelComponent {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    get generateButton() {
        return this.page.getByRole('button', { name: /Generate|Cancel/ });
    }

    async clickGenerate() {
        await this.page.getByRole('button', { name: 'Generate' }).click();
    }

    async clickCancel() {
        await this.page.getByRole('button', { name: 'Cancel' }).click();
    }
}
