import {
  checkWidgetValue,
  describeWidgetTarget,
} from "./generationSessionValidation";
import { serializeFiniteJson } from "../utils/finiteJson";
import type {
  GenerationSessionSnapshot,
  GenerationWidgetTarget,
} from "./generationSessionTypes";
import type {
  GenerationContributedEffectGroup,
  GenerationContributedWidgetOverride,
  GenerationContributionWorkflowIdentity,
  GenerationEffectDiagnostic,
  GenerationEffectJsonValue,
  GenerationExtensionEffectSource,
} from "../pipeline/types";

/**
 * The generation-owned registry of submission contributors
 * (docs/generation-extension-surface-plan.md E2).
 *
 * Owner-neutral, like the session service: a contributor is an id and a
 * synchronous callback, and nothing here knows about activation scopes, SDK
 * limits, or extension diagnostics. The extension adapter binds ownership and
 * isolates callbacks; this module decides *when* contributors run, in what
 * order, and what a contribution is allowed to say.
 *
 * Contributors run exactly once per submission, at plan-build time, and their
 * result is stored in the plan. Dispatch replays that stored result rather
 * than asking again, which is what makes a queued plan immune to later UI
 * changes, workflow switches, and the contributing extension being unloaded.
 */

export type GenerationContributedEffect =
  | { readonly kind: "bypass-nodes"; readonly nodeIds: readonly string[] }
  | {
      readonly kind: "set-widget";
      readonly target: GenerationWidgetTarget;
      readonly value: unknown;
    };

export interface GenerationSubmissionContext {
  /** The mounted session as published; the caller detaches it if it must. */
  readonly session: GenerationSessionSnapshot;
}

/**
 * The workflow the caller is planning a submission for, as it stands in the
 * state the plan is being built from. The session is published asynchronously
 * by the panel, so it can still describe the workflow that was open a moment
 * ago; contributions are refused rather than guessed at when the two disagree.
 */
export interface GenerationSubmissionWorkflowExpectation {
  readonly sourceId: string | null;
  readonly instanceId: string | null;
}

export interface GenerationSubmissionContributor {
  /** Canonical and unique across the registry; the caller qualifies it. */
  readonly id: string;
  contribute(
    context: GenerationSubmissionContext,
  ): readonly GenerationContributedEffect[];
}

/**
 * Per-contributor bounds. The public adapter enforces these before the host is
 * handed anything, so an SDK caller gets a message in its own vocabulary; the
 * host enforces them again because a native caller is not required to go
 * through that adapter, and a seam that only checks on one path is not a
 * bound. Shared constants so the two can never drift apart.
 */
export const GENERATION_CONTRIBUTION_LIMITS = {
  effects: 64,
  bypassNodesPerEffect: 256,
  /** Characters in one node id or widget name. */
  targetPartLength: 512,
  /** Serialized characters in one widget value. */
  valueLength: 100_000,
} as const;

function source(id: string): GenerationExtensionEffectSource {
  return `extension:${id}`;
}

function error(
  contributorId: string,
  code: GenerationEffectDiagnostic["code"],
  message: string,
): GenerationEffectDiagnostic {
  return {
    severity: "error",
    code,
    source: source(contributorId),
    message,
  };
}

function identityOf(
  session: GenerationSessionSnapshot,
): GenerationContributionWorkflowIdentity {
  return {
    sourceId: session.workflow.sourceId,
    instanceId: session.workflow.instanceId,
    fingerprint: session.workflow.fingerprint,
  };
}

const UNKNOWN_WORKFLOW: GenerationContributionWorkflowIdentity = {
  sourceId: null,
  instanceId: null,
  fingerprint: "",
};

function findWidget(
  session: GenerationSessionSnapshot,
  target: GenerationWidgetTarget,
) {
  const node = session.workflow.nodes.find(
    (candidate) => candidate.id === target.nodeId,
  );
  if (!node) return { node: null, widget: null } as const;
  return {
    node,
    widget:
      node.widgets.find((candidate) => candidate.param === target.widget) ??
      null,
  } as const;
}

