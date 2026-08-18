import {
  GENERATION_CONTRIBUTION_LIMITS,
  generationSubmissionContributors,
} from "../../generation/services/generationSubmissionContributors";
import type {
  GenerationContributedEffect,
  GenerationSubmissionContext,
} from "../../generation/services/generationSubmissionContributors";
import { serializeFiniteJson } from "../../generation/utils/finiteJson";
import {
  ExtensionContributionRegistry,
  type ExtensionContributionDefinition,
} from "../registry/ExtensionContributionRegistry";
import { projectGenerationSession } from "./generationSessionProjection";
import type {
  ExtensionApiScope,
  ExtensionGenerationGraphEffect,
  ExtensionGenerationRegistration,
  ExtensionGenerationSubmissionContributorDefinition,
} from "../types";

/**
 * Owner binding for generation submission contributors
 * (docs/generation-extension-surface-plan.md E2).
 *
 * The generation domain decides when contributors run and what a contribution
 * may say; this adapter decides *whose* it is. It canonicalizes the id through
 * the shared contribution registry, enrolls both registrations for activation
 * disposal, projects the detached session the callback sees, isolates the
 * callback, and enforces the SDK's own bounds before the host is handed
 * anything.
 */

// The host's own bounds, not a second set: the adapter checks them first so an
// SDK caller gets a message in its own vocabulary, and the host checks them
// again for callers that never went through here. One constant means the two
// cannot drift into disagreeing about what is acceptable.
const MAX_EFFECTS = GENERATION_CONTRIBUTION_LIMITS.effects;
const MAX_BYPASS_NODES = GENERATION_CONTRIBUTION_LIMITS.bypassNodesPerEffect;
const MAX_TARGET_PART_LENGTH = GENERATION_CONTRIBUTION_LIMITS.targetPartLength;
const MAX_WIDGET_VALUE_LENGTH = GENERATION_CONTRIBUTION_LIMITS.valueLength;

type SubmissionContributorContribution = ExtensionContributionDefinition &
  ExtensionGenerationSubmissionContributorDefinition;

function assertNodeId(id: unknown, contributionId: string): string {
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    id.length > MAX_TARGET_PART_LENGTH
  ) {
    throw new Error(
      `Submission contributor '${contributionId}' returned a node id that is not a string of 1-${MAX_TARGET_PART_LENGTH} characters.`,
    );
  }
  return id;
}

/**
 * Translate one returned effect into the host's shape, or refuse it.
 *
 * Refusing throws rather than dropping the effect: a contribution is a policy
 * the user set up in the extension's UI, and a submission that silently
 * applied half of it would spend GPU time on a result nobody asked for. The
 * host turns the throw into an attributed `contributor-failed` diagnostic that
 * fails the submission before preprocessing.
 */
function toHostEffect(
  effect: ExtensionGenerationGraphEffect,
  contributionId: string,
): GenerationContributedEffect {
  if (effect?.kind === "bypass-nodes") {
    if (!Array.isArray(effect.nodeIds)) {
      throw new Error(
        `Submission contributor '${contributionId}' returned a bypass effect without a node id array.`,
      );
    }
    if (effect.nodeIds.length > MAX_BYPASS_NODES) {
      throw new Error(
        `Submission contributor '${contributionId}' returned ${effect.nodeIds.length} bypass targets; at most ${MAX_BYPASS_NODES} are accepted.`,
      );
    }
    return {
      kind: "bypass-nodes",
      nodeIds: effect.nodeIds.map((nodeId) =>
        assertNodeId(nodeId, contributionId),
      ),
    };
  }

  if (effect?.kind === "set-widget") {
    const nodeId = assertNodeId(effect.target?.nodeId, contributionId);
    const widget = effect.target?.widget;
    if (
      typeof widget !== "string" ||
      widget.trim().length === 0 ||
      widget.length > MAX_TARGET_PART_LENGTH
    ) {
      throw new Error(
        `Submission contributor '${contributionId}' returned a widget name that is not a string of 1-${MAX_TARGET_PART_LENGTH} characters.`,
      );
    }
    const serialized = serializeFiniteJson(effect.value);
    if (serialized === null || serialized.length > MAX_WIDGET_VALUE_LENGTH) {
      throw new Error(
        `Submission contributor '${contributionId}' returned a widget value that is not finite JSON of at most ${MAX_WIDGET_VALUE_LENGTH} serialized characters.`,
      );
    }
    return {
      kind: "set-widget",
      target: { nodeId, widget },
      value: JSON.parse(serialized) as unknown,
    };
  }

  throw new Error(
    `Submission contributor '${contributionId}' returned an effect of unknown kind.`,
  );
}

function validateDefinition(
  definition: ExtensionGenerationSubmissionContributorDefinition,
): SubmissionContributorContribution {
  if (definition.apiVersion !== 1) {
    throw new Error(
      `Submission contributor '${definition.id}' must use apiVersion 1.`,
    );
  }
  if (typeof definition.contribute !== "function") {
    throw new TypeError(
      `Submission contributor '${definition.id}' must define contribute().`,
    );
  }
  return { ...definition };
}

export class ExtensionGenerationSubmissionContributorRegistry {
  private readonly registry =
    new ExtensionContributionRegistry<SubmissionContributorContribution>(
      "generation-submission-contributor",
    );

  bind(
    scope: ExtensionApiScope,
  ): (
    definition: ExtensionGenerationSubmissionContributorDefinition,
  ) => ExtensionGenerationRegistration {
    const boundRegistry = this.registry.bind(scope);
    return (definition) => {
      const validated = validateDefinition(definition);
      const registration = boundRegistry.register(validated);
      const contributionId = registration.id;

      const contribute = (
        context: GenerationSubmissionContext,
      ): readonly GenerationContributedEffect[] => {
        // Deactivation removes the registration, but a submission already in
        // flight can still reach this: contributing nothing is what an absent
        // extension means.
        if (scope.signal.aborted) return [];

        let returned: readonly ExtensionGenerationGraphEffect[];
        try {
          returned = validated.contribute({
            session: projectGenerationSession(context.session).session,
          });
        } catch (error) {
          scope.report(
            "error",
            `Generation submission contributor '${contributionId}' failed.`,
            error,
          );
          // Re-thrown deliberately, with a message that discloses nothing
          // about host internals: the generation domain has to hear about the
          // failure to fail the submission, and the extension's own stack has
          // already gone to its diagnostics.
          throw new Error(
            `Submission contributor '${contributionId}' threw while planning a generation.`,
          );
        }

        if (!Array.isArray(returned)) {
          throw new Error(
            `Submission contributor '${contributionId}' must return an array of effects.`,
          );
        }
        if (returned.length > MAX_EFFECTS) {
          throw new Error(
            `Submission contributor '${contributionId}' returned ${returned.length} effects; at most ${MAX_EFFECTS} are accepted.`,
          );
        }
        return returned.map((effect) => toHostEffect(effect, contributionId));
      };

      let unregister: () => void;
      try {
        unregister = generationSubmissionContributors.register({
          id: contributionId,
          contribute,
        });
      } catch (error) {
        // Never leave the contribution registry claiming an id the generation
        // domain refused.
        registration.dispose();
        throw error;
      }

      const owned = scope.own({ dispose: () => unregister() });
      return Object.freeze({
        id: contributionId,
        dispose: () => {
          void owned.dispose();
          registration.dispose();
        },
      });
    };
  }
}

export const extensionGenerationSubmissionContributors =
  new ExtensionGenerationSubmissionContributorRegistry();
