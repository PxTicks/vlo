import { Page, Locator } from '@playwright/test';

/**
 * Component Object Model for the Project Manager landing screen.
 * Wraps: ProjectManager.tsx
 */
export class ProjectManagerComponent {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    get newProjectButton() {
        return this.page.getByRole('button', { name: 'New project' });
    }

    get openProjectButton() {
        return this.page.getByRole('button', { name: 'Open project' });
    }

    async clickNewProject() {
        await this.newProjectButton.click();
    }

    async clickOpenProject() {
        await this.openProjectButton.click();
    }
}
