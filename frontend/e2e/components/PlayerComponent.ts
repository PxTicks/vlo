import { Page, Locator } from '@playwright/test';

/**
 * Component Object Model for the Player and PlayerControls.
 * Wraps: Player.tsx + PlayerControls.tsx
 */
export class PlayerComponent {
    readonly page: Page;
    readonly canvasContainer: Locator;
    readonly controls: Locator;

    constructor(page: Page) {
        this.page = page;
        this.canvasContainer = page.getByTestId('player-canvas-container');
        this.controls = page.getByTestId('player-controls');
    }

    get playButton() {
        return this.controls.getByRole('button', { name: 'Play' });
    }

    get pauseButton() {
        return this.controls.getByRole('button', { name: 'Pause' });
    }

    get fitToScreenButton() {
        return this.controls.getByRole('button', { name: 'Fit to Screen' });
    }

    get fullscreenButton() {
        return this.controls.getByRole('button', { name: 'Enter Fullscreen' });
    }

    get exitFullscreenButton() {
        return this.controls.getByRole('button', { name: 'Exit Fullscreen' });
    }

    get extractButton() {
        return this.controls.getByRole('button', { name: 'Extract' });
    }

    async play() {
        await this.playButton.click();
    }

    async pause() {
        await this.pauseButton.click();
    }

    async isPlaying(): Promise<boolean> {
        return this.pauseButton.isVisible();
    }

    async fitToScreen() {
        await this.fitToScreenButton.click();
    }

    async clickFullscreen() {
        await this.fullscreenButton.click();
    }

    async clickExitFullscreen() {
        await this.exitFullscreenButton.click();
    }

    async openExtractDialog() {
        await this.extractButton.click();
    }
}
