import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../../types";
import { TrustedHostPatchManager } from "../TrustedHostPatchManager";

function createScope(id: string): {
  scope: ExtensionApiScope;
  owned: ExtensionResource[];
} {
  const owned: ExtensionResource[] = [];
  return {
    owned,
    scope: {
      extension: { id, version: "1.0.0" },
      signal: new AbortController().signal,
      own: (resource) => {
        owned.push(resource);
        return resource;
      },
      report: vi.fn(),
    },
  };
}

function valueWrapper(prefix: string) {
  return (previous: PropertyDescriptor | undefined): PropertyDescriptor => {
    const prior = previous?.value as (value: string) => string;
    return {
      ...previous,
      configurable: true,
      value: (value: string) => `${prefix}(${prior(value)})`,
    };
  };
}

describe("TrustedHostPatchManager", () => {
  it("rebuilds stacked wrappers when the lower layer disposes first", () => {
    const manager = new TrustedHostPatchManager();
    const target = {
      format(value: string) {
        return value;
      },
    };
    const lower = createScope("example.lower");
    const upper = createScope("example.upper");
    const lowerPatch = manager.patchProperty(
      lower.scope,
      target,
      "format",
      valueWrapper("lower"),
    );
    const upperPatch = manager.patchProperty(
      upper.scope,
      target,
      "format",
      valueWrapper("upper"),
    );
    const firstUpperIdentity = target.format;

    expect(target.format("x")).toBe("upper(lower(x))");
    lowerPatch.dispose();
    expect(target.format("x")).toBe("upper(x)");
    expect(target.format).not.toBe(firstUpperIdentity);
    upperPatch.dispose();
    expect(target.format("x")).toBe("x");
  });

  it("restores the lower layer when the upper layer disposes first", () => {
    const manager = new TrustedHostPatchManager();
    const target = { format: (value: string) => value };
    const lower = manager.patchProperty(
      createScope("example.lower").scope,
      target,
      "format",
      valueWrapper("lower"),
    );
    const upper = manager.patchProperty(
      createScope("example.upper").scope,
      target,
      "format",
      valueWrapper("upper"),
    );

    upper.dispose();
    expect(target.format("x")).toBe("lower(x)");
    lower.dispose();
    expect(target.format("x")).toBe("x");
  });

  it("preserves accessors and deletes an originally absent property", () => {
    const manager = new TrustedHostPatchManager();
    const scope = createScope("example.accessor").scope;
    const target: { value?: number; extra?: string } = {};
    let stored = 2;
    Object.defineProperty(target, "value", {
      configurable: true,
      enumerable: true,
      get: () => stored,
      set: (value: number) => {
        stored = value;
      },
    });
    const accessor = manager.patchProperty(scope, target, "value", (previous) => ({
      ...previous,
      configurable: true,
      get: () => (previous?.get?.call(target) as number) * 2,
    }));
    const absent = manager.patchProperty(scope, target, "extra", () => ({
      configurable: true,
      writable: true,
      value: "patched",
    }));

    expect(target.value).toBe(4);
    expect(target.extra).toBe("patched");
    absent.dispose();
    expect(Object.hasOwn(target, "extra")).toBe(false);
    accessor.dispose();
    expect(target.value).toBe(2);
  });

  it("patches and restores prototype descriptors", () => {
    class Service {
      run(): string {
        return "original";
      }
    }
    const manager = new TrustedHostPatchManager();
    const patch = manager.patchProperty(
      createScope("example.prototype").scope,
      Service.prototype,
      "run",
      (previous) => ({
        ...previous,
        configurable: true,
        value: () => "patched",
      }),
    );

    expect(new Service().run()).toBe("patched");
    patch.dispose();
    expect(new Service().run()).toBe("original");
  });

  it("rejects non-configurable properties before mutation", () => {
    const manager = new TrustedHostPatchManager();
    const target = {};
    Object.defineProperty(target, "fixed", {
      configurable: false,
      value: "original",
    });

    expect(() =>
      manager.patchProperty(
        createScope("example.fixed").scope,
        target,
        "fixed",
        () => ({ configurable: true, value: "patched" }),
      ),
    ).toThrow("non-configurable");
    expect(Reflect.get(target, "fixed")).toBe("original");
  });

  it("does not clobber an untracked external write", () => {
    const manager = new TrustedHostPatchManager();
    const owner = createScope("example.conflict");
    const target = { value: "original" };
    const patch = manager.patchProperty(owner.scope, target, "value", () => ({
      configurable: true,
      writable: true,
      value: "managed",
    }));
    Object.defineProperty(target, "value", {
      configurable: true,
      writable: true,
      value: "external",
    });

    patch.dispose();
    expect(target.value).toBe("external");
    expect(owner.scope.report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("not restored"),
    );
  });

  it("leaves the installed chain untouched when a surviving factory rerun fails", () => {
    const manager = new TrustedHostPatchManager();
    const lower = createScope("example.lower");
    const upper = createScope("example.upper");
    const target = { value: "original" };
    let upperRuns = 0;
    const lowerPatch = manager.patchProperty(lower.scope, target, "value", () => ({
      configurable: true,
      writable: true,
      value: "lower",
    }));
    manager.patchProperty(upper.scope, target, "value", (previous) => {
      upperRuns += 1;
      if (upperRuns > 1) throw new Error("rerun failed");
      return { ...previous, configurable: true, value: "upper" };
    });

    expect(() => lowerPatch.dispose()).toThrow("rerun failed");
    expect(target.value).toBe("upper");
    expect(upper.scope.report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("left unchanged"),
      expect.any(Error),
    );
  });
});
