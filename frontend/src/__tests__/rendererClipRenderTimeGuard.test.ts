import { describe, expect, it } from "vitest";

/**
 * Renderer-internal timing ratchet.
 *
 * The renderer has several legitimate time domains:
 * - presentation tick: global playhead/output time
 * - effective track tick: after adjustment/presentation retiming
 * - clip visual tick: local visual position inside the clip footprint
 * - source-media tick: media/keyframe time after crop + speed
 *
 * Bugs creep in when a service locally re-derives one domain from another
 * (`effectiveTick - clip.start`, `calculatePlayerFrameTime(...)`) and then the
 * value silently gets fed to the wrong consumer. All renderer services should
 * ask `clipRenderTime` for the named domains and pass the domain they mean.
 */

const RAW_FILES = import.meta.glob("../features/renderer/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CENTRAL_TIMING_FILES = new Set([
  "features/renderer/utils/clipRenderTime.ts",
  // mediaTime owns the legacy primitive and the external seconds boundary.
  "features/renderer/utils/mediaTime.ts",
  // renderTime/index keep compatibility re-exports, but services must not
  // import or call the legacy primitive directly.
  "features/renderer/utils/renderTime.ts",
  "features/renderer/index.ts",
]);

const PRIVATE_TIMING_PATTERNS: Array<{
  label: string;
  regex: RegExp;
}> = [
  {
    label: "calculatePlayerFrameTime",
    regex: /\bcalculatePlayerFrameTime\b/,
  },
  {
    label: "direct effective tick minus clip start",
    regex:
      /\b(?:effectiveTick|effectiveTrackTick)\s*-\s*(?:activeClip|clip|options\.clip)\.start\b/,
  },
  {
    label: "legacy visual-tick variable named as seconds",
    regex: /\brawTimeSeconds\b/,
  },
  {
    label: "audio effect automation localTickAt",
    regex: /\blocalTickAt\b/,
  },
];

function normalize(globKey: string): string {
  return globKey.replace(/^\.\.\//, "");
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

describe("renderer clip render-time guard", () => {
  it("keeps renderer services on the shared clipRenderTime boundary", () => {
    const offenders: string[] = [];

    for (const [globKey, source] of Object.entries(RAW_FILES)) {
      const path = normalize(globKey);
      if (path.includes("__tests__") || path.includes(".test.")) continue;
      if (CENTRAL_TIMING_FILES.has(path)) continue;

      const stripped = stripCommentsAndStrings(source);
      for (const pattern of PRIVATE_TIMING_PATTERNS) {
        if (pattern.regex.test(stripped)) {
          offenders.push(`${path} (${pattern.label})`);
        }
      }
    }

    expect(
      offenders.sort(),
      `Renderer code is deriving timing privately. Route presentation/effective ` +
        `track/clip-visual/source-media time through ` +
        `features/renderer/utils/clipRenderTime.ts instead:\n` +
        offenders.map((path) => `  - ${path}`).join("\n"),
    ).toEqual([]);
  });
});
