import type {
  CapabilityCheck,
  CapabilityFailureCode,
  RuntimeCapability,
} from "../../types/RuntimeStatus";

/**
 * The code → surface decisions, in one place.
 *
 * Feature surfaces branch on the failure code, never on prose: the backend's
 * summary and remediation are rendered as given, and the only thing the
 * frontend decides is which affordance can actually fix the problem.
 */

/**
 * Can the feature's own model-download UI fix this?
 *
 * Only for genuinely missing or incomplete model files. Offering a download
 * for a missing Python package is the exact false affordance this whole
 * effort exists to remove — no amount of re-downloading a checkpoint installs
 * `sam_audio`.
 */
export function isModelProblem(
  code: CapabilityFailureCode | null | undefined,
): boolean {
  return code === "model_missing" || code === "model_invalid";
}

/**
 * Can installing packages fix this?
 *
 * The mirror of {@link isModelProblem}, and the same discipline: an install
 * command is offered for the failures an install repairs, and for no others.
 * Re-running `uv pip install` does nothing for an unsupported Python, an
 * unwritable cache, or a model that failed to load once it was in memory.
 */
export function isInstallProblem(
  code: CapabilityFailureCode | null | undefined,
): boolean {
  return (
    code === "package_missing" ||
    code === "package_import_failed" ||
    code === "dependency_incompatible"
  );
}

/**
 * A short phrase naming the cause, for places with one line to spend: a
 * status caption, a queue notification ("SAM-Audio unavailable: Python
 * package not installed").
 */
export function failureHeadline(
  code: CapabilityFailureCode | null | undefined,
): string {
  switch (code) {
    case "python_version_unsupported":
      return "Unsupported Python version";
    case "package_missing":
      return "Python package not installed";
    case "package_import_failed":
      return "Python package failed to import";
    case "dependency_incompatible":
      return "Incompatible dependency";
    case "dependency_download_failed":
      return "Dependency download failed";
    case "model_missing":
      return "Model files missing";
    case "model_invalid":
      return "Model files incomplete";
    case "config_missing":
      return "Configuration missing";
    case "out_of_memory":
      return "Out of memory";
    case "runtime_load_failed":
      return "Runtime failed to load";
    case "device_unavailable":
      return "Requested device unavailable";
    case "cache_unwritable":
      return "Cache directory not writable";
    case "authentication_required":
      return "Authentication required";
    case null:
    case undefined:
      return "Unavailable";
    default: {
      // Exhaustiveness: a new backend code must be handled here, not fall
      // through to prose.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

export function severityForCode(
  code: CapabilityFailureCode | null | undefined,
): "error" | "warning" {
  // A missing model is an expected first-run state with an obvious next step;
  // a broken environment is not.
  return isModelProblem(code) ? "warning" : "error";
}

/**
 * The check that best explains why a capability cannot be attempted.
 *
 * Checks arrive cheapest-stage-first, so the first failure is the most
 * fundamental one.
 */
export function blockingCheck(
  capability: RuntimeCapability | null | undefined,
): CapabilityCheck | null {
  if (!capability) return null;
  return capability.checks.find((check) => check.status === "fail") ?? null;
}
