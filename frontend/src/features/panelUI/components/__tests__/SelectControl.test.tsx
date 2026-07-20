import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostOptionCatalog } from "../../../../core/shell/optionCatalog";
import type { ShellDisposable } from "../../../../core/shell/hostMenuCatalog";
import { SelectControl } from "../SelectControl";
import type { ControlDefinition } from "../../types";

const cleanups: ShellDisposable[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup.dispose();
});

function declareSortModes() {
  cleanups.push(
    hostOptionCatalog.declare({
      id: "test.select-control.modes",
      validateValue: (value) => typeof value === "object" && value !== null,
      valueSchema: { field: "string" },
    }),
  );
  cleanups.push(
    hostOptionCatalog.registerHostOption("test.select-control.modes", {
      id: "host-mode",
      label: "Host Mode",
      value: { field: "name" },
    }),
  );
  cleanups.push(
    hostOptionCatalog.registerContributedOption("test.select-control.modes", {
      id: "example.ext/tag-mode",
      label: "By Tag",
      value: { field: "tag" },
    }),
  );
}

const CATALOGUE_CONTROL: ControlDefinition = {
  type: "select",
  label: "Mode",
  name: "mode",
  options: [{ label: "Static", value: "static" }],
  catalogueId: "test.select-control.modes",
};

function openSelect() {
  fireEvent.mouseDown(screen.getByRole("combobox"));
  return within(screen.getByRole("listbox"));
}

describe("SelectControl catalogue integration", () => {
  it("merges catalogue options after static options and commits option IDs", () => {
    declareSortModes();
    const onCommit = vi.fn();
    render(
      <SelectControl
        control={CATALOGUE_CONTROL}
        value="static"
        onCommit={onCommit}
      />,
    );

    const listbox = openSelect();
    expect(
      listbox.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Static", "Host Mode", "By Tag"]);

    fireEvent.click(listbox.getByRole("option", { name: "By Tag" }));
    expect(onCommit).toHaveBeenCalledWith({
      catalogueId: "test.select-control.modes",
      optionId: "example.ext/tag-mode",
      value: { field: "tag" },
    });
  });

  it("re-renders when catalogue options register after mount", () => {
    declareSortModes();
    render(
      <SelectControl
        control={CATALOGUE_CONTROL}
        value="static"
        onCommit={vi.fn()}
      />,
    );
    cleanups.push(
      hostOptionCatalog.registerHostOption("test.select-control.modes", {
        id: "late-mode",
        label: "Late Mode",
        value: { field: "late" },
      }),
    );
    const listbox = openSelect();
    expect(listbox.getByRole("option", { name: "Late Mode" })).toBeInTheDocument();
  });

  it("shows a stored value whose option is missing as a disabled entry, preserving it", () => {
    declareSortModes();
    render(
      <SelectControl
        control={CATALOGUE_CONTROL}
        value={{
          catalogueId: "test.select-control.modes",
          optionId: "example.gone/old-mode",
          value: { field: "gone" },
        }}
        onCommit={vi.fn()}
      />,
    );

    // The stored value stays selected and visible rather than being remapped.
    expect(screen.getByRole("combobox")).toHaveTextContent(
      "Missing: example.gone/old-mode",
    );
    const listbox = openSelect();
    const missing = listbox.getByRole("option", {
      name: "Missing: example.gone/old-mode",
    });
    expect(missing).toHaveAttribute("aria-disabled", "true");
  });
});
