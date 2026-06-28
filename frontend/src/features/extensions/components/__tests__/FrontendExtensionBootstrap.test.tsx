import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrontendExtensionBootstrap } from "../FrontendExtensionBootstrap";
import type { FrontendExtensionStartSummary } from "../../services/FrontendExtensionRuntime";

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value: T) => resolve?.(value),
    reject: (reason: unknown) => reject?.(reason),
  };
}

describe("FrontendExtensionBootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts extensions without withholding core application rendering", () => {
    const startup = deferred<FrontendExtensionStartSummary>();
    const runtime = { start: vi.fn(() => startup.promise) };

    render(
      <FrontendExtensionBootstrap runtime={runtime}>
        <div>Application ready</div>
      </FrontendExtensionBootstrap>,
    );

    expect(screen.getByText("Application ready")).toBeInTheDocument();
    expect(runtime.start).toHaveBeenCalledOnce();

    startup.resolve({ inventoryLoaded: true, results: [] });
  });

  it("continues without extensions when bootstrap rejects unexpectedly", async () => {
    const error = new Error("unexpected failure");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = { start: vi.fn(async () => Promise.reject(error)) };

    render(
      <FrontendExtensionBootstrap runtime={runtime}>
        <div>Application ready</div>
      </FrontendExtensionBootstrap>,
    );

    expect(screen.getByText("Application ready")).toBeInTheDocument();
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("continuing without extensions"),
        error,
      );
    });
  });
});
