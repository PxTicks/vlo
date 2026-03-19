import { test, expect } from './fixtures';

// Fixture project_v1 assets by type:
//   video (3): A_woman_in_202601222322_bssr2mp4, hf_20260122_..., Professional_Mode_...
//   image (1): 0d5748c1_cd1f_4b03_a676_eb2acc82442cpng
//   audio (1): ElevenLabs_2025_11_14T23_18_36_Alice_Young_British

test.describe('Asset Browser', () => {

    test('Tab switching filters assets by type', async ({ editor }) => {
        const { assetBrowser } = editor;

        // Default tab is video — 3 video assets
        await expect(assetBrowser.assetCards).toHaveCount(3);

        // Switch to Image tab — 1 image asset
        await assetBrowser.switchTab('image');
        await expect(assetBrowser.assetCards).toHaveCount(1);

        // Switch to Audio tab — 1 audio asset
        await assetBrowser.switchTab('audio');
        await expect(assetBrowser.assetCards).toHaveCount(1);

        // Switch back to Video tab — 3 again
        await assetBrowser.switchTab('video');
        await expect(assetBrowser.assetCards).toHaveCount(3);
    });

    test('Default sort order is Newest First', async ({ editor }) => {
        const { assetBrowser } = editor;

        // Video tab, sorted by createdAt descending (default):
        //   1. A_woman_in_202601222322_bssr2mp4        (createdAt: 1769553611587)
        //   2. hf_20260122_232943_...                   (createdAt: 1769553568646)
        //   3. Professional_Mode_...                    (createdAt: 1769553528060)
        const names = await assetBrowser.getCardNames();
        expect(names[0]).toContain('A_woman_in');
        expect(names[1]).toContain('hf_20260122');
        expect(names[2]).toContain('Professional_Mode');
    });

    test('Sort by Name A-Z', async ({ editor }) => {
        const { assetBrowser } = editor;

        await assetBrowser.sortBy('Name (A-Z)');

        // Alphabetical: A_woman_in, hf_20260122, Professional_Mode
        const names = await assetBrowser.getCardNames();
        expect(names[0]).toContain('A_woman_in');
        expect(names[1]).toContain('hf_20260122');
        expect(names[2]).toContain('Professional_Mode');
    });

    test('Sort by Oldest First', async ({ editor }) => {
        const { assetBrowser } = editor;

        await assetBrowser.sortBy('Oldest First');

        // createdAt ascending: Professional_Mode (oldest), hf_20260122, A_woman_in (newest)
        const names = await assetBrowser.getCardNames();
        expect(names[0]).toContain('Professional_Mode');
        expect(names[1]).toContain('hf_20260122');
        expect(names[2]).toContain('A_woman_in');
    });

    test('Video card shows duration badge and thumbnail', async ({ editor }) => {
        const { assetBrowser } = editor;

        // A_woman_in has duration=8 -> "0:08"
        const card = assetBrowser.assetCards.filter({ hasText: 'A_woman_in' }).first();
        await expect(card).toBeVisible();

        // Duration badge should show formatted time
        await expect(card.locator('text=0:08')).toBeVisible();

        // Thumbnail image should be present
        await expect(card.locator('img')).toBeVisible();
    });

    test('Audio card shows music note icon, no thumbnail', async ({ editor }) => {
        const { assetBrowser } = editor;

        await assetBrowser.switchTab('audio');

        const card = assetBrowser.assetCards.first();
        await expect(card).toBeVisible();

        // Audio cards show MusicNoteIcon (an SVG with data-testid="MusicNoteIcon")
        await expect(card.locator('[data-testid="MusicNoteIcon"]')).toBeVisible();

        // No <img> element (no thumbnail for audio)
        await expect(card.locator('img')).toHaveCount(0);
    });

    test('Image card shows thumbnail, no duration badge', async ({ editor }) => {
        const { assetBrowser } = editor;

        await assetBrowser.switchTab('image');

        const card = assetBrowser.assetCards.first();
        await expect(card).toBeVisible();

        // Thumbnail image present
        await expect(card.locator('img')).toBeVisible();

        // Image assets with duration=5 don't show a badge because
        // the DurationBadge is only rendered for non-image types (asset.type !== "image")
        // Verify no duration text like "0:05" appears
        await expect(card.locator('text=0:05')).toHaveCount(0);
    });

});
