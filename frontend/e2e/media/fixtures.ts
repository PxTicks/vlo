import type { Page } from '@playwright/test';
import { expect, test as base } from '../fixtures';
import {
    assertMediaCapabilities,
    describeMediaBackend,
    probeMediaCapabilities,
    type MediaCapabilityReport,
} from './mediaCapabilities';

/**
 * Fixtures for the browser-media lane (plan §4.6).
 *
 * Everything the base `e2e/fixtures.ts` provides is inherited; the addition is
 * an auto capability gate that runs before any media spec body and throws when
 * the browser cannot honour the claims these specs make. The backend summary is
 * attached to every run so a nightly failure carries the renderer/codec context
 * needed to triage it.
 */

const PROBE_PATH = '/__media-capability-probe';

/**
 * WebCodecs is only exposed in a secure context, and `about:blank` — where the
 * page sits before the editor fixture navigates — is not one. Probing there
 * reports `VideoDecoder: undefined` on a perfectly capable browser.
 *
 * So the probe gets a throwaway document on the app's own origin (loopback
 * counts as potentially trustworthy), which is also the origin the specs
 * themselves run in. The route is removed immediately afterwards so it cannot
 * shadow anything the editor fixture installs.
 */
async function openProbeOrigin(page: Page): Promise<void> {
    await page.route(`**${PROBE_PATH}`, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!doctype html><meta charset="utf-8"><title>media capability probe</title>',
        }),
    );
    try {
        await page.goto(PROBE_PATH);
    } finally {
        await page.unroute(`**${PROBE_PATH}`);
    }
}

export const test = base.extend<{
    mediaCapabilities: MediaCapabilityReport;
}>({
    mediaCapabilities: [
        async ({ page }, runFixture, testInfo) => {
            await openProbeOrigin(page);
            const report = await probeMediaCapabilities(page);
            await testInfo.attach('media-backend.txt', {
                body: describeMediaBackend(report),
                contentType: 'text/plain',
            });
            assertMediaCapabilities(report);
            await runFixture(report);
        },
        { auto: true },
    ],
});

export { expect };
