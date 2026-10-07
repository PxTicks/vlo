import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_CURRENT_TIMELINE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../e2e/fixtures/project_current/.vloproject/timeline.json",
);

/** The base block for `buildLongTimelineFixture` (Node-only: reads from disk). */
export function readProjectCurrentTimeline(): unknown {
  return JSON.parse(fs.readFileSync(PROJECT_CURRENT_TIMELINE, "utf8")) as unknown;
}
