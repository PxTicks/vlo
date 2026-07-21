import type { Locator, Page } from '@playwright/test';

/**
 * Component Object Model for the shell's menu surfaces.
 *
 * Host menus are declared in `core/shell/hostMenus.ts` and rendered through
 * `AppMenu` / the imperative context-menu service. Context menus carry no test
 * ID — they are MUI menus addressed by ARIA role — so this COM centralises the
 * role queries rather than scattering them through specs.
 */
export class ShellComponent {
    constructor(readonly page: Page) {}

    /** The open menu surface, if any. */
    get menu(): Locator {
        return this.page.getByRole('menu');
    }

    get menuItems(): Locator {
        return this.page.getByRole('menuitem');
    }

    getItem(name: string): Locator {
        return this.page.getByRole('menuitem', { name, exact: true });
    }

    async isOpen(): Promise<boolean> {
        return (await this.menu.count()) > 0;
    }

    async itemLabels(): Promise<string[]> {
        return this.menuItems.allInnerTexts();
    }

    /** Right-clicks `target` and waits for the resulting menu to render. */
    async openContextMenu(target: Locator): Promise<void> {
        await target.click({ button: 'right' });
        await this.menu.first().waitFor({ state: 'visible' });
    }

    async closeWithEscape(): Promise<void> {
        await this.page.keyboard.press('Escape');
        await this.menu.first().waitFor({ state: 'detached' });
    }

    /** Dismisses by clicking well away from the menu surface. */
    async closeWithOutsideClick(): Promise<void> {
        await this.page.mouse.click(5, 5);
        await this.menu.first().waitFor({ state: 'detached' });
    }
}
