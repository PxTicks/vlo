# Tagging storage conformance fixture

This trusted fixture proves the Phase C path end to end: its backend job
derives deterministic tags from the current asset catalogue, its frontend
writes the resulting index to `storage.project`, and its panel subscribes to
that key/value scope so persisted tag changes render without polling.
