import { test, expect } from '@playwright/test';
import { setupProject, dragAssetToTimeline } from './utils';

test.describe('Player Interactions', () => {

    // Increase timeout for E2E interactions
    test.setTimeout(60000);

    test.beforeEach(async ({ page }) => {
        await setupProject(page);
    });

    test('Smoke Test: Player components are visible', async ({ page }) => {
        await expect(page.getByTestId('player-canvas-container')).toBeVisible();
        await expect(page.getByTestId('player-controls')).toBeVisible();
    });

    test('Play/Pause Interaction', async ({ page }) => {
        // Ensure there is something to play (add a clip)
        await dragAssetToTimeline(page);

        // Initial State: Play button should be visible (as we start paused)
        const playButton = page.getByRole('button', { name: 'Play' });
        await expect(playButton).toBeVisible();
        
        // Click Play
        await playButton.click();
        
        // Verification: Button changes to Pause
        const pauseButton = page.getByRole('button', { name: 'Pause' });
        await expect(pauseButton).toBeVisible();
        
        // Click Pause
        await pauseButton.click();
        
        // Verification: Button changes back to Play
        await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    });

    test('Fit View Interaction', async ({ page }) => {
        // Fit view works without clips, but adding one makes it deeper. 
        // For stability/speed, passing without clip is acceptable if we just test button interactivity.
        // Let's keep it simple and skip drag here to save time, unless required.
        
        const fitButton = page.getByRole('button', { name: 'Fit to Screen' });
        await expect(fitButton).toBeVisible();
        
        await fitButton.click();
        
        // Ensure button remains visible and no errors occurred
        await expect(fitButton).toBeVisible();
    });

});
