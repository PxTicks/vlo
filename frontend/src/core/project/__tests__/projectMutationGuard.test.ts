import { describe, expect, it } from "vitest";
import {
  deferProjectMutation,
  ProjectMutationBlockedError,
  ProjectMutationGuard,
  projectMutationGuard,
} from "../projectMutationGuard";

describe("project mutation guard", () => {
  it("refuses changes while an export holds the project, and admits them after", async () => {
    const guard = new ProjectMutationGuard();
    const lease = await guard.acquire();
    expect(guard.isFrozen()).toBe(true);
    expect(() => guard.assertEditable()).toThrow(ProjectMutationBlockedError);
    expect(() => guard.beginMutation()).toThrow(/paused/);
    lease.release();
    guard.assertEditable();
    guard.beginMutation()();
  });

  it("finishes a change already in flight, then freezes before anything else starts", async () => {
    const guard = new ProjectMutationGuard();
    const finishPublish = guard.beginMutation();
    let leased = false;
    const acquiring = guard.acquire().then((lease) => { leased = true; return lease; });
    await Promise.resolve();
    expect(leased).toBe(false);

    // A multi-step change keeps working while the export waits: refusing its
    // later steps would leave it half-applied.
    const nestedStep = guard.beginMutation();
    nestedStep();
    await Promise.resolve();
    expect(leased).toBe(false);

    finishPublish();
    // Installed in the same turn as the last release, so nothing slips in.
    expect(() => guard.beginMutation()).toThrow(ProjectMutationBlockedError);
    const lease = await acquiring;
    expect(leased).toBe(true);
    lease.release();
  });

  it("stops waiting when the export is cancelled, leaving the project editable", async () => {
    const guard = new ProjectMutationGuard();
    const finish = guard.beginMutation();
    const controller = new AbortController();
    const acquiring = guard.acquire({ signal: controller.signal });
    controller.abort();
    await expect(acquiring).rejects.toMatchObject({ name: "AbortError" });
    finish();
    expect(guard.isFrozen()).toBe(false);
    (await guard.acquire()).release();
  });

  it("refuses a second export while one waits or holds the project", async () => {
    const guard = new ProjectMutationGuard();
    const finish = guard.beginMutation();
    const first = guard.acquire();
    await expect(guard.acquire()).rejects.toThrow(ProjectMutationBlockedError);
    finish();
    const lease = await first;
    await expect(guard.acquire()).rejects.toThrow(ProjectMutationBlockedError);
    lease.release();
  });

  it("refuses active edits without clearing or committing them", async () => {
    const guard = new ProjectMutationGuard();
    let active = true;
    const remove = guard.registerEditBlocker(() => (active ? "Finish the edit" : null));
    expect(() => guard.assertQuiescent()).toThrow("Finish the edit");
    await expect(guard.acquire()).rejects.toThrow("Finish the edit");
    expect(active).toBe(true);
    // Checking must not freeze anything: the brush flush that follows edits.
    guard.beginMutation()();
    active = false;
    (await guard.acquire()).release();
    remove();
  });

  it("rechecks edit sessions that opened while it waited", async () => {
    const guard = new ProjectMutationGuard();
    let active = false;
    guard.registerEditBlocker(() => (active ? "Finish the spline edit" : null));
    const finish = guard.beginMutation();
    const acquiring = guard.acquire();
    active = true;
    finish();
    await expect(acquiring).rejects.toThrow("Finish the spline edit");
    expect(guard.isFrozen()).toBe(false);
  });

  it("does not let a stale owner release a later export", async () => {
    const guard = new ProjectMutationGuard();
    const first = await guard.acquire();
    first.release();
    const second = await guard.acquire();
    first.release();
    expect(() => guard.assertEditable()).toThrow(ProjectMutationBlockedError);
    second.release();
  });

  it("tells freeze listeners when an export takes the project, until they unsubscribe", async () => {
    const guard = new ProjectMutationGuard();
    const calls: string[] = [];
    const unsubscribe = guard.onFreeze(() => calls.push("listener"));
    guard.onFreeze(() => {
      throw new Error("listener failed");
    });
    const error = console.error;
    console.error = () => undefined;

    try {
      const first = await guard.acquire();
      expect(calls).toEqual(["listener"]);
      expect(guard.isFrozen()).toBe(true);
      first.release();

      unsubscribe();
      (await guard.acquire()).release();
      expect(calls).toEqual(["listener"]);
    } finally {
      console.error = error;
    }
  });

  it("resumes deferred work once, when the export ends", async () => {
    const guard = new ProjectMutationGuard();
    const resumed: string[] = [];
    guard.whenUnfrozen(() => resumed.push("now"));
    expect(resumed).toEqual(["now"]);

    const lease = await guard.acquire();
    guard.whenUnfrozen(() => { throw new Error("this waiter is gone"); });
    guard.whenUnfrozen(() => resumed.push("deferred"));
    expect(resumed).toEqual(["now"]);

    lease.release();
    // One waiter throwing must not strand the others.
    expect(resumed).toEqual(["now", "deferred"]);

    (await guard.acquire()).release();
    expect(resumed).toEqual(["now", "deferred"]);
  });
});

describe("deferred project mutations", () => {
  it("hold an arriving change until the export ends, instead of losing it", async () => {
    const imported: string[] = [];
    const importAsset = deferProjectMutation(async (name: string) => {
      imported.push(name);
      return name;
    });
    const lease = await projectMutationGuard.acquire();
    const pending = importAsset("generation.mp4");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(imported).toEqual([]);

    lease.release();
    await expect(pending).resolves.toBe("generation.mp4");
    expect(imported).toEqual(["generation.mp4"]);
  });

  it("run straight away and delay an export until they finish", async () => {
    let finishImport!: () => void;
    const importAsset = deferProjectMutation(
      () => new Promise<void>((resolve) => { finishImport = resolve; }),
    );
    const importing = importAsset();
    await new Promise((resolve) => setTimeout(resolve, 0));

    let leased = false;
    const acquiring = projectMutationGuard.acquire().then((lease) => { leased = true; return lease; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leased).toBe(false);

    finishImport();
    await importing;
    (await acquiring).release();
    expect(leased).toBe(true);
  });
});
