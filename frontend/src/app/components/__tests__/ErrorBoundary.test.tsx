import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../ErrorBoundary";
import { errorBoundaryActions } from "../errorBoundaryRuntime";

let shouldThrow = false;

function MaybeThrow() {
  if (shouldThrow) {
    throw new Error("Boundary boom");
  }

  return <div>Recovered content</div>;
}

function findBoundaryLog(calls: unknown[][]) {
  return calls.find(
    ([message]) => message === "[ErrorBoundary] Caught render error",
  );
}

describe("ErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow = false;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("catches render errors and reports boundary context", async () => {
    shouldThrow = true;

    render(
      <ErrorBoundary boundaryName="Test panel" variant="panel">
        <MaybeThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("This area crashed");
    expect(screen.getByText("Boundary boom")).toBeInTheDocument();

    await waitFor(() => {
      const boundaryLog = findBoundaryLog(consoleErrorSpy.mock.calls);
      expect(boundaryLog).toBeDefined();
      expect(boundaryLog?.[1]).toEqual(
        expect.objectContaining({
          boundaryName: "Test panel",
          error: expect.any(Error),
          componentStack: expect.any(String),
        }),
      );
    });
  });

  it("remounts children when Try again is clicked", () => {
    shouldThrow = true;

    render(
      <ErrorBoundary boundaryName="Retry panel">
        <MaybeThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("Recovered content")).toBeInTheDocument();
  });

  it("reloads the app from the fallback", () => {
    const reloadSpy = vi
      .spyOn(errorBoundaryActions, "reloadApp")
      .mockImplementation(() => {});
    shouldThrow = true;

    render(
      <ErrorBoundary boundaryName="Reload panel">
        <MaybeThrow />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /reload app/i }));

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    reloadSpy.mockRestore();
  });

  it("resets a caught error when reset keys change", () => {
    shouldThrow = true;
    const { rerender } = render(
      <ErrorBoundary boundaryName="Reset panel" resetKeys={["one"]}>
        <MaybeThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow = false;
    rerender(
      <ErrorBoundary boundaryName="Reset panel" resetKeys={["two"]}>
        <MaybeThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Recovered content")).toBeInTheDocument();
  });
});
