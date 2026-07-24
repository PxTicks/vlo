"""Isolated native directory picker entry point.

Tk owns this helper process's main thread, avoiding Tcl interpreter lifecycle
hazards in the ASGI server's worker threads.
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    title = sys.argv[1] if len(sys.argv) > 1 else "Choose a directory"
    try:
        import tkinter
        from tkinter import filedialog
    except ImportError:
        print("Tk is not installed", file=sys.stderr)
        return 2

    root = None
    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected = filedialog.askdirectory(parent=root, title=title, mustexist=True)
        print(json.dumps(selected or None))
        return 0
    except tkinter.TclError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    finally:
        if root is not None:
            try:
                root.destroy()
            except tkinter.TclError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
