import { Page, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { MockFileSystem } from '../mockFileSystem';
import { PlayerComponent } from './PlayerComponent';
import { TimelineComponent } from './TimelineComponent';
import { AssetBrowserComponent } from './AssetBrowserComponent';
import { RightSidebarComponent } from './RightSidebarComponent';
import { TransformationPanelComponent } from './TransformationPanelComponent';
import { MaskPanelComponent } from './MaskPanelComponent';
import { GenerationPanelComponent } from './GenerationPanelComponent';
import { ProjectManagerComponent } from './ProjectManagerComponent';
import { LeftSidebarComponent } from './LeftSidebarComponent';
import { ShellComponent } from './ShellComponent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface EditorSetupOptions {
    fixtureDir?: string;
    projectFormat?: 'current' | 'legacy';
}

/**
 * Top-level Component Object Model for the VLO editor.
 * Provides access to all child COMs and handles project setup.
 */
export class EditorComponent {
    readonly page: Page;
    private mockFileSystem: MockFileSystem | null = null;

    readonly player: PlayerComponent;
    readonly timeline: TimelineComponent;
    readonly assetBrowser: AssetBrowserComponent;
    readonly rightSidebar: RightSidebarComponent;
    readonly transformationPanel: TransformationPanelComponent;
    readonly maskPanel: MaskPanelComponent;
    readonly generationPanel: GenerationPanelComponent;
    readonly projectManager: ProjectManagerComponent;
    readonly leftSidebar: LeftSidebarComponent;
    readonly shell: ShellComponent;

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
        this.leftSidebar = new LeftSidebarComponent(page);
        this.shell = new ShellComponent(page);
    }

    get fileSystem(): MockFileSystem {
        if (!this.mockFileSystem) {
            throw new Error('Editor mock filesystem has not been initialized');
        }
        return this.mockFileSystem;
    }

    /**
     * Set up a project from a fixture directory.
     * The fixture is loaded into an isolated, writable in-memory filesystem.
     *
     * @param fixtureDir - Name of the fixture directory under e2e/fixtures/ (default: 'project_v1')
     */
    async setup(options: string | EditorSetupOptions = {}) {
        const normalizedOptions =
            typeof options === 'string'
                ? { fixtureDir: options }
                : options;
        const fixtureDir = normalizedOptions.fixtureDir ?? 'project_v1';
        const fixtureRoot = path.join(__dirname, '..', 'fixtures', fixtureDir);
        this.mockFileSystem = new MockFileSystem(fixtureRoot, {
            rootName: 'Untitled_Project',
            projectFormat: normalizedOptions.projectFormat ?? 'current',
        });
        await this.mockFileSystem.install(this.page);

        await this.page.goto('/');
        await this.page.getByRole('button', { name: 'Open project' }).click();
        await this.waitUntilReady();
    }

    async reopenProject() {
        await this.page.reload();
        await this.page.getByRole('button', { name: 'Open project' }).click();
        await this.waitUntilReady();
    }

    private async waitUntilReady() {
        await expect(this.player.canvasContainer).toBeVisible({ timeout: 20000 });
        await expect(this.timeline.toolbar).toBeVisible({ timeout: 20000 });
        await expect(this.assetBrowser.assetCards.first()).toBeVisible({ timeout: 20000 });
    }
}
