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
});
