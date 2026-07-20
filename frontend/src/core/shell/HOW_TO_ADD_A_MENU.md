# Adding a host menu

All application menus use the descriptor pipeline so host and extension items
share one registered → resolved → rendered boundary.

1. Add a dotted menu ID, typed detached subject, validator, and serialisable
   subject schema to `hostMenus.ts`. Keep the subject small and stable: it is a
   public discovery and condition contract, not a component-state dump.
2. Describe host items with `HostMenuItemDescriptor`. Prefer `kind: "command"`
   for reusable application operations. Use `kind: "action"` only for local UI
   state or ephemeral interaction that is not a sensible command.
3. Render anchored menus with `AppMenu`; open pointer-positioned context menus
   with `useHostContextMenu`. Do not import MUI `Menu` or `MenuList` at a call
   site.
4. Put items into stable, documented groups. Extensions append command
   placements to these groups; they cannot remove or replace host items.
5. Add parity tests for host actions, subject validation, selected/disabled
   state, closure after selection, and at least one contributed placement when
   the surface is intended for extensions.
6. Classify a new call site in `.gitattributes` as `extension-surface=adapter`
   and run `npm run check:extension-surface` plus the relevant frontend tests.

Public extension menu items remain declarative command placements. Do not add
callbacks to the SDK to solve dynamic labels or visibility; the separately
documented trusted dynamic-presentation escape hatch is the future path if the
declarative condition model proves insufficient.

