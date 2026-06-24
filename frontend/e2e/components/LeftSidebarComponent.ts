import type { Locator, Page } from '@playwright/test';

type LeftSidebarTab = 'Assets' | 'Text' | 'Composite' | 'Effects';

const TAB_TEST_IDS: Record<LeftSidebarTab, string> = {
    Assets: 'left-sidebar-tab-assets',
    Text: 'left-sidebar-tab-text',
    Composite: 'left-sidebar-tab-composite',
    Effects: 'left-sidebar-tab-effects',
};

export class LeftSidebarComponent {
    constructor(readonly page: Page) {}

    getTab(name: LeftSidebarTab): Locator {
        return this.page.getByTestId(TAB_TEST_IDS[name]);
    }

    async switchTo(name: LeftSidebarTab) {
        await this.getTab(name).click();
    }

    get compositePanel() {
        return this.page.getByTestId('composite-panel');
    }

    get compositeCards() {
        return this.page.getByTestId('composite-card');
    }

    get addBlankCompositeButton() {
        return this.page.getByTestId('composite-add-scene');
    }
}
