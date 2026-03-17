import { describe, expect, it } from "vitest";
import { Container, Point } from "pixi.js";
import { syncContainerTransformToTarget } from "../displayObjectSync";

const ORIGIN = new Point(0, 0);
const X_AXIS = new Point(1, 0);
const Y_AXIS = new Point(0, 1);

function expectSameWorldBasis(source: Container, follower: Container) {
  const sourceOrigin = source.toGlobal(ORIGIN, new Point());
  const sourceX = source.toGlobal(X_AXIS, new Point());
  const sourceY = source.toGlobal(Y_AXIS, new Point());

  const followerOrigin = follower.toGlobal(ORIGIN, new Point());
  const followerX = follower.toGlobal(X_AXIS, new Point());
  const followerY = follower.toGlobal(Y_AXIS, new Point());

  expect(followerOrigin.x).toBeCloseTo(sourceOrigin.x, 4);
  expect(followerOrigin.y).toBeCloseTo(sourceOrigin.y, 4);

  expect(followerX.x).toBeCloseTo(sourceX.x, 4);
  expect(followerX.y).toBeCloseTo(sourceX.y, 4);

  expect(followerY.x).toBeCloseTo(sourceY.x, 4);
  expect(followerY.y).toBeCloseTo(sourceY.y, 4);
}

describe("syncContainerTransformToTarget", () => {
  it("matches world transform across different parent hierarchies", () => {
    const root = new Container();

    const targetBranch = new Container();
    targetBranch.position.set(160, -80);
    targetBranch.rotation = 0.4;
    targetBranch.scale.set(1.4, 0.9);
    root.addChild(targetBranch);

    const targetParent = new Container();
    targetParent.position.set(-35, 25);
    targetParent.rotation = -0.3;
    targetParent.scale.set(0.8, -1.1);
    targetBranch.addChild(targetParent);

    const target = new Container();
    target.position.set(20, -12);
    target.rotation = 0.6;
    target.scale.set(1.7, 0.7);
    targetParent.addChild(target);

    const followerBranch = new Container();
    followerBranch.position.set(-90, 120);
    followerBranch.rotation = -0.2;
    followerBranch.scale.set(0.95, 1.3);
    root.addChild(followerBranch);

    const follower = new Container();
    followerBranch.addChild(follower);

    const synced = syncContainerTransformToTarget(follower, target);

    expect(synced).toBe(true);
    expectSameWorldBasis(target, follower);
  });

  it("returns false when follower has no parent", () => {
    const target = new Container();
    const follower = new Container();

    const synced = syncContainerTransformToTarget(follower, target);

    expect(synced).toBe(false);
  });
});
