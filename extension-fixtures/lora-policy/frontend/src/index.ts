import type {
  ExtensionGenerationApi,
  ExtensionGenerationGraphEffect,
  ExtensionGenerationSessionSnapshot,
  ExtensionGenerationWidgetSnapshot,
  ExtensionModule,
  ExtensionReactRuntime,
} from "@vlo/extension-sdk";

/**
 * LoRA loader policy — the out-of-tree conformance fixture for the generation
 * extension surface (docs/generation-extension-surface-plan.md E3).
 *
 * It exercises the whole MVP through public API only: reactive session reads,
 * class-and-widget discovery, a validated widget write, and a submission
 * contributor that turns extension-local UI state into bounded graph effects.
 * Nothing here imports a host store, an iframe object, or a backend module.
 *
 * The two submission plans are the point:
 *
 * - a selected model becomes a `set-widget` effect on the loader's own model
 *   widget; and
 * - the extension-local `None` choice becomes a `bypass-nodes` effect, because
 *   ComfyUI's enum does not contain "no LoRA" and writing that string would be
 *   refused by the host — correctly.
 */

interface ReactHooksRuntime extends ExtensionReactRuntime {
  useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void];
  useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
  ): T;
}

interface ValueEvent {
  readonly target: { readonly value: string };
}

/**
 * The extension-local "no LoRA" choice.
 *
 * It never reaches a widget: a loader's `lora_name` enum lists model files,
 * so this value only ever selects the bypass plan. Namespaced so it cannot
 * collide with a real model file name.
 */
export const BYPASS_CHOICE = "vlo.lora-policy:none";

/** The widget every supported loader class exposes its model list through. */
export const MODEL_WIDGET_PARAM = "lora_name";

/** Discovery is by class *and* widget; neither alone is specific enough. */
function isLoaderClass(classType: string): boolean {
  return classType.toLowerCase().startsWith("loraloader");
}

function modelWidget(
  widgets: readonly ExtensionGenerationWidgetSnapshot[],
): ExtensionGenerationWidgetSnapshot | null {
  const widget = widgets.find((candidate) => candidate.param === MODEL_WIDGET_PARAM);
  if (!widget || widget.linked) return null;
  if (!widget.options || widget.options.length === 0) return null;
  return widget;
}

export interface LoraLoaderControl {
  /** Execution id: `<id>` at the root, `<instanceId>:<innerId>` when scoped. */
  readonly nodeId: string;
  readonly title: string;
  readonly classType: string;
  readonly widget: string;
  /** The model the graph currently carries, as the snapshot publishes it. */
  readonly value: string | number | boolean | null;
  readonly options: readonly (string | number | boolean)[];
  /** The panel renders a control for this widget, so `setWidget` can reach it. */
  readonly editable: boolean;
}

/**
 * Every loader the mounted workflow exposes a model list for.
 *
 * Class and widget metadata is all the snapshot carries — there are no links
 * in it — so this cannot and does not claim to know which loaders are actually
 * wired into the sampled model. A node the user has already muted or bypassed
 * is skipped: they have disabled it, and a policy that silently re-enabled it
 * would be overriding a decision it did not make.
 */
export function discoverLoaders(
  session: ExtensionGenerationSessionSnapshot | null,
): readonly LoraLoaderControl[] {
  if (!session) return [];
  const loaders: LoraLoaderControl[] = [];
  for (const node of session.workflow.nodes) {
    if (node.mode !== 0) continue;
    if (!isLoaderClass(node.classType)) continue;
    const widget = modelWidget(node.widgets);
    if (!widget) continue;
    loaders.push({
      nodeId: node.id,
      title: node.title || node.classType,
      classType: node.classType,
      widget: widget.param,
      value:
        typeof widget.value === "string" ||
        typeof widget.value === "number" ||
        typeof widget.value === "boolean"
          ? widget.value
          : null,
      options: widget.options ?? [],
      editable: widget.editable,
    });
  }
  return loaders;
}

/**
 * The host's published per-contributor bounds. A contribution that breaks one
 * is refused whole, and refusing a contribution fails the submission, so these
 * are the fixture's own budget rather than a limit it may discover by being
 * rejected. See `docs/generation-extension-surface-plan.md` E2.
 */
export const MAX_CONTRIBUTED_EFFECTS = 64;
export const MAX_BYPASS_NODES_PER_EFFECT = 256;

/**
 * The submission plan for one session and one set of selections.
 *
 * Planned entirely from the session it is handed, never from a snapshot taken
 * earlier: the host pins a contribution to the workflow it was planned
 * against, and a node id means something different in a different workflow.
 * A selection whose node has since disappeared, or whose model the widget no
 * longer offers, is dropped rather than contributed — a contribution is
 * all-or-nothing, so an effect this fixture is unsure of would fail the user's
 * whole generation.
 *
 * The result stays inside the host's bounds by construction: bypass targets
 * are set-like, so they are packed into as few effects as the per-effect limit
 * allows, and the panel refuses a selection that would take the plan past
 * {@link MAX_CONTRIBUTED_EFFECTS} rather than planning something the host will
 * throw away. `planCount` exists so that check can be made before a selection
 * is recorded.
 */
