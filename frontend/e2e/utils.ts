import { Page, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Define __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { installMockFileSystem } from './mockFileSystem';

export async function setupProject(page: Page) {
    // 1. Install Mock File System
    await installMockFileSystem(page, "Untitled_Project");

    // 2. Setup Network Interception for Mock FS
    // This handler serves files from the fixtures/project_v1 directory
    // mocking the "disk" access
    await page.route('/__mock-fs/**', async (route) => {
        const url = new URL(route.request().url());
        // Path after /__mock-fs/
        const relativePath = decodeURIComponent(
            url.pathname.replace('/__mock-fs/', '')
        );
        const isDir = url.searchParams.get('dir') === 'true';
        
        // Map to local fixture path
        // fixtures/project_v1 is our "root"
        const fixtureRoot = path.join(__dirname, 'fixtures', 'project_v1');
        const localPath = path.join(fixtureRoot, relativePath);

        if (!fs.existsSync(localPath)) {
            console.log(`[MockFS] 404 Not Found: ${relativePath} (Local: ${localPath})`);
            // Check if it's main project.json requests
            // .vloproject is sometimes hidden or handled differently, but here we expect flat mapping logic
            return route.fulfill({ status: 404, body: 'Not found' });
        }
        
        console.log(`[MockFS] Serving: ${relativePath}`);

        if (isDir) {
           if (!fs.statSync(localPath).isDirectory()) {
               return route.fulfill({ status: 404, body: 'Not a directory' });
           }
           const entries = fs.readdirSync(localPath);
           return route.fulfill({
               status: 200,
               contentType: 'application/json',
               body: JSON.stringify(entries)
           });
        } else {
            const body = fs.readFileSync(localPath);
            // Try to guess mime type? For now, generic or image/video if needed
            return route.fulfill({ status: 200, body });
        }
    });
    
    // 3. Navigate to App
    await page.goto('/');

    // 4. Perform "Open Project" Flow
    // Click "Open Project..."
    await page.getByRole('button', { name: 'Open Project...' }).click();
    
    // The web app calls window.showDirectoryPicker(), which our mock intercepts immediately and returns a handle.
    // The app then reads .vloproject/project.json (via fetched /__mock-fs/.vloproject/project.json)
    // And loads the project.

    // Wait for editor UI and seeded assets to load.
    await expect(page.getByTestId('player-canvas-container')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('timeline-toolbar')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('asset-card').first()).toBeVisible({ timeout: 20000 });
}

export async function dragAssetToTimeline(page: Page, assetName: string = "A_woman_in_202601222322_bssr2mp4") {
    // 1. Identify Source (Asset Card)
    // Note: Asset names in the fixture might need to match exactly what is rendered.
    // The fixture project.json has "name" properties.
    const assetCard = page.getByTestId('asset-card').filter({ hasText: assetName }).first();
    await expect(assetCard).toBeVisible({ timeout: 15000 });

    // 2. Identify Target (Timeline Track Body)
    const trackBody = page.getByTestId('timeline-body').first();
    await expect(trackBody).toBeVisible();

    const sourceBox = await assetCard.boundingBox();
    const targetBox = await trackBody.boundingBox();

    if (!sourceBox || !targetBox) throw new Error("Could not find elements");

    // 3. Perform Drag
    const sourceX = sourceBox.x + sourceBox.width / 2;
    const sourceY = sourceBox.y + sourceBox.height / 2;
    const targetX = targetBox.x + Math.min(180, targetBox.width / 2);
    const targetY = targetBox.y + targetBox.height / 2;

    // Hover source center and begin drag
    await page.mouse.move(sourceX, sourceY);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(sourceX + 20, sourceY + 20, { steps: 8 });
    
    // Move to target
    await page.mouse.move(targetX, targetY, { steps: 20 });
    await page.waitForTimeout(200);
    await page.mouse.up();

    // 4. Verify Clip Created
    await expect(page.locator('[data-testid="timeline-clip"]').first()).toBeVisible({ timeout: 10000 });
}
