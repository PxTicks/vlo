import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
} from "@mui/material";
import type { TextRun } from "../../../types/TimelineTypes";
import {
  mergeAdjacentRuns,
  runsToHtml,
} from "../../text/utils/textClipData";

export interface RichTextInputProps {
  label?: string;
  initialValue: TextRun[];
  onCommit: (runs: TextRun[]) => void;
  onPreview?: (runs: TextRun[]) => void;
  onEditEnd?: () => void;
  placeholder?: string;
  minRows?: number;
  disabled?: boolean;
  sx?: SxProps<Theme>;
}

function runsEqual(a: TextRun[], b: TextRun[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].text !== b[i].text ||
      Boolean(a[i].bold) !== Boolean(b[i].bold) ||
      Boolean(a[i].italic) !== Boolean(b[i].italic)
    ) {
      return false;
    }
  }
  return true;
}

interface ActiveAttrs {
  bold: boolean;
  italic: boolean;
}

const BLOCK_TAGS = new Set(["div", "p"]);

function isElementBold(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "b" || tag === "strong") {
    return true;
  }
  const weight = el.style.fontWeight;
  if (weight === "bold") {
    return true;
  }
  const parsed = Number.parseInt(weight, 10);
  return Number.isFinite(parsed) && parsed >= 600;
}

function isElementItalic(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "i" || tag === "em") {
    return true;
  }
  return el.style.fontStyle === "italic";
}

function pushRun(runs: TextRun[], text: string, attrs: ActiveAttrs): void {
  if (text.length === 0) {
    return;
  }
  const run: TextRun = { text };
  if (attrs.bold) {
    run.bold = true;
  }
  if (attrs.italic) {
    run.italic = true;
  }
  runs.push(run);
}

export function domToRuns(root: Node): TextRun[] {
  const runs: TextRun[] = [];

  function appendNewline(attrs: ActiveAttrs): void {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.text.endsWith("\n")) {
      return;
    }
    pushRun(runs, "\n", attrs);
  }

  function walk(node: Node, attrs: ActiveAttrs, isFirstBlock: boolean): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      pushRun(runs, node.textContent ?? "", attrs);
      return false;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return isFirstBlock;
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === "br") {
      pushRun(runs, "\n", attrs);
      return false;
    }

    const nextAttrs: ActiveAttrs = {
      bold: attrs.bold || isElementBold(el),
      italic: attrs.italic || isElementItalic(el),
    };

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock && !isFirstBlock && runs.length > 0) {
      appendNewline(attrs);
    }

    let nextIsFirstBlock = isBlock ? false : isFirstBlock;
    for (const child of Array.from(el.childNodes)) {
      nextIsFirstBlock = walk(child, nextAttrs, nextIsFirstBlock);
    }
    return nextIsFirstBlock;
  }

  walk(root, { bold: false, italic: false }, true);

  while (runs.length > 0 && runs[runs.length - 1].text === "\n") {
    runs.pop();
  }

  return mergeAdjacentRuns(runs);
}

function RichTextInputComponent({
  label,
  initialValue,
  onCommit,
  onPreview,
  onEditEnd,
  placeholder,
  minRows = 4,
  disabled,
  sx,
}: RichTextInputProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastCommittedRef = useRef<TextRun[]>(initialValue);
  const lastEmittedRef = useRef<TextRun[]>(initialValue);

  useLayoutEffect(() => {
    if (editorRef.current === null) {
      return;
    }
    editorRef.current.innerHTML = runsToHtml(initialValue);
    // We intentionally only initialize once. External changes flow through
    // `initialValue` re-mounts driven by the parent (key/clip id), not by edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readRuns = useCallback((): TextRun[] => {
    if (editorRef.current === null) {
      return [];
    }
    return domToRuns(editorRef.current);
  }, []);

  const emitPreview = useCallback((): TextRun[] => {
    const runs = readRuns();
    if (!runsEqual(runs, lastEmittedRef.current)) {
      lastEmittedRef.current = runs;
      onPreview?.(runs);
    }
    return runs;
  }, [onPreview, readRuns]);

  const handleInput = useCallback(() => {
    emitPreview();
  }, [emitPreview]);

  const handleBlur = useCallback(() => {
    const runs = readRuns();
    if (!runsEqual(runs, lastCommittedRef.current)) {
      lastCommittedRef.current = runs;
      onCommit(runs);
    }
    onEditEnd?.();
  }, [onCommit, onEditEnd, readRuns]);

  const runCommand = useCallback(
    (command: "bold" | "italic") => {
      if (disabled || editorRef.current === null) {
        return;
      }
      editorRef.current.focus();
      // execCommand is deprecated but remains the simplest cross-browser way to
      // toggle bold/italic on the current selection inside a contenteditable.
      document.execCommand(command);
      emitPreview();
    },
    [disabled, emitPreview],
  );

  // Block accidental rich-text paste; coerce to plain text so we don't import
  // arbitrary inline styles from external sources.
  useEffect(() => {
    const node = editorRef.current;
    if (node === null) {
      return undefined;
    }
    const handlePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.length > 0) {
        document.execCommand("insertText", false, text);
      }
    };
    node.addEventListener("paste", handlePaste);
    return () => {
      node.removeEventListener("paste", handlePaste);
    };
  }, []);

  return (
    <Box sx={sx}>
      {label !== undefined ? (
        <Typography
          variant="caption"
          sx={{ display: "block", mb: 0.5, color: "#a1a1aa" }}
        >
          {label}
        </Typography>
      ) : null}
      <Box sx={{ display: "flex", gap: 0.5, mb: 0.75 }}>
        <Tooltip title="Bold (Ctrl+B)">
          <span>
            <IconButton
              size="small"
              aria-label="Bold"
              onMouseDown={(event) => {
                event.preventDefault();
                runCommand("bold");
              }}
              disabled={disabled}
              sx={{ fontWeight: 700 }}
            >
              B
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Italic (Ctrl+I)">
          <span>
            <IconButton
              size="small"
              aria-label="Italic"
              onMouseDown={(event) => {
                event.preventDefault();
                runCommand("italic");
              }}
              disabled={disabled}
              sx={{ fontStyle: "italic" }}
            >
              I
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={label ?? "Rich text editor"}
        data-placeholder={placeholder ?? ""}
        contentEditable={!disabled}
        suppressContentEditableWarning={true}
        onInput={handleInput}
        onBlur={handleBlur}
        sx={{
          minHeight: `${minRows * 1.5}em`,
          maxHeight: "20em",
          overflowY: "auto",
          padding: "8.5px 14px",
          border: "1px solid",
          borderColor: "rgba(255, 255, 255, 0.23)",
          borderRadius: 1,
          outline: "none",
          fontSize: "0.875rem",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: disabled ? "rgba(255, 255, 255, 0.4)" : "#f4f4f5",
          backgroundColor: disabled ? "transparent" : "transparent",
          "&:hover": {
            borderColor: disabled ? undefined : "rgba(255, 255, 255, 0.4)",
          },
          "&:focus": {
            borderColor: "primary.main",
            borderWidth: "2px",
            padding: "7.5px 13px",
          },
          "&:empty::before": {
            content: "attr(data-placeholder)",
            color: "rgba(255, 255, 255, 0.4)",
            pointerEvents: "none",
          },
        }}
      />
    </Box>
  );
}

export const RichTextInput = memo(RichTextInputComponent);