export function planLoaderEffects(
  session: ExtensionGenerationSessionSnapshot,
  selections: ReadonlyMap<string, string>,
): readonly ExtensionGenerationGraphEffect[] {
  const bypassNodeIds: string[] = [];
  const writes: ExtensionGenerationGraphEffect[] = [];
  for (const loader of discoverLoaders(session)) {
    const choice = selections.get(loader.nodeId);
    if (choice === undefined) continue;
    if (choice === BYPASS_CHOICE) {
      bypassNodeIds.push(loader.nodeId);
      continue;
    }
    if (!loader.options.some((option) => option === choice)) continue;
    writes.push({
      kind: "set-widget",
      target: { nodeId: loader.nodeId, widget: loader.widget },
      value: choice,
    });
  }
  const bypasses: ExtensionGenerationGraphEffect[] = [];
  for (
    let index = 0;
    index < bypassNodeIds.length;
    index += MAX_BYPASS_NODES_PER_EFFECT
  ) {
    bypasses.push({
      kind: "bypass-nodes",
      nodeIds: bypassNodeIds.slice(index, index + MAX_BYPASS_NODES_PER_EFFECT),
    });
  }
  // Discovery order makes the result deterministic for the same session and
  // selections, which is what the host asks a contributor to be.
  return [...bypasses, ...writes];
}

interface WorkflowIdentity {
  readonly sourceId: string | null;
  readonly instanceId: string | null;
}

const NO_SELECTIONS: ReadonlyMap<string, string> = new Map();

/**
 * The user's choices, which are extension state and nothing else.
 *
 * Node ids are unique within a workflow, not across workflows, so choices are
 * bound to the workflow they were made in and read back through
 * {@link LoraPolicyStore.selectionsFor} — by the panel as well as the
 * contributor. Reading them unscoped anywhere would let one workflow display a
 * selection another workflow made, for a node id that happens to collide.
 *
 * Identity is the workflow source where there is one: a file identifies
 * itself, and re-opening it should not lose the user's choices. Only a
 * workflow with no source falls back to the ComfyUI instance, and there the
 * `null` the bridge reports before it has answered is treated as *not yet
 * known* rather than as a different workflow — otherwise identity arriving a
 * moment after mount would silently discard everything chosen until then.
 */
class LoraPolicyStore {
  private identity: WorkflowIdentity | null = null;
  private selections: ReadonlyMap<string, string> = NO_SELECTIONS;
  private revision = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Pairs with `subscribe` for `useSyncExternalStore`; the map is scoped. */
  getRevision = (): number => this.revision;

  private describes(session: ExtensionGenerationSessionSnapshot): boolean {
    if (!this.identity) return false;
    const { sourceId, instanceId } = session.workflow;
    if (this.identity.sourceId !== sourceId) return false;
    if (sourceId !== null) return true;
    return (
      this.identity.instanceId === null ||
      instanceId === null ||
      this.identity.instanceId === instanceId
    );
  }

  /**
   * The selections that belong to this workflow; empty for any other.
   *
   * Reading also latches the instance id the first time the bridge reports it
   * for a workflow with no source. Without that the "not yet known" rule above
   * would never expire: choices made before identity arrived would go on
   * matching *every* later unnamed workflow, which is the collision this
   * scoping exists to prevent. Latching is monotone — unknown to known, once —
   * so it cannot change what any single contribution plans.
   */
  selectionsFor(
    session: ExtensionGenerationSessionSnapshot,
  ): ReadonlyMap<string, string> {
    if (!this.describes(session)) return NO_SELECTIONS;
    if (this.identity && this.identity.instanceId === null) {
      this.identity = {
        sourceId: this.identity.sourceId,
        instanceId: session.workflow.instanceId,
      };
    }
    return this.selections;
  }

