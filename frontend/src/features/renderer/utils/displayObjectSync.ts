import { Container, Matrix, Point } from "pixi.js";

const ZERO = new Point(0, 0);
const UNIT_X = new Point(1, 0);
const UNIT_Y = new Point(0, 1);

const TARGET_GLOBAL_ORIGIN = new Point();
const TARGET_GLOBAL_X = new Point();
const TARGET_GLOBAL_Y = new Point();

const PARENT_LOCAL_ORIGIN = new Point();
const PARENT_LOCAL_X = new Point();
const PARENT_LOCAL_Y = new Point();

const LOCAL_MATRIX = new Matrix();

/**
 * Syncs `follower` so it matches `target` in world space even when they do not
 * share the same parent container.
 */
export function syncContainerTransformToTarget(
  follower: Container,
  target: Container,
): boolean {
  if (follower.destroyed || target.destroyed) return false;

  const followerParent = follower.parent;
  if (!followerParent || followerParent.destroyed) return false;

  // Sample target basis in global space and convert to follower-parent local space.
  target.toGlobal(ZERO, TARGET_GLOBAL_ORIGIN);
  target.toGlobal(UNIT_X, TARGET_GLOBAL_X);
  target.toGlobal(UNIT_Y, TARGET_GLOBAL_Y);

  followerParent.toLocal(TARGET_GLOBAL_ORIGIN, undefined, PARENT_LOCAL_ORIGIN);
  followerParent.toLocal(TARGET_GLOBAL_X, undefined, PARENT_LOCAL_X);
  followerParent.toLocal(TARGET_GLOBAL_Y, undefined, PARENT_LOCAL_Y);

  LOCAL_MATRIX.a = PARENT_LOCAL_X.x - PARENT_LOCAL_ORIGIN.x;
  LOCAL_MATRIX.b = PARENT_LOCAL_X.y - PARENT_LOCAL_ORIGIN.y;
  LOCAL_MATRIX.c = PARENT_LOCAL_Y.x - PARENT_LOCAL_ORIGIN.x;
  LOCAL_MATRIX.d = PARENT_LOCAL_Y.y - PARENT_LOCAL_ORIGIN.y;
  LOCAL_MATRIX.tx = PARENT_LOCAL_ORIGIN.x;
  LOCAL_MATRIX.ty = PARENT_LOCAL_ORIGIN.y;

  follower.setFromMatrix(LOCAL_MATRIX);

  return true;
}
