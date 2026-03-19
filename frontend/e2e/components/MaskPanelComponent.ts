import { Page, Locator } from '@playwright/test';

type MaskType = 'Circle' | 'Rectangle' | 'Triangle' | 'SAM2' | 'Generation';
type MaskMode = 'Apply' | 'Preview' | 'Off';

/**
 * Component Object Model for the Mask Panel.
 * Wraps: MaskPanel.tsx
 *
 * Note: Requires data-testid attributes to be added to MaskPanel.tsx in Phase 9.
 * For now, uses role-based and text-based locators where possible.
 */
export class MaskPanelComponent {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    get addMaskChip() {
        return this.page.getByText('Add mask');
    }

    async addMask(type: MaskType) {
        await this.addMaskChip.click();
        await this.page.getByRole('menuitem', { name: type }).click();
    }

    async setMode(mode: MaskMode) {
        await this.page.getByRole('button', { name: mode }).click();
    }

    async deleteMask() {
        await this.page.getByRole('button', { name: 'Delete Mask' }).click();
    }
}
