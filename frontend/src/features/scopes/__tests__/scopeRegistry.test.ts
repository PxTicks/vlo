import { describe, expect, it, vi } from "vitest";
import { HostScopeRegistry, type ScopeRenderTarget } from "../scopeRegistry";
import { analyzeScopeFrame, registerHostScopes } from "../hostScopes";

function frame(pixelCount = 4) {
  const pixels = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    pixels[index * 4] = 128;
    pixels[index * 4 + 1] = 128;
    pixels[index * 4 + 2] = 128;
    pixels[index * 4 + 3] = 255;
  }
  return { pixels, width: 2, height: 2, sampledAt: 1 };
}

function target(overrides: Partial<ScopeRenderTarget> = {}): ScopeRenderTarget {
  return {
    context: {} as CanvasRenderingContext2D,
    width: 8,
    height: 8,
    frame: frame(),
    ...overrides,
  };
}

describe("HostScopeRegistry", () => {
  it("holds host and contributed scopes in one ordered table", () => {
    const registry = new HostScopeRegistry();
    registerHostScopes(registry);
    registry.registerEntry({
      id: "example.a/false-color",
      label: "False Colour",
      width: 64,
      height: 32,
      order: 5,
      source: "extension",
      render: () => undefined,
    });

    const list = registry.list();
    expect(list.map((scope) => scope.id)).toEqual([
      // Sorted by order across both sources, not host-first then extras.
      "example.a/false-color",
      "host.waveform",
      "host.parade",
      "host.vectorscope",
      "host.histogram",
    ]);
    expect(list[0]?.source).toBe("extension");
  });

  it("validates surface bounds, labels, and IDs per source", () => {
    const registry = new HostScopeRegistry();
    const base = {
      label: "Scope",
      width: 64,
      height: 32,
      order: 0,
      render: () => undefined,
    };
    expect(() =>
      registry.registerEntry({ ...base, id: "no-namespace", source: "extension" }),
    ).toThrow(/Invalid extension scope ID/);
    expect(() =>
      registry.registerEntry({ ...base, id: "example.a/x", source: "host" }),
    ).toThrow(/Invalid host scope ID/);
    expect(() =>
      registry.registerHostScope({ ...base, id: "host.tiny", width: 4 }),
    ).toThrow(/width must be an integer between/);
    expect(() =>
      registry.registerHostScope({ ...base, id: "host.huge", height: 4_096 }),
    ).toThrow(/height must be an integer between/);
    expect(() =>
      registry.registerHostScope({ ...base, id: "host.blank", label: "  " }),
    ).toThrow(/label must be/);
    expect(() =>
      registry.registerHostScope({ ...base, id: "host.nan", order: Number.NaN }),
    ).toThrow(/order must be finite/);
  });

  it("rejects a duplicate ID and frees it again on disposal", () => {
    const registry = new HostScopeRegistry();
    const definition = {
      id: "host.waveform",
      label: "Waveform",
      width: 64,
      height: 32,
      order: 0,
      render: () => undefined,
    };
    const registration = registry.registerHostScope(definition);
    expect(() => registry.registerHostScope(definition)).toThrow(
      /already registered/,
    );

    registration.dispose();
    registration.dispose();
    expect(registry.list()).toEqual([]);
    expect(() => registry.registerHostScope(definition)).not.toThrow();
  });

  it("notifies subscribers without letting one break the others", () => {
    const registry = new HostScopeRegistry();
    const failing = vi.fn(() => {
      throw new Error("observer");
    });
    const listener = vi.fn();
    registry.subscribe(failing);
    const unsubscribe = registry.subscribe(listener);

    const before = registry.getRevision();
    registry.registerHostScope({
      id: "host.waveform",
      label: "Waveform",
      width: 64,
      height: 32,
      order: 0,
      render: () => undefined,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getRevision()).toBeGreaterThan(before);

    unsubscribe();
    registry.registerHostScope({
      id: "host.parade",
      label: "Parade",
      width: 64,
      height: 32,
      order: 1,
      render: () => undefined,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("analyzeScopeFrame", () => {
  it("analyses one sample once, however many native scopes draw it", () => {
    const sample = frame();
    const first = analyzeScopeFrame(sample);
    expect(analyzeScopeFrame(sample)).toBe(first);
    // A new sample is a new analysis; the cache is keyed on the sample object.
    expect(analyzeScopeFrame(frame())).not.toBe(first);
  });

  it("drives every native scope from the shared analysis", () => {
    const registry = new HostScopeRegistry();
    registerHostScopes(registry);
    const createImageData = vi.fn((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }));
    const context = {
      createImageData,
      putImageData: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      globalAlpha: 1,
      strokeStyle: "",
    } as unknown as CanvasRenderingContext2D;

    for (const scope of registry.list()) {
      expect(() =>
        scope.render(
          target({ context, width: scope.width, height: scope.height }),
        ),
      ).not.toThrow();
    }
    // Three density plots allocate an image; the histogram strokes paths.
    expect(createImageData).toHaveBeenCalledTimes(3);
  });
});
