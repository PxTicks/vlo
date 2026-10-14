import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pixiMocks = vi.hoisted(() => ({
  getActivePixiContentTarget: vi.fn(),
  readActivePixiContentPixels: vi.fn(),
}));

vi.mock("../../../core/pixi/activeApplication", () => pixiMocks);

import { HostScopeRegistry, type ScopeRenderTarget } from "../scopeRegistry";
import { registerHostScopes } from "../hostScopes";
import { ScopesView } from "../ScopesView";

function fakeContext() {
  return {
    fillRect: vi.fn(),
    createImageData: vi.fn((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    })),
    putImageData: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
  };
}

function greyPixels(count: number) {
  const pixels = new Uint8Array(count * 4);
  for (let index = 0; index < count; index += 1) {
    pixels.set([200, 120, 40, 255], index * 4);
  }
  return pixels;
}

let context: ReturnType<typeof fakeContext>;

describe("ScopesView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    context = fakeContext();
    // getContext is overloaded per context id; the view only asks for "2d".
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (() => context) as unknown as HTMLCanvasElement["getContext"],
    );
    pixiMocks.getActivePixiContentTarget.mockReturnValue({
      frame: { width: 1024, height: 512 },
    });
    pixiMocks.readActivePixiContentPixels.mockReturnValue({
      pixels: greyPixels(4),
      width: 2,
      height: 2,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    pixiMocks.getActivePixiContentTarget.mockReset();
    pixiMocks.readActivePixiContentPixels.mockReset();
  });

  it("explains when no scopes are registered", () => {
    render(<ScopesView registry={new HostScopeRegistry()} />);
    expect(screen.getByText("No scopes are registered.")).toBeInTheDocument();
    expect(pixiMocks.readActivePixiContentPixels).not.toHaveBeenCalled();
  });

  it("samples the viewer at a capped width and draws every host scope", () => {
    const registry = new HostScopeRegistry();
    registerHostScopes(registry);
    render(<ScopesView registry={registry} />);

    // 512 px sampling cap over a 1024 px frame.
    expect(pixiMocks.readActivePixiContentPixels).toHaveBeenCalledWith(
      { width: 1024, height: 512 },
      0.5,
    );
    expect(screen.getByTestId("scope-surface")).toBeInTheDocument();
    expect(context.fillRect).toHaveBeenCalled();
    expect(context.putImageData).toHaveBeenCalled();

    for (const label of ["Parade", "Vector"]) {
      context.putImageData.mockClear();
      fireEvent.click(screen.getByRole("tab", { name: label }));
      expect(context.putImageData).toHaveBeenCalled();
    }

    context.stroke.mockClear();
    fireEvent.click(screen.getByRole("tab", { name: "Histogram" }));
    // One stroke per channel: red, green, blue and luma.
    expect(context.stroke).toHaveBeenCalledTimes(4);
    expect(context.globalAlpha).toBe(1);
  });

  it("keeps sampling on a timer and stops when hidden or unmounted", () => {
    const registry = new HostScopeRegistry();
    registerHostScopes(registry);
    const { rerender, unmount } = render(<ScopesView registry={registry} />);
    expect(pixiMocks.readActivePixiContentPixels).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(pixiMocks.readActivePixiContentPixels).toHaveBeenCalledTimes(2);

    rerender(<ScopesView registry={registry} active={false} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(pixiMocks.readActivePixiContentPixels).toHaveBeenCalledTimes(2);

    rerender(<ScopesView registry={registry} />);
    expect(pixiMocks.readActivePixiContentPixels).toHaveBeenCalledTimes(3);
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(pixiMocks.readActivePixiContentPixels).toHaveBeenCalledTimes(3);
  });

  it("skips readback while the document is hidden or no viewer is active", () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const registry = new HostScopeRegistry();
    registerHostScopes(registry);
    render(<ScopesView registry={registry} />);
    expect(pixiMocks.readActivePixiContentPixels).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    pixiMocks.getActivePixiContentTarget.mockReturnValue(null);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(pixiMocks.readActivePixiContentPixels).not.toHaveBeenCalled();
  });

  it("survives readback failures and retries on the next tick", () => {
    pixiMocks.readActivePixiContentPixels
      .mockImplementationOnce(() => {
        throw new Error("renderer replaced");
      })
      .mockReturnValueOnce(null);
    const renderScope = vi.fn();
    const registry = new HostScopeRegistry();
    registry.registerHostScope({
      id: "test.scope",
      label: "Test",
      width: 32,
      height: 32,
      order: 1,
      render: renderScope,
    });
    render(<ScopesView registry={registry} />);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(renderScope).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(renderScope).toHaveBeenCalledWith(
      expect.objectContaining<Partial<ScopeRenderTarget>>({
        width: 32,
        height: 32,
      }),
    );
  });

  it("contains a throwing scope and falls back when the shown scope is disposed", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const registry = new HostScopeRegistry();
    registerHostScopes(registry);
    const broken = registry.registerHostScope({
      id: "test.broken",
      label: "Broken",
      width: 32,
      height: 32,
      order: 99,
      render: () => {
        throw new Error("draw failed");
      },
    });
    render(<ScopesView registry={registry} />);

    fireEvent.click(screen.getByRole("tab", { name: "Broken" }));
    expect(consoleError).toHaveBeenCalledWith(
      "Scope 'test.broken' failed to render.",
      expect.any(Error),
    );

    act(() => broken.dispose());
    expect(screen.queryByRole("tab", { name: "Broken" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Waveform" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
