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

  describe("marquee selection", () => {
    // jsdom has no layout, so give the scroll region a width (two 176px
    // columns at x 16-192 and 208-384) and enough content height to drag in.
    // The test setup measures every row at 2000px, so row 1 starts at y 2032.
    function sizeScrollRegion() {
      const scrollRegion = screen.getByTestId("library-browser-scroll-region");
      Object.defineProperty(scrollRegion, "clientWidth", {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(scrollRegion, "scrollHeight", {
        configurable: true,
        value: 5000,
      });
      return scrollRegion;
    }

    function drag(
      startTarget: Element,
      from: { x: number; y: number },
      to: { x: number; y: number },
      init: { ctrlKey?: boolean } = {},
    ) {
      fireEvent.pointerDown(startTarget, {
        pointerId: 1,
        clientX: from.x,
        clientY: from.y,
        ...init,
      });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: to.x, clientY: to.y });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: to.x, clientY: to.y });
      fireEvent.click(startTarget);
    }

    it("reports the items under a drag started from empty space", () => {
      const onStart = vi.fn();
      const onChange = vi.fn();
      const onEnd = vi.fn();
      const onBackgroundClick = vi.fn();
      renderGrid({
        items: makeItems(4),
        marquee: { onStart, onChange, onEnd },
        onBackgroundClick,
      });
      const scrollRegion = sizeScrollRegion();

      drag(scrollRegion, { x: 2, y: 2 }, { x: 100, y: 3000 }, { ctrlKey: true });

      expect(onStart).toHaveBeenCalledWith({ additive: true });
      expect(onChange).toHaveBeenLastCalledWith(["item-0", "item-2"]);
      expect(onEnd).toHaveBeenCalledTimes(1);
      // The release click must not be treated as a background click.
      expect(onBackgroundClick).not.toHaveBeenCalled();
      expect(screen.getByTestId("library-browser-marquee")).toHaveStyle({
        display: "none",
      });
    });

    it("commits the marquee at the release point, not the last move", () => {
      const onChange = vi.fn();
      renderGrid({ items: makeItems(4), marquee: { onChange } });
      const scrollRegion = sizeScrollRegion();

      fireEvent.pointerDown(scrollRegion, { pointerId: 1, clientX: 2, clientY: 2 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 100 });
      expect(onChange).toHaveBeenLastCalledWith(["item-0"]);

      // Released over the second column with no intervening move.
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 3000 });
      expect(onChange).toHaveBeenLastCalledWith([
        "item-0",
        "item-1",
        "item-2",
        "item-3",
      ]);
    });

    it("starts from a filler slot", () => {
      const onChange = vi.fn();
      renderGrid({ items: makeItems(3), marquee: { onChange } });
      sizeScrollRegion();

      const filler = document.querySelector('[aria-hidden="true"]');
      drag(filler as Element, { x: 300, y: 3000 }, { x: 0, y: 0 });

      expect(onChange).toHaveBeenLastCalledWith(["item-0", "item-1", "item-2"]);
    });

    it("leaves presses on an item and sub-threshold clicks alone", () => {
      const onChange = vi.fn();
      const onBackgroundClick = vi.fn();
      renderGrid({
        items: makeItems(4),
        marquee: { onChange },
        onBackgroundClick,
      });
      const scrollRegion = sizeScrollRegion();

      drag(screen.getByText("Item 0"), { x: 50, y: 50 }, { x: 300, y: 3000 });
      expect(onChange).not.toHaveBeenCalled();

      drag(scrollRegion, { x: 2, y: 2 }, { x: 4, y: 3 });
      expect(onChange).not.toHaveBeenCalled();
      expect(onBackgroundClick).toHaveBeenCalledTimes(2);
    });

    it("ignores presses on the scrollbar gutter", () => {
      const onChange = vi.fn();
      renderGrid({ items: makeItems(4), marquee: { onChange } });
      const scrollRegion = sizeScrollRegion();

      drag(scrollRegion, { x: 405, y: 2 }, { x: 0, y: 3000 });
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
