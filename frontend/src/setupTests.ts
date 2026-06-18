import "@testing-library/jest-dom";
import "fake-indexeddb/auto";

// Polyfill crypto.randomUUID
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: {},
    writable: true,
  });
}

if (!globalThis.crypto.randomUUID) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => `test-uuid-${Math.random().toString(36).substring(7)}`,
    writable: true,
  });
}

// jsdom has no layout engine: every element reports a 0x0 rect. The virtualized
// LibraryBrowserGrid (@tanstack/react-virtual) would then mount no rows, breaking
// the many tests that assert specific cards are present. Give elements a generous
// non-zero size so the virtualizer renders the whole list under test, and polyfill
// ResizeObserver (used by measureElement).
if (!globalThis.ResizeObserver) {
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverMock,
    writable: true,
    configurable: true,
  });
}

const VIRTUAL_TEST_VIEWPORT_PX = 2000;

if (
  typeof HTMLElement !== "undefined" &&
  !Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")?.get
) {
  for (const dimension of ["clientHeight", "offsetHeight", "scrollHeight"]) {
    Object.defineProperty(HTMLElement.prototype, dimension, {
      configurable: true,
      get() {
        return VIRTUAL_TEST_VIEWPORT_PX;
      },
    });
  }
  for (const dimension of ["clientWidth", "offsetWidth", "scrollWidth"]) {
    Object.defineProperty(HTMLElement.prototype, dimension, {
      configurable: true,
      get() {
        return VIRTUAL_TEST_VIEWPORT_PX;
      },
    });
  }

  // @tanstack/react-virtual reads the scroll element rect and measures rows via
  // getBoundingClientRect(); jsdom returns all-zero, so give it the viewport size.
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: VIRTUAL_TEST_VIEWPORT_PX,
      bottom: VIRTUAL_TEST_VIEWPORT_PX,
      width: VIRTUAL_TEST_VIEWPORT_PX,
      height: VIRTUAL_TEST_VIEWPORT_PX,
      toJSON: () => ({}),
    } as DOMRect;
  };
}