import { describe, expect, it, vi } from "vitest";
import {
  TrustedHostObjectManager,
  releaseTrustedHostObject,
  type TrustedHostObjectSlotAdapter,
} from "../publicApi";

class TestHostObject {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }
}

type TestAdapter = TrustedHostObjectSlotAdapter<
  TestHostObject,
  string,
  string[]
>;

function createAdapter(events: string[]): TestAdapter {
  return {
    slotKind: "test object",
    validate: (object): object is TestHostObject =>
      object instanceof TestHostObject,
    isSameSlot: (left, right) => left === right,
    attach: (object, slot, attachment) => {
      const event = `attach:${object.id}:${slot}`;
      events.push(event);
      attachment.push(event);
    },
    detach: (object, slot) => events.push(`detach:${object.id}:${slot}`),
    destroy: (object) => events.push(`host-destroy:${object.id}`),
  };
}

describe("TrustedHostObjectManager", () => {
  it("owns updates, slot movement, cleanup order, and host destruction", () => {
    const events: string[] = [];
    const report = vi.fn();
    const object = new TestHostObject("one");
    const manager = new TrustedHostObjectManager({
      contributionId: "example.owner/object",
      create: () => ({
        object,
        update: (_parameters, context: string) =>
          events.push(`update:${context}`),
        destroy: () => events.push("extension-destroy"),
      }),
      adapter: createAdapter(events),
      reportFailureOnce: report,
    });
    const attachment: string[] = [];

    expect(manager.create()).toBe(object);
    expect(manager.owns(object)).toBe(true);
    expect(manager.update(object, {}, "first", "slot-a", attachment)).toBe(
      true,
    );
    expect(manager.update(object, {}, "second", "slot-a", attachment)).toBe(
      true,
    );
    expect(manager.update(object, {}, "third", "slot-b", attachment)).toBe(
      true,
    );
    manager.release(object);

    expect(events).toEqual([
      "update:first",
      "attach:one:slot-a",
      "update:second",
      "attach:one:slot-a",
      "detach:one:slot-a",
      "update:third",
      "attach:one:slot-b",
      "detach:one:slot-b",
      "extension-destroy",
      "host-destroy:one",
    ]);
    expect(manager.owns(object)).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it("rejects one object being leased by two contributions", () => {
    const events: string[] = [];
    const object = new TestHostObject("shared");
    const firstReport = vi.fn();
    const secondReport = vi.fn();
    const rejectedCleanup = vi.fn();
    const first = new TrustedHostObjectManager({
      contributionId: "example.first/object",
      create: () => ({ object, update: () => undefined }),
      adapter: createAdapter(events),
      reportFailureOnce: firstReport,
    });
    const second = new TrustedHostObjectManager({
      contributionId: "example.second/object",
      create: () => ({
        object,
        update: () => undefined,
        destroy: rejectedCleanup,
      }),
      adapter: createAdapter(events),
      reportFailureOnce: secondReport,
    });

    expect(first.create()).toBe(object);
    expect(second.create()).toBeNull();
    expect(rejectedCleanup).toHaveBeenCalledOnce();
    expect(secondReport).toHaveBeenCalledWith(
      "duplicate-object",
      "error",
      expect.stringContaining("already owned"),
    );
    expect(events).not.toContain("host-destroy:shared");

    expect(releaseTrustedHostObject(object)).toBe(true);
    expect(releaseTrustedHostObject(object)).toBe(false);
    expect(events).toContain("host-destroy:shared");
  });

  it("isolates update failures and releases the object", () => {
    const events: string[] = [];
    const report = vi.fn();
    const extensionDestroy = vi.fn();
    const object = new TestHostObject("broken");
    const manager = new TrustedHostObjectManager({
      contributionId: "example.broken/object",
      create: () => ({
        object,
        update: () => {
          throw new Error("update failed");
        },
        destroy: extensionDestroy,
      }),
      adapter: createAdapter(events),
      reportFailureOnce: report,
    });
    manager.create();

    expect(manager.update(object, {}, "context", "slot", [])).toBe(false);
    expect(manager.owns(object)).toBe(false);
    expect(extensionDestroy).toHaveBeenCalledOnce();
    expect(events).toContain("host-destroy:broken");
    expect(report).toHaveBeenCalledWith(
      "update",
      "error",
      expect.stringContaining("failed during update or attachment"),
      expect.any(Error),
    );
  });

  it("detaches a partially attached object when its slot adapter fails", () => {
    const events: string[] = [];
    const object = new TestHostObject("partial");
    const adapter = createAdapter(events);
    adapter.attach = (attachedObject, slot) => {
      events.push(`partial-attach:${attachedObject.id}:${slot}`);
      throw new Error("attach failed");
    };
    const manager = new TrustedHostObjectManager({
      contributionId: "example.partial/object",
      create: () => ({ object, update: () => undefined }),
      adapter,
      reportFailureOnce: vi.fn(),
    });
    manager.create();

    expect(manager.update(object, {}, undefined, "slot", [])).toBe(false);
    expect(events).toEqual([
      "partial-attach:partial:slot",
      "detach:partial:slot",
      "host-destroy:partial",
    ]);
  });

  it("disposes every live object", () => {
    const events: string[] = [];
    let nextId = 0;
    const manager = new TrustedHostObjectManager({
      contributionId: "example.dispose/object",
      create: () => ({
        object: new TestHostObject(String(++nextId)),
        update: () => undefined,
      }),
      adapter: createAdapter(events),
      reportFailureOnce: vi.fn(),
    });
    const first = manager.create();
    const second = manager.create();
    if (!first || !second) throw new Error("Expected managed objects.");

    manager.dispose();

    expect(manager.owns(first)).toBe(false);
    expect(manager.owns(second)).toBe(false);
    expect(events).toEqual(["host-destroy:1", "host-destroy:2"]);
    expect(manager.create()).toBeNull();
  });
});
