import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshot: {
    active: {
      id: "host.fixture",
      title: "Fixture workspace",
      ownerId: "host.fixture",
      subject: { clipId: "a" },
      subjectLabel: "Clip a",
      baseLayoutRevision: 1,
    },
    transition: "idle" as const,
    lastError: null as Error | null,
  },
  exit: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("../../workspaces/DedicatedWorkspaceController", () => ({
  dedicatedWorkspaceController: {
    subscribe: () => () => undefined,
    getSnapshot: () => mocks.snapshot,
    exit: mocks.exit,
    saveLayoutOverride: mocks.save,
    clearLayoutOverride: mocks.clear,
    dismissError: mocks.dismiss,
  },
}));

vi.mock("../../layout/useShellLayoutStore", () => ({
  useShellLayoutStore: (
    selector: (state: {
      document: { workspaceLayouts: Record<string, object> };
    }) => unknown,
  ) =>
    selector({
      document: { workspaceLayouts: { "host.fixture": {} } },
    }),
}));

import { WorkspaceChrome } from "../WorkspaceChrome";

describe("WorkspaceChrome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshot.lastError = null;
  });

  it("keeps the active subject and exit action in shell-owned chrome", () => {
    render(<WorkspaceChrome />);

    expect(screen.getByText("Fixture workspace")).toBeInTheDocument();
    expect(screen.getByText("Clip a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save workspace layout" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Clear saved workspace layout" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /exit/i }));

    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.exit).toHaveBeenCalledOnce();
  });

  it("reports a failed switch without hiding the active escape control", () => {
    mocks.snapshot.lastError = new Error("Could not prepare workspace");

    render(<WorkspaceChrome />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not prepare workspace",
    );
    expect(screen.getByRole("button", { name: /exit/i })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss workspace error" }),
    );
    expect(mocks.dismiss).toHaveBeenCalledOnce();
  });
});
