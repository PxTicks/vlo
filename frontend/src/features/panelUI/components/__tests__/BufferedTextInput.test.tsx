import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BufferedTextInput, CommittedTextInput } from "../BufferedTextInput";

describe("CommittedTextInput", () => {
  it("does not re-commit the same draft before the parent updates", () => {
    const handleCommit = vi.fn();

    render(
      <CommittedTextInput
        initialValue=""
        onCommit={handleCommit}
        placeholder="Enter prompt..."
      />,
    );

    const input = screen.getByPlaceholderText("Enter prompt...");

    fireEvent.change(input, { target: { value: "draft prompt" } });
    fireEvent.blur(input);
    fireEvent.blur(input);

    expect(handleCommit).toHaveBeenCalledTimes(1);
    expect(handleCommit).toHaveBeenCalledWith("draft prompt");
  });
});

describe("commitDebounceMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits a typing pause without waiting for blur", () => {
    const handleCommit = vi.fn();

    render(
      <CommittedTextInput
        initialValue=""
        onCommit={handleCommit}
        commitDebounceMs={250}
        placeholder="Enter prompt..."
      />,
    );

    const input = screen.getByPlaceholderText("Enter prompt...");
    fireEvent.change(input, { target: { value: "a prompt" } });
    expect(handleCommit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(handleCommit).toHaveBeenCalledTimes(1);
    expect(handleCommit).toHaveBeenCalledWith("a prompt");
  });

  it("only commits the final value of an uninterrupted run of keystrokes", () => {
    const handleCommit = vi.fn();

    render(
      <CommittedTextInput
        initialValue=""
        onCommit={handleCommit}
        commitDebounceMs={250}
        placeholder="Enter prompt..."
      />,
    );

    const input = screen.getByPlaceholderText("Enter prompt...");
    for (const value of ["a", "ab", "abc"]) {
      fireEvent.change(input, { target: { value } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }

    expect(handleCommit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(handleCommit).toHaveBeenCalledTimes(1);
    expect(handleCommit).toHaveBeenCalledWith("abc");
  });

  it("does not re-commit on the blur that follows a debounced commit", () => {
    const handleCommit = vi.fn();

    render(
      <CommittedTextInput
        initialValue=""
        onCommit={handleCommit}
        commitDebounceMs={250}
        placeholder="Enter prompt..."
      />,
    );

    const input = screen.getByPlaceholderText("Enter prompt...");
    fireEvent.change(input, { target: { value: "a prompt" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    fireEvent.blur(input);

    expect(handleCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps keystrokes that land while a debounced commit is in flight", () => {
    const handleCommit = vi.fn();

    function Host() {
      const [value, setValue] = useState("");
      return (
        <BufferedTextInput
          value={value}
          onCommit={(next) => {
            handleCommit(next);
            setValue(next);
          }}
          commitDebounceMs={250}
          placeholder="Enter prompt..."
        />
      );
    }

    render(<Host />);

    const input = screen.getByPlaceholderText("Enter prompt...");
    fireEvent.change(input, { target: { value: "abc" } });
    act(() => {
      // The keystroke lands in the same batch as the debounced commit, so the
      // parent's echo of "abc" arrives after the field already holds "abcd".
      // That echo must not roll the field back.
      vi.advanceTimersByTime(250);
      fireEvent.change(input, { target: { value: "abcd" } });
    });

    expect((input as HTMLInputElement).value).toBe("abcd");

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(handleCommit).toHaveBeenLastCalledWith("abcd");
  });

  it("still waits for blur when no debounce is configured", () => {
    const handleCommit = vi.fn();

    render(
      <CommittedTextInput
        initialValue=""
        onCommit={handleCommit}
        placeholder="Enter prompt..."
      />,
    );

    const input = screen.getByPlaceholderText("Enter prompt...");
    fireEvent.change(input, { target: { value: "a prompt" } });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(handleCommit).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(handleCommit).toHaveBeenCalledWith("a prompt");
  });
});
