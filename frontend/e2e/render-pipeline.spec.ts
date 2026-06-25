import path from 'path';
// Base test (no diagnostics console-error gate): inducing a stuck source read
// legitimately makes the renderer log a "missing-renderer" strict-frame error
// on the healthy code path, which the shared fixture would (correctly) reject.
import { test, expect, type Route } from '@playwright/test';
import { MockFileSystem } from './mockFileSystem';
import { installApiMock } from './mocks/apiMock';
import { installWebSocketMock } from './mocks/websocketMock';

// clip_001's video source inside project_v2_with_clips. The filename has no
// extension on disk (".mp4" was folded into the name). Its thumbnail is a
// different file (…bssr2mp4_thumb.jpg), so an exact-suffix match only stalls
// the clip's source read, not its thumbnail.
const STUCK_VIDEO_SOURCE = 'A_woman_in_202601222322_bssr2mp4';

test.describe('Live render pipeline resilience', () => {
  /**
   * Regression guard for the render freeze introduced when the frame-planning
   * executor awaited *all* per-clip source prepares (incl. async asset
   * hydration) before decoding. A single slow/stuck filesystem read then froze
   * the entire pipeline: no frames committed, no `[vlo frame-plan]` diagnostics,
   * a blank editor — exactly the "one project renders nothing" failure.
   *
   * Here clip_001's source read hangs forever while clip_002 is healthy. The
   * live pipeline must keep producing frames (it must not block on per-clip
   * hydration), which we observe via the debug-mode frame-plan diagnostics.
   *
   * Expected: FAILS on the buggy "await all prepares before decode" code (the
   * frame-plan log never appears); PASSES on the current code.
   */
  test('keeps committing frames when one clip source read hangs', async ({
    page,
  }) => {
    await installWebSocketMock(page);
    await installApiMock(page);

    const mockFs = new MockFileSystem(
      // Playwright runs from the frontend/ project root.
      path.join(process.cwd(), 'e2e', 'fixtures', 'project_v2_with_clips'),
      { rootName: 'Untitled_Project' },
    );
    await mockFs.install(page);

    // Registered after the mock filesystem route, so for this one URL it wins by
    // last-registered-first ordering. It never fulfils — simulating a stuck
    // read — and defers every other path back to the mock via route.fallback().
    let stuckReadAttempted = false;
    await page.route('**/__mock-fs/**', async (route: Route) => {
      const filePath = decodeURIComponent(new URL(route.request().url()).pathname);
      if (filePath.endsWith(STUCK_VIDEO_SOURCE)) {
        stuckReadAttempted = true;
        return; // never settle: the clip's source hydration hangs forever
      }
      await route.fallback();
    });

    // The frame planner publishes a throttled console summary per render batch,
    // but only while debug mode is on. Its appearance proves the pipeline
    // completed at least one frame after a clip's source got stuck.
    const framePlanLogged = page.waitForEvent('console', {
      predicate: (message) => message.text().includes('[vlo frame-plan]'),
      timeout: 25000,
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open project' }).click();
    await expect(page.getByTestId('player-canvas-container')).toBeVisible({
      timeout: 20000,
    });
    await expect(page.getByTestId('timeline-clip').first()).toBeVisible({
      timeout: 20000,
    });

    // Enable debug mode so the frame planner emits its per-frame diagnostics.
    await page.getByTestId('project-settings-button').click();
    await page.getByTestId('project-settings-debug-toggle').click();
    await page.keyboard.press('Escape');

    // Nudge the playhead to force fresh live renders now that diagnostics are
    // published. On the healthy code clip_002 keeps rendering and emits
    // `[vlo frame-plan]`; on the frozen pipeline nothing is ever produced.
    const ruler = page.getByTestId('timeline-ruler');
    for (const fraction of [0.2, 0.35, 0.5, 0.65]) {
      const box = await ruler.boundingBox();
      if (box) {
        await page.mouse.click(
          box.x + box.width * fraction,
          box.y + box.height / 2,
        );
      }
      await page.waitForTimeout(500);
    }

    expect(stuckReadAttempted).toBe(true);
    await expect(framePlanLogged).resolves.toBeTruthy();
  });
});
