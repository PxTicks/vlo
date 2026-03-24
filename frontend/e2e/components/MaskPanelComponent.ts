import { Page, Locator } from '@playwright/test';

type MaskType = 'Circle' | 'Rectangle' | 'Triangle' | 'Sam2';
type MaskMode = 'Apply' | 'Preview' | 'Off';

/**
 * Component Object Model for the Mask Panel.
 * Wraps: MaskPanel.tsx
 */
export class MaskPanelComponent {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    get panel() {
        return this.page.getByTestId('mask-panel');
    }

    get maskChips() {
        return this.page.getByTestId('mask-chip');
    }

    get addMaskChip() {
        return this.page.getByTestId('mask-add-chip');
    }

    get addMenu() {
        return this.page.getByTestId('mask-add-menu');
    }

    get sam2Panel() {
        return this.page.getByTestId('sam2-mask-panel');
    }

    get sam2AddPointButton() {
        return this.page.getByTestId('sam2-add-point-button');
    }

    get sam2RemovePointButton() {
        return this.page.getByTestId('sam2-remove-point-button');
    }

    get sam2GenerateButton() {
        return this.page.getByTestId('sam2-generate-button');
    }

    get sam2PreviewButton() {
        return this.page.getByRole('button', { name: 'Generate Current Frame Preview' });
    }

    get deleteButton() {
        return this.page.getByTestId('mask-delete-button');
    }

    getModeButton(mode: 'apply' | 'preview' | 'off') {
        return this.page.getByTestId(`mask-mode-${mode}`);
    }

    getInversionButton(value: 'normal' | 'inverted') {
        return this.page.getByTestId(`mask-inversion-${value}`);
    }

    async addMask(type: MaskType) {
        await this.addMaskChip.click();
        await this.page.getByRole('menuitem', { name: type }).click();
    }

    async setMode(mode: MaskMode) {
        await this.getModeButton(mode.toLowerCase() as 'apply' | 'preview' | 'off').click();
    }

    async setInversion(value: 'Normal' | 'Inverted') {
        await this.getInversionButton(value.toLowerCase() as 'normal' | 'inverted').click();
    }

    async deleteMask() {
        await this.deleteButton.click();
    }
}
