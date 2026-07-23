import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { installApiMock } from './mocks/apiMock';
import { installWebSocketMock } from './mocks/websocketMock';

const EXTENSION_ID = 'example.e2e-boundary';
const EXTENSION_DIGEST = 'e2e-boundary-digest';
const FRONTEND_ENTRY =
    `/app/extensions/${EXTENSION_ID}/frontend/${EXTENSION_DIGEST}/index.js`;

const EXTENSION_MODULE = `
export const activate = (context) => {
  const React = context.api.runtime.react;
  const readCount = async () => {
    const value = await context.api.storage.project?.get("dispatch-count");
    return typeof value === "number" ? value : 0;
  };

  context.api.ui.commands.register({
    id: "record-dispatch",
    apiVersion: 1,
    title: "Record extension dispatch",
    when: { key: "project.open" },
    run: async () => {
      const storage = context.api.storage.project;
      if (!storage) throw new Error("Project storage unavailable");
      await storage.set("dispatch-count", (await readCount()) + 1);
    },
  });
  context.api.ui.menus.addItem({
    id: "record-library-dispatch",
    apiVersion: 1,
    menuId: "library.item.actions",
    kind: "command",
    command: "record-dispatch",
    group: "9_extensions",
  });

  function BoundaryView() {
    const [count, setCount] = React.useState(0);
    React.useEffect(() => {
      let active = true;
      const refresh = async () => {
        const next = await readCount();
        if (active) setCount(next);
      };
      void refresh();
      const unsubscribe = context.api.storage.project?.subscribe(() => {
        void refresh();
      });
      return () => {
        active = false;
        unsubscribe?.();
      };
    }, []);
    return React.createElement(
      "section",
      { "data-testid": "e2e-extension-view" },
      React.createElement("h2", null, "E2E Boundary"),
      React.createElement("p", null, "Dispatch count: " + count),
    );
  }

  context.api.ui.registerView({
    id: "boundary-view",
    apiVersion: 1,
    kind: "trusted-view",
    title: "E2E Boundary",
    defaultRegion: "right-sidebar",
    component: BoundaryView,
  });
};
`;

type InventoryStatus = 'pending_approval' | 'approved' | 'disabled';

function inventoryItem(
    status: InventoryStatus,
    sdk = '>=1.7.0 <2.0.0',
): Record<string, unknown> {
    return {
        id: EXTENSION_ID,
        sourcePath: `/extensions/${EXTENSION_ID}`,
        status,
        digest: EXTENSION_DIGEST,
        errors: [],
        manifest: {
            manifestVersion: 1,
            id: EXTENSION_ID,
            name: 'E2E Boundary Fixture',
            version: '1.0.0',
            sdk,
            frontend: { entry: 'frontend/dist/index.js' },
            capabilities: ['ui.custom'],
        },
        approval:
            status === 'pending_approval'
                ? null
                : {
                      digest: EXTENSION_DIGEST,
                      version: '1.0.0',
                      approvedAt: 1,
                      enabled: status === 'approved',
                  },
        backendRuntime: {
            status: 'not_declared',
            message: 'No backend entry point.',
            digest: null,
        },
        preflight: null,
        frontendEntryUrl: FRONTEND_ENTRY,
        lutContributions: [],
    };
}

async function installStatefulExtensionMock(
    page: Page,
    initialStatus: InventoryStatus,
) {
    let status = initialStatus;
    await installWebSocketMock(page);
    await installApiMock(page);

    await page.route('**/app/extensions', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ extensions: [inventoryItem(status)] }),
        });
    });
    await page.route(`**/app/extensions/${EXTENSION_ID}/approve`, async (route) => {
        status = 'approved';
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ extension: inventoryItem(status) }),
        });
    });
    await page.route(`**/app/extensions/${EXTENSION_ID}/decline`, async (route) => {
        status = 'disabled';
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ extension: inventoryItem(status) }),
        });
    });
    await page.route(
        `**/app/extensions/${EXTENSION_ID}/approval`,
        async (route) => {
            status = 'pending_approval';
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ extension: inventoryItem(status) }),
            });
        },
    );
    // Register this broad content route last. Playwright evaluates routes in
    // reverse registration order, and the extension inventory route otherwise
    // owns the shared `/app/extensions` prefix before dynamic import sees it.
    await page.route('**/app/extensions/**', async (route) => {
        if (new URL(route.request().url()).pathname !== FRONTEND_ENTRY) {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'text/javascript',
            body: EXTENSION_MODULE,
        });
    });
}

/** Clears the project-menu trust prompt by allowing, then restarting. */
async function allowAtProjectMenu(page: Page) {
    await expect(
        page.getByRole('heading', { name: 'A new extension was found' }),
    ).toBeVisible();
    await page.getByTestId('extension-approval-gate-allow').click();
    await expect(
        page.getByRole('heading', { name: 'Restart to finish' }),
    ).toBeVisible();
    await page.getByTestId('extension-approval-gate-reload').click();
    await expect(
        page.getByTestId('extension-approval-gate'),
    ).toHaveCount(0);
}

