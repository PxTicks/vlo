import { Page, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { installMockFileSystem } from '../mockFileSystem';
import { PlayerComponent } from './PlayerComponent';
import { TimelineComponent } from './TimelineComponent';
import { AssetBrowserComponent } from './AssetBrowserComponent';
import { RightSidebarComponent } from './RightSidebarComponent';
import { TransformationPanelComponent } from './TransformationPanelComponent';
import { MaskPanelComponent } from './MaskPanelComponent';
import { GenerationPanelComponent } from './GenerationPanelComponent';
import { ProjectManagerComponent } from './ProjectManagerComponent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Top-level Component Object Model for the VLO editor.
 * Provides access to all child COMs and handles project setup.
 */
export class EditorComponent {
    readonly page: Page;

    readonly player: PlayerComponent;
    readonly timeline: TimelineComponent;
    readonly assetBrowser: AssetBrowserComponent;
    readonly rightSidebar: RightSidebarComponent;
    readonly transformationPanel: TransformationPanelComponent;
    readonly maskPanel: MaskPanelComponent;
    readonly generationPanel: GenerationPanelComponent;
    readonly projectManager: ProjectManagerComponent;

    constructor(page: Page) {
        this.page = page;
        this.player = new PlayerComponent(page);
        this.timeline = new TimelineComponent(page);
        this.assetBrowser = new AssetBrowserComponent(page);
        this.rightSidebar = new RightSidebarComponent(page);
        this.transformationPanel = new TransformationPanelComponent(page);
        this.maskPanel = new MaskPanelComponent(page);
        this.generationPanel = new GenerationPanelComponent(page);
        this.projectManager = new ProjectManagerComponent(page);
    }

    /**
     * Set up a project from a fixture directory.
     * Installs the mock filesystem, intercepts network requests to serve fixture files,
     * navigates to the app, and opens the project.
     *
     * @param fixtureDir - Name of the fixture directory under e2e/fixtures/ (default: 'project_v1')
     */
    async setup(fixtureDir: string = 'project_v1') {
        // 1. Install Mock File System
        await installMockFileSystem(this.page, 'Untitled_Project');

        // 2. Setup Network Interception for Mock FS
        const fixtureRoot = path.join(__dirname, '..', 'fixtures', fixtureDir);

        await this.page.route('/__mock-fs/**', async (route) => {
            const url = new URL(route.request().url());
            const relativePath = decodeURIComponent(
                url.pathname.replace('/__mock-fs/', '')
            );
            const isDir = url.searchParams.get('dir') === 'true';
            const localPath = path.join(fixtureRoot, relativePath);

            if (!fs.existsSync(localPath)) {
                return route.fulfill({ status: 404, body: 'Not found' });
            }

            if (isDir) {
                if (!fs.statSync(localPath).isDirectory()) {
                    return route.fulfill({ status: 404, body: 'Not a directory' });
                }
                const entries = fs.readdirSync(localPath);
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify(entries),
                });
            } else {
                const body = fs.readFileSync(localPath);
                return route.fulfill({ status: 200, body });
            }
        });

        // 3. Navigate to App
        await this.page.goto('/');

        // 4. Open the project via the mock file picker
        await this.page.getByRole('button', { name: 'Open project' }).click();

        // 5. Wait for editor UI and seeded assets to load
        await expect(this.player.canvasContainer).toBeVisible({ timeout: 20000 });
        await expect(this.timeline.toolbar).toBeVisible({ timeout: 20000 });
        await expect(this.assetBrowser.assetCards.first()).toBeVisible({ timeout: 20000 });
    }
}
