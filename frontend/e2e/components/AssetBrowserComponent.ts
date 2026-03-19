import { Page, Locator } from '@playwright/test';

type AssetTab = 'video' | 'image' | 'audio';

/**
 * Component Object Model for the Asset Browser (left sidebar).
 * Wraps: AssetBrowser.tsx + AssetCard.tsx
 */
export class AssetBrowserComponent {
    readonly page: Page;
    readonly root: Locator;

    constructor(page: Page) {
        this.page = page;
        this.root = page.getByTestId('asset-browser');
    }

    get assetCards() {
        return this.page.getByTestId('asset-card');
    }

    get sortButton() {
        return this.root.getByRole('button', { name: 'Sort Assets' });
    }

    get uploadButton() {
        return this.root.getByRole('button', { name: 'Import Asset' });
    }

    get fileInput() {
        return this.page.getByTestId('hidden-file-input');
    }

    /**
     * Switch to a tab by aria-label: "Videos", "Images", or "Audio".
     */
    async switchTab(type: AssetTab) {
        const labelMap: Record<AssetTab, string> = {
            video: 'Videos',
            image: 'Images',
            audio: 'Audio',
        };
        await this.root.getByRole('tab', { name: labelMap[type] }).click();
    }

    async getAssetByName(name: string): Promise<Locator> {
        return this.assetCards.filter({ hasText: name }).first();
    }

    async getVisibleCardCount(): Promise<number> {
        return this.assetCards.count();
    }

    async sortBy(option: 'Newest First' | 'Oldest First' | 'Name (A-Z)') {
        await this.sortButton.click();
        await this.page.getByRole('menuitem', { name: option }).click();
    }

    /**
     * Returns the text content of all visible asset card names, in display order.
     */
    async getCardNames(): Promise<string[]> {
        const nameLocators = this.root.getByTestId('asset-card-name');
        const count = await nameLocators.count();
        const names: string[] = [];
        for (let i = 0; i < count; i++) {
            const text = await nameLocators.nth(i).innerText();
            names.push(text.trim());
        }
        return names;
    }
}
