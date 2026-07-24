import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NestedMenuTree, type NestedMenuLeaf } from "../NestedMenuTree";
import type { MenuTreeLayout } from "../../../../core/shell/menuTree";

const LAYOUT: MenuTreeLayout = {
  nodes: [
    {
      id: "image",
      kind: "category",
      label: "Image",
      parentId: null,
      order: 0,
    },
    {
      id: "image.generate",
      kind: "folder",
      label: "Generate",
      parentId: "image",
      order: 0,
    },
    {
      id: "empty",
      kind: "folder",
      label: "Empty",
      parentId: null,
      order: 1,
    },
  ],
  leafPlacements: [
    { leafId: "flux", parentId: "image.generate", order: 0 },
    { leafId: "other", parentId: null, order: 2 },
  ],
};

const LEAVES: NestedMenuLeaf[] = [
  { id: "flux", label: "Flux" },
  { id: "other", label: "Other workflow" },
];

function renderTree(
  overrides: Partial<React.ComponentProps<typeof NestedMenuTree<NestedMenuLeaf>>> = {},
) {
  const onLeafActivate = vi.fn();
  const onSave = vi.fn(async (_layout: MenuTreeLayout) => true);
  const onReset = vi.fn(async () => true);
  render(
    <NestedMenuTree
      ariaLabel="Generation workflows"
      layout={LAYOUT}
      defaultLayout={LAYOUT}
      leaves={LEAVES}
      selectedLeafId={null}
      onLeafActivate={onLeafActivate}
      onSave={onSave}
      onReset={onReset}
      {...overrides}
    />,
  );
  return { onLeafActivate, onSave, onReset };
}

describe("NestedMenuTree", () => {
  it("flattens categories, navigates folders, and keeps selection in place", () => {
    const { onLeafActivate } = renderTree();

    expect(screen.getByRole("heading", { name: "Image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Other" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Empty/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Generate/ }));
    fireEvent.click(screen.getByRole("button", { name: "Flux" }));
    expect(onLeafActivate).toHaveBeenCalledWith(LEAVES[0]);
    expect(screen.getByRole("button", { name: "Flux" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to previous menu" }),
    ).toBeInTheDocument();
  });

  it("shows empty nodes in edit mode and cancels a draft", async () => {
    const { onSave } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("button", { name: "Empty" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Folder" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My folder" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "My folder" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: /My folder/ })).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renames nodes, prevents non-empty deletion, and saves once on Done", async () => {
    const { onSave } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("button", { name: "Delete Image" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Rename Image" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Pictures" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Pictures" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].nodes).toContainEqual(
      expect.objectContaining({ id: "image", label: "Pictures" }),
    );
  });

  it("stages a confirmed reset and applies it through Done", async () => {
    const { onSave, onReset } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Reset menu to defaults?" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("retains the draft and reports save failures", async () => {
    const onSave = vi.fn(async () => false);
    renderTree({
      onSave,
      persistenceError: "Could not save menu",
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.getByText("Could not save menu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });
});