  select(
    session: ExtensionGenerationSessionSnapshot,
    nodeId: string,
    choice: string,
  ): void {
    const known = this.describes(session);
    const next = new Map(known ? this.selections : []);
    next.set(nodeId, choice);
    this.identity = {
      sourceId: session.workflow.sourceId,
      // Adopt the instance as soon as the bridge reports it: the same workflow
      // becoming more precisely identified is not a different workflow.
      instanceId:
        session.workflow.instanceId ??
        (known ? (this.identity?.instanceId ?? null) : null),
    };
    this.selections = next;
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.identity = null;
    this.selections = NO_SELECTIONS;
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

const policy = new LoraPolicyStore();

/** Test-only accessor; not part of any host contract. */
export function resetLoraPolicyStateForConformance(): void {
  policy.reset();
}

function describeChoice(
  loader: LoraLoaderControl,
  choice: string,
  written: boolean,
): string {
  if (choice === BYPASS_CHOICE) {
    return `${loader.title} will be bypassed in the next generation.`;
  }
  return written
    ? `${loader.title} is set to ${choice} now, and in the next generation.`
    : `${loader.title} has no panel control; ${choice} is applied when you generate.`;
}

function createLoraPolicyPanel(
  React: ReactHooksRuntime,
  generation: ExtensionGenerationApi,
) {
  return function LoraPolicyPanel(): unknown {
    const session = React.useSyncExternalStore(
      generation.subscribe,
      generation.getSession,
    );
    // The revision is the change signal; the selections themselves are read
    // scoped to the mounted workflow, so this panel can only ever show choices
    // that would actually be contributed for it.
    React.useSyncExternalStore(policy.subscribe, policy.getRevision);
    const [status, setStatus] = React.useState<string | null>(null);
    const h = React.createElement;
    const loaders = discoverLoaders(session);
    const selections = session ? policy.selectionsFor(session) : NO_SELECTIONS;

    if (!session) {
      return h("p", { role: "status" }, "The generation panel is not mounted.");
    }
    if (loaders.length === 0) {
      return h(
        "p",
        { role: "status" },
        "No compatible LoRA loader in this workflow.",
      );
    }

    const choose = (loader: LoraLoaderControl, choice: string) => {
      // Refuse before recording anything if this choice would take the plan
      // past what one contribution may carry. The host refuses an over-budget
      // contribution whole, which would fail the user's generation over a
      // selection this panel could simply have declined to accept.
      const candidate = new Map(selections);
      candidate.set(loader.nodeId, choice);
      if (planLoaderEffects(session, candidate).length > MAX_CONTRIBUTED_EFFECTS) {
        setStatus(
          `This workflow already has ${MAX_CONTRIBUTED_EFFECTS} loader changes planned, which is all one generation can carry. Clear one before adding another.`,
        );
        return;
      }
      // Otherwise the choice is recorded first and unconditionally: it is what
      // the submission contributor plans from, and it must survive a refused
      // write rather than silently reverting under the user.
      policy.select(session, loader.nodeId, choice);
      if (choice === BYPASS_CHOICE || !loader.editable) {
        setStatus(describeChoice(loader, choice, false));
        return;
      }
      const result = generation.transaction("Select LoRA model", (transaction) => {
        transaction.setWidget(
          { nodeId: loader.nodeId, widget: loader.widget },
          choice,
        );
      });
      if (result.ok) {
        setStatus(describeChoice(loader, choice, true));
        return;
      }
      // The three widget codes say different things. Only `widget_not_found`
      // means this view is stale; the others leave the selection standing,
      // because the contributor addresses the graph rather than the panel.
      setStatus(
        result.code === "widget_not_found"
          ? `${loader.title} is no longer in this workflow (${result.code}).`
          : `${loader.title} could not be written now (${result.code}); it is still applied when you generate.`,
      );
    };

    return h(
      "div",
      { style: { display: "grid", gap: 8 } },
      ...loaders.map((loader) =>
        h(
          "label",
          { key: loader.nodeId, style: { display: "grid", gap: 4 } },
          `${loader.title} (${loader.nodeId})`,
          h(
            "select",
            {
              "aria-label": `LoRA for ${loader.title}`,
              value: selections.get(loader.nodeId) ?? String(loader.value ?? ""),
              onChange: (event: ValueEvent) => choose(loader, event.target.value),
            },
            h("option", { key: "none", value: BYPASS_CHOICE }, "None (bypass)"),
            ...loader.options.map((option) =>
              h(
                "option",
                { key: String(option), value: String(option) },
                String(option),
              ),
            ),
          ),
        ),
      ),
      h("p", { role: "status" }, status ?? "Pick a LoRA for each loader."),
    );
  };
}

export const activate: ExtensionModule["activate"] = (context) => {
  const React = context.api.runtime.react as ReactHooksRuntime;
  const generation = context.api.generation;

  context.api.ui.registerComponent({
    id: "lora-policy",
    apiVersion: 1,
    slot: "generation.inputs.after",
    kind: "trusted-react",
    component: createLoraPolicyPanel(React, generation),
  });

  generation.registerSubmissionContributor({
    id: "policy",
    apiVersion: 1,
    // Deterministic for the context it is handed: no clock, no randomness, and
    // no session other than the one the host planned this submission from.
    contribute: ({ session }) =>
      planLoaderEffects(session, policy.selectionsFor(session)),
  });

  // The choices are activation state, not user data the host persists.
  context.onDispose(() => policy.reset());
  context.logger.info("LoRA loader policy conformance fixture activated.");
};
