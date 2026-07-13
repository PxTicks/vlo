# Trusted host access conformance fixture

This fixture targets VLO `>=0.2.0 <0.3.0`. It deliberately uses raw live host
entries and a deeper backend import to prove the trusted fallback composes with a
normal owner-scoped UI contribution.

The timeline-toolbar component subscribes to the canonical timeline store. Its
button applies a benign marker property to the live playback clock through
`patchProperty`; deactivation removes it. The fixture also discards and re-resolves
`renderer.runtime` on every directory revision. Its backend reads the internal host
version and removes an installed logging filter during shutdown.

This is a conformance package, not a recommendation to prefer mutation when a
scoped contract already fits.