/**
 * Validate one contribution against the session it was planned from.
 *
 * Targets are checked here rather than left to the bridge because this is the
 * last point where the workflow that produced them is still in hand: an
 * effect naming a node this workflow does not have is a contributor bug, and
 * saying so at enqueue beats a clone-time failure minutes later. Values are
 * judged against the *catalogue*, not the panel's editable bindings — an
 * effect addresses the graph, which is the whole reason it exists.
 */
function validateContribution(
  contributorId: string,
  session: GenerationSessionSnapshot,
  effects: readonly GenerationContributedEffect[],
): GenerationContributedEffectGroup {
  const workflow = identityOf(session);
  const diagnostics: GenerationEffectDiagnostic[] = [];
  const bypassNodeIds: string[] = [];
  const widgetOverrides: GenerationContributedWidgetOverride[] = [];

  if (effects.length > GENERATION_CONTRIBUTION_LIMITS.effects) {
    diagnostics.push(
      error(
        contributorId,
        "invalid-target",
        `Contributor '${contributorId}' returned ${effects.length} effects; at most ${GENERATION_CONTRIBUTION_LIMITS.effects} are accepted.`,
      ),
    );
    return {
      source: source(contributorId),
      workflow,
      bypassNodeIds: [],
      widgetOverrides: [],
      diagnostics,
    };
  }

  for (const effect of effects) {
    if (effect.kind === "bypass-nodes") {
      if (effect.nodeIds.length > GENERATION_CONTRIBUTION_LIMITS.bypassNodesPerEffect) {
        diagnostics.push(
          error(
            contributorId,
            "invalid-target",
            `Contributor '${contributorId}' asked to bypass ${effect.nodeIds.length} nodes; at most ${GENERATION_CONTRIBUTION_LIMITS.bypassNodesPerEffect} are accepted.`,
          ),
        );
        continue;
      }
      for (const nodeId of effect.nodeIds) {
        const trimmed = typeof nodeId === "string" ? nodeId.trim() : "";
        if (
          trimmed.length === 0 ||
          trimmed.length > GENERATION_CONTRIBUTION_LIMITS.targetPartLength
        ) {
          diagnostics.push(
            error(
              contributorId,
              "invalid-target",
              `Contributor '${contributorId}' asked to bypass a node whose id is not 1-${GENERATION_CONTRIBUTION_LIMITS.targetPartLength} characters.`,
            ),
          );
          continue;
        }
        if (!session.workflow.nodes.some((node) => node.id === trimmed)) {
          diagnostics.push(
            error(
              contributorId,
              "invalid-target",
              `Contributor '${contributorId}' asked to bypass node '${trimmed}', which the mounted workflow does not contain.`,
            ),
          );
          continue;
        }
        bypassNodeIds.push(trimmed);
      }
      continue;
    }

    const nodeId =
      typeof effect.target?.nodeId === "string"
        ? effect.target.nodeId.trim()
        : "";
    const widget =
      typeof effect.target?.widget === "string"
        ? effect.target.widget.trim()
        : "";
    const target: GenerationWidgetTarget = { nodeId, widget };
    if (
      nodeId.length === 0 ||
      widget.length === 0 ||
      nodeId.length > GENERATION_CONTRIBUTION_LIMITS.targetPartLength ||
      widget.length > GENERATION_CONTRIBUTION_LIMITS.targetPartLength
    ) {
      diagnostics.push(
        error(
          contributorId,
          "invalid-target",
          `Contributor '${contributorId}' wrote a widget whose node id and name are not 1-${GENERATION_CONTRIBUTION_LIMITS.targetPartLength} characters each.`,
        ),
      );
      continue;
    }

    const found = findWidget(session, target);
    if (!found.node || !found.widget) {
      diagnostics.push(
        error(
          contributorId,
          "invalid-target",
          `Contributor '${contributorId}' wrote '${describeWidgetTarget(
            target,
          )}', which the mounted workflow does not contain.`,
        ),
      );
      continue;
    }

    const serialized = serializeFiniteJson(effect.value);
    if (
      serialized === null ||
      serialized.length > GENERATION_CONTRIBUTION_LIMITS.valueLength
    ) {
      diagnostics.push(
        error(
          contributorId,
          "invalid-value",
          `Contributor '${contributorId}' wrote '${describeWidgetTarget(
            target,
          )}' with a value that is not finite JSON of at most ${GENERATION_CONTRIBUTION_LIMITS.valueLength} serialized characters.`,
        ),
      );
      continue;
    }
    const value = JSON.parse(serialized) as GenerationEffectJsonValue;

    const rejection = checkWidgetValue(
      found.widget,
      value,
      describeWidgetTarget(target),
    );
    if (rejection) {
      diagnostics.push(
        error(
          contributorId,
          "invalid-value",
          `Contributor '${contributorId}': ${rejection.message}`,
        ),
      );
      continue;
    }

    widgetOverrides.push({ node_id: nodeId, widget, value });
  }

  return {
    source: source(contributorId),
    workflow,
    bypassNodeIds,
    widgetOverrides,
    diagnostics,
  };
}