/** Clears the same prompt by refusing; the refusal must then be remembered. */
async function blockAtProjectMenu(page: Page) {
    await page.getByTestId('extension-approval-gate-block').click();
    await expect(
        page.getByTestId('extension-approval-gate'),
    ).toHaveCount(0);
}

async function openExtensionManager(page: Page) {
    await page.getByTestId('project-settings-button').click();
    await page.getByTestId('project-settings-extensions').click();
    await expect(
        page.getByRole('dialog', { name: 'Extension manager' }),
    ).toBeVisible();
}

async function selectBoundaryView(page: Page) {
    await page.getByRole('button', { name: 'More panels' }).click();
    await page.getByRole('menuitem', { name: 'E2E Boundary' }).click();
    await expect(page.getByTestId('e2e-extension-view')).toBeVisible();
}

test.describe('Extension browser boundary', () => {
    test('approves, activates, dispatches, restores storage and revokes an extension', async ({
        editorNoSetup,
    }) => {
        test.setTimeout(120_000);
        const { page } = editorNoSetup;
        await installStatefulExtensionMock(page, 'pending_approval');
        // Trust is granted on the project menu, before the editor exists.
        await editorNoSetup.setup({
            fixtureDir: 'project_current',
            onProjectMenu: () => allowAtProjectMenu(page),
        });

        await openExtensionManager(page);
        await expect(page.getByText('Allowed', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Close' }).click();

        const reloadedInventory = page.waitForResponse(
            (response) =>
                response.request().method() === 'GET' &&
                new URL(response.url()).pathname.endsWith('/app/extensions'),
        );
        const reloadedModule = page.waitForResponse((response) =>
            new URL(response.url()).pathname.endsWith(FRONTEND_ENTRY),
        );
        await editorNoSetup.reopenProject();
        expect(
            (
                (await (await reloadedInventory).json()) as {
                    extensions: Array<{ status: string }>;
                }
            ).extensions[0]?.status,
        ).toBe('approved');
        expect((await reloadedModule).status()).toBe(200);
        // Extension activation is deliberately non-blocking for application
        // startup. Wait for its shell contribution rather than racing the
        // inventory import with the first menu interaction.
        await expect(
            page.getByRole('button', { name: 'More panels' }),
        ).toBeVisible();
        const firstAsset = editorNoSetup.assetBrowser.assetCards.first();
        await firstAsset.hover();
        await firstAsset
            .getByRole('button', { name: 'Asset actions' })
            .click();
        await expect(page.getByRole('menu')).toBeVisible();
        const storageSaved = page.waitForResponse(
            (response) =>
                response.request().method() === 'PUT' &&
                new URL(response.url()).pathname.endsWith(
                    '/__mock-fs/.vloproject/extension-storage.json',
                ),
        );
        await page
            .getByRole('menuitem', { name: 'Record extension dispatch' })
            .click();
        await storageSaved;

        await selectBoundaryView(page);
        await expect(page.getByText('Dispatch count: 1')).toBeVisible();

        await editorNoSetup.reopenProject();
        await selectBoundaryView(page);
        await expect(page.getByText('Dispatch count: 1')).toBeVisible();

        await openExtensionManager(page);
        await page.getByRole('button', { name: 'Forget my answer' }).click();
        await expect(
            page.getByText('Not allowed yet', { exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Close' }).click();

        // Forgetting the answer makes it ask again, and refusing it there is
        // what keeps the extension out of the editor.
        await editorNoSetup.reopenProject({
            onProjectMenu: () => blockAtProjectMenu(page),
        });
        await expect(
            page.getByRole('button', { name: 'More panels' }),
        ).toHaveCount(0);

        // The refusal sticks: no prompt on the next launch.
        await editorNoSetup.reopenProject();
        await expect(
            page.getByTestId('extension-approval-gate'),
        ).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: 'More panels' }),
        ).toHaveCount(0);
    });

    test('shows an incompatible package as a visible activation blocker', async ({
        editorNoSetup,
    }) => {
        const { page } = editorNoSetup;
        await installWebSocketMock(page);
        await installApiMock(page, {
            extensionInventory: [inventoryItem('pending_approval', '>=99.0.0')],
        });
        await editorNoSetup.setup({ fixtureDir: 'project_current' });

        // A package that cannot run here is never worth prompting about.
        await expect(
            page.getByTestId('extension-approval-gate'),
        ).toHaveCount(0);

        await openExtensionManager(page);
        await expect(
            page.getByText(/built for a different version of vlo/i),
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Allow' }),
        ).toHaveCount(0);
    });
});
