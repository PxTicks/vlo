# LoRA loader policy conformance fixture

This fixture targets VLO SDK `>=1.15.0`. It is the committed first consumer of
the generation extension surface
(`docs/generation-extension-surface-plan.md`), and it exists to prove that a
trusted policy extension can be written entirely out of tree: no host store, no
iframe object, no backend module, and no generation-specific panel API.

What it does, and why each part is shaped that way:

- **Discovery is class *and* widget.** A loader is a node whose `classType`
  starts with `loraloader` *and* which exposes an unlinked `lora_name` widget
  with enum options. The session snapshot carries no links, so the fixture
  cannot claim to know which loaders are actually wired into the sampled model
  — and it does not pretend to. Nodes the user has already muted or bypassed
  are skipped rather than silently re-enabled.

- **The model list comes from the host.** Options are the ones the widget's own
  metadata publishes, so the fixture never ships or fetches a model catalogue.

- **`None` is extension-local.** A loader's enum lists model files, so "no
  LoRA" is not a value any widget accepts. It is UI state that selects the
  *bypass* plan at submission; writing it into a widget would be refused by the
  host, correctly.

- **A widget write happens only when the user picks a model.** If the panel
  renders a control for that widget (`editable`), the choice is applied
  immediately through the labelled transaction, so the user sees it in the
  panel. If it does not, nothing is written now and the status line says so —
  reaching a widget with no control is what a submission effect is for.

- **The submission contributor is the authority on what is generated.** It runs
  once per submission, plans only from the session it is handed, and drops any
  selection that session no longer supports (node gone, model no longer
  offered). A contribution is all-or-nothing, so contributing something it is
  unsure of would fail the user's whole generation.

- **Choices are scoped to the workflow they were made in.** Node ids are unique
  within a workflow, not across workflows, so the panel and the contributor read
  the same scoped map: a control can never display a choice that would not be
  contributed. A workflow with no source id is identified by its ComfyUI
  instance, and the `null` the bridge reports before it answers counts as "not
  yet known" rather than as a different workflow, so a choice made in that gap
  survives identity arriving.

- **The plan stays inside the host's bounds by construction.** Bypass targets
  are packed into as few effects as the per-effect limit allows, and the panel
  declines a selection that would take the plan past the 64-effect limit,
  saying so. An over-budget contribution is refused whole by the host, which
  would cost the user a generation over something the panel could simply have
  refused to accept.

Its conformance suite is
`frontend/src/features/extensions/generation/__tests__/LoraPolicyConformance.test.tsx`,
which drives the fixture through the real extension host, the real generation
adapter, the real UI slot, and the real ComfyUI bridge — including root and
scoped subgraph targets, sibling-instance isolation, stale revisions, invalid
values, rule collisions, provider failure, unload, and queued-plan replay.
Packaging, approval, and running the *approved artifact* — not the TypeScript
source — are covered by `backend/tests/test_extension_template.py`.
