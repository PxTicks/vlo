# Minimal vlo extension

This directory is the official SDK 1 starting point for a trusted extension with
both frontend and backend entry points.

## Use the template

1. Copy this directory next to `packages/extension-sdk/`, or replace the local
   `@vlo/extension-sdk` dependency with the published package when one exists.
2. Change the package directory name and `manifest.json` ID together. IDs use
   lowercase letters, numbers, dots, underscores, and hyphens.
3. Run `npm install`, then `npm run build`.
4. Copy the package into vlo's configured extension root.
5. Review and approve its exact digest in the extension manager. Backend activation
   occurs after a backend restart; frontend activation occurs on the following page
   load after the matching backend digest reports active.

The build writes immutable browser artifacts to `frontend/dist/`. Do not edit that
directory by hand; rebuild it before approval.

## SDK 1 boundaries

- `@vlo/extension-sdk` is type-only. Import it with `import type`; runtime access is
  supplied through the host-owned activation context.
- The host context currently exposes opaque payload providers, labelled timeline
  transactions, declarative host-filter transformations, and native notice slots.
  Rendering new entity types, arbitrary React/Pixi contributions, animation/path
  strategies, and backend jobs arrive in later SDK phases.
- React, React DOM, MUI/emotion, Zustand, and Pixi are host singletons. SDK 1 has no
  portable runtime mapping for them, so the template build rejects those imports
  instead of bundling duplicate copies or emitting unresolved bare imports.
- That bundle guard belongs to this template, not the host approval boundary. A
  hand-written build can bypass it, but may then fail at activation or silently load
  incompatible singleton copies. Host-side bundle validation is future work.
- The backend is trusted in-process Python. Keep `create_extension` lightweight;
  defer model loading and long work to requests or future job APIs.
- Backend SDK 1 deliberately imports the host's supported `services.extensions`
  barrel. Do not import its deeper internal modules; a standalone Python authoring
  package does not exist yet.
- Backend staging contains only this package's `backend/` subtree. Put Python
  runtime resources below `backend/`, not in a sibling directory.
- Capability declarations are visible trust metadata, not enforced permissions.

The `/status` backend route is mounted by the host at
`/app/extensions/<extension-id>/api/status`. Remove it when replacing the template
with a real extension contract.
