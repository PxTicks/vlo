import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionApiScope, ExtensionResource } from "../..";
import { ExtensionUiSlot } from "../ExtensionUiSlot";
import {
  ExtensionUiSlotRegistry,
  extensionUiSlotRegistry,
} from "../ExtensionUiSlotRegistry";

function createScope(
  extensionId: string,
  report: ExtensionApiScope["report"] = vi.fn(),
): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report,
  };
}

describe("ExtensionUiSlot", () => {
  it("reacts to owner-scoped native notice registration and disposal", () => {
    render(<ExtensionUiSlot slot="transformation-panel.before" />);
    expect(
      screen.queryByTestId(
        "extension-ui-contribution-example.color-grade/grade-help",
      ),
    ).not.toBeInTheDocument();

    let registration:
      | ReturnType<
          ReturnType<typeof extensionUiSlotRegistry.bind>["registerNotice"]
        >
      | undefined;
    act(() => {
      registration = extensionUiSlotRegistry
        .bind(createScope("example.color-grade"))
        .registerNotice({
          id: "grade-help",
          apiVersion: 1,
          slot: "transformation-panel.before",
          kind: "notice",
          title: "Film Grade",
          message: "Apply a host-rendered grade from the Add Transformation menu.",
          tone: "info",
        });
    });

    expect(
      screen.getByTestId(
        "extension-ui-contribution-example.color-grade/grade-help",
      ),
    ).toHaveTextContent("Film Grade");

    act(() => registration?.dispose());
    expect(
      screen.queryByTestId(
        "extension-ui-contribution-example.color-grade/grade-help",
      ),
    ).not.toBeInTheDocument();
  });

  it("validates slot metadata before registration", () => {
    const registry = new ExtensionUiSlotRegistry();
    const api = registry.bind(createScope("example.ui"));

    expect(() =>
      api.registerNotice({
        id: "empty-message",
        apiVersion: 1,
        slot: "transformation-panel.before",
        kind: "notice",
        title: "Title",
        message: "",
      }),
    ).toThrow(/message must be a non-empty string/);
    expect(registry.list("transformation-panel.before")).toEqual([]);
  });

  it("renders and isolates trusted React component contributions", () => {
    const report = vi.fn();
    const registration = extensionUiSlotRegistry
      .bind(createScope("example.react", report))
      .registerComponent({
        id: "custom-panel",
        apiVersion: 1,
        slot: "transformation-panel.before",
        kind: "trusted-react",
        component: () => <button type="button">Custom extension control</button>,
      });

    render(<ExtensionUiSlot slot="transformation-panel.before" />);
    expect(
      screen.getByRole("button", { name: "Custom extension control" }),
    ).toBeInTheDocument();

    act(() => registration.dispose());
    expect(
      screen.queryByRole("button", { name: "Custom extension control" }),
    ).not.toBeInTheDocument();
    expect(report).not.toHaveBeenCalled();
  });

  it("contains trusted component render failures", () => {
    const report = vi.fn();
    const registration = extensionUiSlotRegistry
      .bind(createScope("example.broken-react", report))
      .registerComponent({
        id: "broken-panel",
        apiVersion: 1,
        slot: "transformation-panel.before",
        kind: "trusted-react",
        component: () => {
          throw new Error("component failed");
        },
      });

    render(<ExtensionUiSlot slot="transformation-panel.before" />);

    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("example.broken-react/broken-panel"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
    registration.dispose();
  });
});
