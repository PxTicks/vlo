import React from "react";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimelineContainer } from "../TimelineContainer";
import { useTimelineStore } from "../useTimelineStore";
import { produceWithPatches } from "../../../lib/immerLite";
import { timelineDocumentSchema } from "../../project/schemas/projectPersistenceSchemas";
import type { TimelineClip } from "../../../types/TimelineTypes";
import {
  LONG_TIMELINE_DEFAULT_REPETITIONS,
  PROJECT_CURRENT_BEAT_AUDIO,
  buildLongTimelineFixture,
  toLongTimelineDocument,
} from "./fixtures/longTimelineFixture";
import { readProjectCurrentTimeline } from "./fixtures/longTimelineFixtureSource";

/**
 * Timing lane for long timelines (docs/long-timeline-performance-plan.md,
 * workstream 0). Excluded from the default run; run it with
 * `npm run bench:timeline`. jsdom timings are for before/after comparison
 * on one machine, not browser numbers.
 *
 * LONG_TIMELINE_REPETITIONS overrides the fixture size (copies of
 * project_current, 13 clips each). Results print as a table and are written
 * to test-results/long-timeline-bench/.
 */

const thumbnailRenders = vi.hoisted(() => ({ count: 0 }));

// Thumbnail drawing needs a real canvas; it is out of scope for this lane.
vi.mock("../components/ThumbnailCanvas", () => ({
  ThumbnailCanvas: () => {
    thumbnailRenders.count += 1;
    return null;
  },
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const REPETITIONS = Number(
  process.env.LONG_TIMELINE_REPETITIONS ?? LONG_TIMELINE_DEFAULT_REPETITIONS,
);
const MOUNT_SAMPLES = 3;
const INTERACTION_SAMPLES = 5;
const DATA_SAMPLES = 10;
const OUTPUT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../test-results/long-timeline-bench",
);

interface Timing {
  name: string;
  medianMs: number;
  minMs: number;
  samples: number;
}

interface Count {
  name: string;
  value: number;
  unit: string;
}

const timings: Timing[] = [];
const counts: Count[] = [];

function recordTiming(name: string, samplesMs: number[]): void {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  timings.push({
    name,
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    minMs: round(sorted[0]),
    samples: sorted.length,
  });
}

function recordCount(name: string, value: number, unit: string): void {
  counts.push({ name, value, unit });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Runs `setup` untimed, then times `run`; one warm-up sample is discarded. */
function sample(
  count: number,
  run: () => void,
  setup: () => void = () => {},
): number[] {
  const samples: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    setup();
    const start = performance.now();
    run();
    const elapsed = performance.now() - start;
    if (index > 0) samples.push(elapsed);
  }
  return samples;
}

const fixture = buildLongTimelineFixture(readProjectCurrentTimeline(), {
  repetitions: REPETITIONS,
  audio: PROJECT_CURRENT_BEAT_AUDIO,
});

function loadFixture(): void {
  act(() => {
    useTimelineStore.getState().replaceTimelineSnapshot({
      tracks: fixture.tracks,
      clips: fixture.clips,
      transitions: fixture.transitions,
    });
  });
}

function middleVideoClip(): TimelineClip {
  const videos = useTimelineStore
    .getState()
    .clips.filter((clip) => clip.type === "video");
  return videos[Math.floor(videos.length / 2)];
}

function renderTimeline() {
  return render(
    <TimelineContainer
      scrollContainerRef={React.createRef<HTMLDivElement>()}
      insertGapIndex={null}
    />,
  );
}

function gitDescription(): string {
  try {
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim();
    return dirty ? `${commit}+dirty` : commit;
  } catch {
    return "unknown";
  }
}

function report(): void {
  const clips = useTimelineStore.getState().clips;
  const result = {
    recordedAt: new Date().toISOString(),
    commit: gitDescription(),
    node: process.version,
    fixture: {
      repetitions: REPETITIONS,
      clips: fixture.clips.length,
      nonMaskClips: fixture.clips.filter((clip) => clip.type !== "mask").length,
      tracks: fixture.tracks.length,
      timelineJsonBytes: JSON.stringify(
        toLongTimelineDocument({ ...fixture, clips }),
        null,
        2,
      ).length,
    },
    timings,
    counts,
  };

  fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  const stamp = result.recordedAt.replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(OUTPUT_DIRECTORY, `${stamp}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIRECTORY, "latest.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );

  const lines = [
    `Long timeline bench @ ${result.commit}: ${result.fixture.clips} clips ` +
      `(${result.fixture.nonMaskClips} non-mask), ${result.fixture.tracks} tracks`,
    ...timings.map(
      (t) =>
        `  ${t.name.padEnd(44)} median ${String(t.medianMs).padStart(8)} ms` +
        `   min ${String(t.minMs).padStart(8)} ms   (n=${t.samples})`,
    ),
    ...counts.map(
      (c) => `  ${c.name.padEnd(44)} ${String(c.value).padStart(15)} ${c.unit}`,
    ),
    `  written to ${path.relative(process.cwd(), OUTPUT_DIRECTORY)}/latest.json`,
  ];
  // Straight to stdout: the reporter drops console output from passing tests.
  process.stdout.write(`\n${lines.join("\n")}\n\n`);
}

describe("long timeline performance lane", () => {
  it("measures mount, interaction, commit and save costs", { timeout: 600_000 }, () => {
    loadFixture();

    // 1. Mount the real timeline UI over the whole fixture.
    let view: ReturnType<typeof renderTimeline> | null = null;
    recordTiming(
      "mount timeline",
      sample(
        MOUNT_SAMPLES,
        () => {
          view = renderTimeline();
        },
        () => view?.unmount(),
      ),
    );
    recordCount(
      "mounted timeline-clip nodes",
      screen.getAllByTestId("timeline-clip").length,
      "nodes",
    );

    // 2. Interactions against the mounted UI.
    const clipIds = useTimelineStore
      .getState()
      .clips.filter((clip) => clip.type !== "mask")
      .map((clip) => clip.id);
    let selection = 0;
    recordTiming(
      "selection change",
      sample(INTERACTION_SAMPLES, () => {
        selection = (selection + 97) % clipIds.length;
        act(() => useTimelineStore.getState().selectClip(clipIds[selection]));
      }),
    );
    act(() => useTimelineStore.getState().selectClip(null));

    const edited = middleVideoClip();
    recordTiming(
      "one-clip commit (React + commit)",
      sample(INTERACTION_SAMPLES, () => {
        act(() => useTimelineStore.getState().toggleClipMute(edited.id));
      }),
    );
    thumbnailRenders.count = 0;
    act(() => useTimelineStore.getState().toggleClipMute(edited.id));
    recordCount("thumbnail clips rendered per one-clip commit", thumbnailRenders.count, "renders");

    const toggledTrackId = edited.trackId;
    recordTiming(
      "track visibility toggle",
      sample(INTERACTION_SAMPLES, () => {
        act(() => useTimelineStore.getState().toggleTrackVisibility(toggledTrackId));
      }),
    );
    view!.unmount();

    // 3. Commit and undo costs without React.
    loadFixture();
    recordTiming(
      "one-clip commit (store only)",
      sample(DATA_SAMPLES, () => {
        useTimelineStore.getState().toggleClipMute(edited.id);
      }),
    );
    const model = {
      tracks: useTimelineStore.getState().tracks,
      clips: useTimelineStore.getState().clips,
      transitions: useTimelineStore.getState().transitions,
    };
    const editedIndex = model.clips.findIndex((clip) => clip.id === edited.id);
    recordTiming(
      "produceWithPatches, one-clip edit",
      sample(DATA_SAMPLES, () => {
        produceWithPatches(model, (draft) => {
          draft.clips[editedIndex].name = `${draft.clips[editedIndex].name}!`;
        });
      }),
    );

    loadFixture();
    act(() => useTimelineStore.getState().toggleClipMute(edited.id));
    const [entry] = useTimelineStore.getState().getHistoryDiagnostics().undoEntries;
    recordCount("undo entry patches (forward + inverse)", entry.forwardPatchCount + entry.inversePatchCount, "patches");
    recordCount("undo entry retained patch JSON", entry.patchJsonBytes, "bytes");

    // 4. Save-path data costs for the whole document.
    const document = toLongTimelineDocument({
      ...fixture,
      clips: useTimelineStore.getState().clips,
    });
    recordTiming(
      "timelineDocumentSchema.parse",
      sample(DATA_SAMPLES, () => {
        timelineDocumentSchema.parse(document);
      }),
    );
    recordTiming(
      "JSON.stringify(document, null, 2)",
      sample(DATA_SAMPLES, () => {
        JSON.stringify(document, null, 2);
      }),
    );

    report();
    expect(timings.length).toBeGreaterThan(0);
  });
});
