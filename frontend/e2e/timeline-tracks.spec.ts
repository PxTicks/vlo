import { test, expect } from './fixtures';

test.describe('Track Controls', () => {

    test('Track visibility toggle changes icon and clip state', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        const toggle = timeline.getTrackVisibilityToggle(0);
        const clip = timeline.getClip(0);

        // Initially visible
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect(toggle).toHaveAttribute('aria-label', 'Hide track');
        await expect(clip).toHaveAttribute('data-track-visible', 'true');

        // Toggle off — icon should change to VisibilityOff
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await expect(toggle).toHaveAttribute('aria-label', 'Show track');
        await expect(clip).toHaveAttribute('data-track-visible', 'false');

        // Toggle back on
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect(toggle).toHaveAttribute('aria-label', 'Hide track');
        await expect(clip).toHaveAttribute('data-track-visible', 'true');
    });

    test('Track mute toggle changes icon', async ({ editorWithClips }) => {
        const { timeline } = editorWithClips;

        const muteToggle = timeline.getTrackMuteToggle(0);

        // Initially unmuted
        await expect(muteToggle).toHaveAttribute('aria-pressed', 'false');
        await expect(muteToggle).toHaveAttribute('aria-label', 'Mute track');

        // Toggle mute on
        await muteToggle.click();
        await expect(muteToggle).toHaveAttribute('aria-pressed', 'true');
        await expect(muteToggle).toHaveAttribute('aria-label', 'Unmute track');

        // Toggle back
        await muteToggle.click();
        await expect(muteToggle).toHaveAttribute('aria-pressed', 'false');
        await expect(muteToggle).toHaveAttribute('aria-label', 'Mute track');
    });

    test('Audio track shows mute only, no visibility toggle', async ({ editorWithAudioTrack }) => {
        const { timeline } = editorWithAudioTrack;

        // project_v3_with_audio_track has 2 visual tracks + 1 audio track = 3 rows
        await expect(timeline.rows).toHaveCount(3);

        // The audio track is the last row (index 2)
        const audioRowIndex = 2;
        const audioHeader = timeline.getTrackHeader(audioRowIndex);
        await expect(audioHeader).toBeVisible();

        // Audio track should have mute toggle but no visibility toggle
        await expect(timeline.getTrackMuteToggle(audioRowIndex)).toBeVisible();
        await expect(timeline.getTrackVisibilityToggle(audioRowIndex)).toHaveCount(0);
    });

});
