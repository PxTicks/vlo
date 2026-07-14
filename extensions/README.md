# Extensions directory

VLO scans only `extensions/installed/` for runtime packages. Put each approved
extension or declarative look pack in its own directory there:

```text
extensions/
├── installed/                 # runtime package discovery root
│   ├── example.extension/
│   └── example.look-pack/
└── extension-development/     # Codex authoring skill; never runtime-scanned
```

The separation is intentional: development tooling, notes, and templates can
live beside installed packages without appearing as invalid extensions. Set
`VLO_EXTENSIONS_ROOT` to override the `installed/` discovery root.

After upgrading from the legacy layout, move each package that was directly
under `extensions/` into `extensions/installed/`; the host does not silently
scan both layouts because that would make development folders ambiguous again.

Look packs remain ordinary digest-approved packages, but may be declarative and
contain no executable entry point. Applying a look copies its `.cube` bytes into
the active project; projects never depend on this directory remaining present.
