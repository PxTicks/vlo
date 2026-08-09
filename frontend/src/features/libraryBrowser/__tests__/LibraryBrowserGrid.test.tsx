import { createRef } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  LibraryBrowserGrid,
  type LibraryBrowserGridApi,
} from "../LibraryBrowserGrid";

interface TestItem {
  id: string;
  label: string;
}

function makeItems(count: number): TestItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    label: `Item ${index}`,
  }));
}

function renderGrid(
  props: Partial<React.ComponentProps<typeof LibraryBrowserGrid<TestItem>>> & {
    items: readonly TestItem[];
  },
) {
  return render(
    <LibraryBrowserGrid<TestItem>
      getItemId={(item) => item.id}
      renderItem={(item) => <div>{item.label}</div>}
      emptyMessage="Nothing here"
      itemTestId="grid-cell"
      {...props}
    />,
  );
}

describe("LibraryBrowserGrid", () => {
  it("shows the empty message when there are no items", () => {
    renderGrid({ items: [] });
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("renders items two-per-row with stable item ids", () => {
    renderGrid({ items: makeItems(4) });

    expect(screen.getByText("Item 0")).toBeInTheDocument();
    expect(screen.getByText("Item 3")).toBeInTheDocument();
    expect(
      document.querySelector('[data-library-item-id="item-2"]'),
    ).not.toBeNull();
  });

  it("stays shrinkable so overflowing items scroll inside a flex panel", () => {
    renderGrid({ items: makeItems(4) });

    expect(
      globalThis.getComputedStyle(
        screen.getByTestId("library-browser-scroll-region"),
      ),
    ).toMatchObject({ minHeight: "0", overflowY: "auto" });
  });

  it("pads the final row with a filler when the item count is odd", () => {
    renderGrid({ items: makeItems(3) });

    // 3 items + 1 filler cell to keep column widths consistent.
    const cells = document.querySelectorAll('[data-testid="grid-cell"]');
    expect(cells).toHaveLength(3);
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("forwards background clicks", () => {
    const onBackgroundClick = vi.fn();
    renderGrid({ items: makeItems(2), onBackgroundClick });

    fireEvent.click(screen.getByTestId("library-browser-scroll-region"));
    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
  });

  it("reflects the scroll-locked flag", () => {
    renderGrid({ items: makeItems(2), isScrollLocked: true });
    expect(
      screen.getByTestId("library-browser-scroll-region"),
    ).toHaveAttribute("data-scroll-locked", "true");
  });

  it("exposes scrollToItemId via the imperative api", () => {
    const apiRef = createRef<LibraryBrowserGridApi>();
    renderGrid({ items: makeItems(20), apiRef });

    expect(apiRef.current).not.toBeNull();
    // Unknown ids are a no-op rather than throwing.
    expect(() => apiRef.current?.scrollToItemId("missing")).not.toThrow();
    expect(() => apiRef.current?.scrollToItemId("item-18")).not.toThrow();
  });
});
