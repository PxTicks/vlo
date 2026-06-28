import { VLO_EXTENSION_SDK_VERSION } from "../constants";

const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMPARATOR_PATTERN = /^(<=|>=|<|>|=)?(.+)$/;

interface StableSemver {
  major: number;
  minor: number;
  patch: number;
}

type ComparatorOperator = "<" | "<=" | "=" | ">=" | ">";

export interface ExtensionSdkCompatibility {
  compatible: boolean;
  valid: boolean;
  sdkVersion: string;
  declaredRange: string;
  reason?: string;
}

function parseStableSemver(value: string): StableSemver | null {
  const match = STABLE_SEMVER_PATTERN.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: StableSemver, right: StableSemver): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function satisfiesComparator(
  version: StableSemver,
  operator: ComparatorOperator,
  target: StableSemver,
): boolean {
  const comparison = compareVersions(version, target);
  if (operator === "<") return comparison < 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  if (operator === ">=") return comparison >= 0;
  return comparison === 0;
}

/**
 * V1 intentionally accepts a small, deterministic range grammar: an exact
 * stable version or whitespace-separated <, <=, =, >=, and > comparators.
 * Unsupported npm-range syntax fails closed until the shared manifest policy
 * grows deliberately.
 */
export function evaluateExtensionSdkCompatibility(
  declaredRange: string,
  sdkVersion = VLO_EXTENSION_SDK_VERSION,
): ExtensionSdkCompatibility {
  const version = parseStableSemver(sdkVersion);
  const normalizedRange = declaredRange
    .trim()
    .replace(/(<=|>=|<|>|=)\s+(?=\d)/g, "$1");
  if (!version) {
    return {
      compatible: false,
      valid: false,
      sdkVersion,
      declaredRange,
      reason: `Host SDK version '${sdkVersion}' is not a stable semantic version.`,
    };
  }
  if (!normalizedRange) {
    return {
      compatible: false,
      valid: false,
      sdkVersion,
      declaredRange,
      reason: "The extension SDK range is empty.",
    };
  }

  const comparators = normalizedRange.split(/\s+/).map((token) => {
    const match = COMPARATOR_PATTERN.exec(token);
    if (!match) return null;
    const target = parseStableSemver(match[2] ?? "");
    if (!target) return null;
    return {
      operator: (match[1] ?? "=") as ComparatorOperator,
      target,
    };
  });

  if (comparators.some((comparator) => comparator === null)) {
    return {
      compatible: false,
      valid: false,
      sdkVersion,
      declaredRange,
      reason:
        "The SDK range must use exact stable versions or whitespace-separated comparators.",
    };
  }

  const compatible = comparators.every(
    (comparator) =>
      comparator !== null &&
      satisfiesComparator(version, comparator.operator, comparator.target),
  );
  return {
    compatible,
    valid: true,
    sdkVersion,
    declaredRange,
    ...(compatible
      ? {}
      : {
          reason: `Extension range '${declaredRange}' does not include SDK ${sdkVersion}.`,
        }),
  };
}
