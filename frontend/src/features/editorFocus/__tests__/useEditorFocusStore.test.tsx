import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useEditorFocusReconciler,
  useEditorFocusStore,
  useRegionFocus,
} from "..";

function FocusHarness() {
  const timelineFocusProps = useRegionFocus("timeline");
  useEditorFocusReconciler();

  return (
    <div {...timelineFocusProps}>
      <button type="button">Timeline button</button>
    </div>
  );
}

/** Two areas that own the same region, as the editor's canvas areas do. */
function SharedRegionHarness() {
  const outer = useRegionFocus("canvas");
  const inner = useRegionFocus("canvas");
  useEditorFocusReconciler();

  return (
    <div data-testid="outer" {...outer}>
      <div data-testid="inner" {...inner}>
        <button type="button">Canvas button</button>
      </div>
    </div>
  );
}

describe("useEditorFocusStore", () => {
  beforeEach(() => {
    useEditorFocusStore.getState().setRegion(null);
  });

  it("clears keyboard ownership when focus moves into portal content", () => {
    render(<FocusHarness />);
    const timelineButton = screen.getByRole("button", {
      name: "Timeline button",
    });

    fireEvent.focusIn(timelineButton);
    expect(useEditorFocusStore.getState().region).toBe("timeline");

    const portalButton = document.createElement("button");
    portalButton.textContent = "Portal button";
    document.body.appendChild(portalButton);

    try {
      fireEvent.focusIn(portalButton);
      expect(useEditorFocusStore.getState().region).toBeNull();
    } finally {
      portalButton.remove();
    }
  });

  it("releases ownership only for the claimant that still holds it", () => {
    render(<SharedRegionHarness />);
    const outer = screen.getByTestId("outer");
    const inner = screen.getByTestId("inner");

    // Capture runs outside-in, so the inner area's claim lands last.
    fireEvent.pointerDown(inner);
    expect(useEditorFocusStore.getState()).toMatchObject({
      region: "canvas",
      claimant: inner,
    });

    // The outer area's claim was superseded; letting it release by region name
    // would disable canvas shortcuts the inner area legitimately owns.
    useEditorFocusStore.getState().releaseRegion(outer);
    expect(useEditorFocusStore.getState().region).toBe("canvas");

    useEditorFocusStore.getState().releaseRegion(inner);
    expect(useEditorFocusStore.getState()).toMatchObject({
      region: null,
      claimant: null,
    });
  });

  it("keeps the claim with its region root when focus moves inside it", () => {
    render(<SharedRegionHarness />);
    const inner = screen.getByTestId("inner");

    fireEvent.pointerDown(inner);
    // Real DOM focus landing on a descendant re-asserts the same area's claim
    // rather than replacing it with an anonymous one, so the area can still
    // release its own ownership afterwards.
    fireEvent.focusIn(screen.getByRole("button", { name: "Canvas button" }));
    expect(useEditorFocusStore.getState().claimant).toBe(inner);

    useEditorFocusStore.getState().releaseRegion(inner);
    expect(useEditorFocusStore.getState().region).toBeNull();
  });

  it("cannot be released by a claimant when nobody identified themselves", () => {
    useEditorFocusStore.getState().setRegion("timeline");

    useEditorFocusStore.getState().releaseRegion({});
    expect(useEditorFocusStore.getState().region).toBe("timeline");
  });
});