export class GenerationSubmissionContributorRegistry {
  // Insertion-ordered, which is the documented invocation order: two
  // contributors writing the same widget resolve by registration, not by
  // whichever the map happened to iterate first.
  private readonly contributors = new Map<
    string,
    GenerationSubmissionContributor
  >();

  register(contributor: GenerationSubmissionContributor): () => void {
    const id = contributor.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("A submission contributor needs a non-empty id.");
    }
    if (typeof contributor.contribute !== "function") {
      throw new TypeError(
        `Submission contributor '${id}' must define contribute().`,
      );
    }
    if (this.contributors.has(id)) {
      throw new Error(`Submission contributor '${id}' is already registered.`);
    }
    this.contributors.set(id, contributor);
    return () => {
      if (this.contributors.get(id) === contributor) {
        this.contributors.delete(id);
      }
    };
  }

  size(): number {
    return this.contributors.size;
  }

  /**
   * Run every contributor once against the session a submission is planned
   * from, and return what the plan should carry.
   *
   * A contributor that throws contributes nothing and records an *error*: its
   * effects are policy the user set up, and submitting a generation that
   * silently ignores them produces a result they did not ask for. Failing the
   * submission is recoverable — the user can disable the extension — while a
   * wrong image quietly consumes GPU time.
   */
  collect(
    session: GenerationSessionSnapshot | null,
    expected?: GenerationSubmissionWorkflowExpectation,
  ): readonly GenerationContributedEffectGroup[] {
    if (this.contributors.size === 0) return [];

    const unavailable = (
      reason: string,
    ): readonly GenerationContributedEffectGroup[] =>
      [...this.contributors.values()].map((contributor) => ({
        source: source(contributor.id),
        workflow: UNKNOWN_WORKFLOW,
        bypassNodeIds: [],
        widgetOverrides: [],
        diagnostics: [
          error(
            contributor.id,
            "contributor-failed",
            `Contributor '${contributor.id}' could not run: ${reason}`,
          ),
        ],
      }));

    if (!session) {
      return unavailable("no generation session is mounted.");
    }
    // The session is published from a React effect, so it can still describe
    // the workflow that was open a moment ago. Effects planned against that
    // one must not be filed under this submission's workflow: node ids are
    // unique only within a workflow, so the bridge would happily apply them.
    if (
      expected &&
      (expected.sourceId !== session.workflow.sourceId ||
        expected.instanceId !== session.workflow.instanceId)
    ) {
      return unavailable(
        "the mounted session describes a different workflow than this submission.",
      );
    }

    const context: GenerationSubmissionContext = { session };
    return [...this.contributors.values()].map((contributor) => {
      let effects: readonly GenerationContributedEffect[];
      try {
        const returned = contributor.contribute(context);
        if (!Array.isArray(returned)) {
          throw new TypeError("contribute() must return an array of effects.");
        }
        effects = returned;
      } catch (failure) {
        return {
          source: source(contributor.id),
          workflow: identityOf(session),
          bypassNodeIds: [],
          widgetOverrides: [],
          diagnostics: [
            error(
              contributor.id,
              "contributor-failed",
              `Contributor '${contributor.id}' failed: ${
                failure instanceof Error ? failure.message : String(failure)
              }`,
            ),
          ],
        };
      }
      return validateContribution(contributor.id, session, effects);
    });
  }
}

/** The single registry the generation store collects from. */
export const generationSubmissionContributors =
  new GenerationSubmissionContributorRegistry();
