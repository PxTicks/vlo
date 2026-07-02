/**
 * Loader for the optional Bezier Curves extension package, which lives in the
 * git-ignored extension root with its own repository. This module is only
 * dynamically imported by BezierCurvesConformance.test.ts after it has
 * verified the package exists on disk; on checkouts without the package this
 * file is never loaded, so the unresolved static import below never executes.
 * The ts-ignore keeps `tsc` green on such checkouts.
 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - optional package, absent unless installed into extensions/
import { activate } from "../../../../../../extensions/vlo.bezier-curves/frontend/src/index";
import type { ExtensionModule } from "../../../extensions/types";

export const bezierCurvesActivate: ExtensionModule["activate"] = activate;
