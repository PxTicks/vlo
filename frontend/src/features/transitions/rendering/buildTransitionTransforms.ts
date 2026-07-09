import type { ClipTransform, Transition } from "../../../types/TimelineTypes";
import type { GenericFilterTransform } from "../../transformations/types";

export type TransitionSide = "outgoing" | "incoming";

function numericParameter(
  parameters: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = parameters[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function applyTransitionEasing(
  progress: number,
  easing: unknown,
): number {
  const p = Math.max(0, Math.min(1, progress));
  if (easing === "easeIn") return p * p;
  if (easing === "easeOut") return 1 - (1 - p) * (1 - p);
  if (easing === "linear") return p;
  return p * p * (3 - 2 * p);
}

function alphaTransform(transitionId: string, alpha: number): ClipTransform {
  return {
    id: `${transitionId}:alpha`,
    type: "filter",
    filterName: "AlphaFilter",
    isEnabled: true,
    parameters: { alpha: Math.max(0, Math.min(1, alpha)) },
  } as GenericFilterTransform;
}

function positionTransform(
  transitionId: string,
  x: number,
  y: number,
): ClipTransform {
  return {
    id: `${transitionId}:position`,
    type: "position",
    isEnabled: true,
    parameters: {
      x: Object.is(x, -0) ? 0 : x,
      y: Object.is(y, -0) ? 0 : y,
    },
  };
}

// Multiplicative scale factor around the clip's centered anchor.
function scaleTransform(transitionId: string, factor: number): ClipTransform {
  return {
    id: `${transitionId}:scale`,
    type: "scale",
    isEnabled: true,
    parameters: { x: factor, y: factor },
  };
}

// Additive rotation (radians) around the clip's centered anchor.
function rotationTransform(transitionId: string, angle: number): ClipTransform {
  return {
    id: `${transitionId}:rotation`,
    type: "rotation",
    isEnabled: true,
    parameters: { angle: Object.is(angle, -0) ? 0 : angle },
  };
}

function blurTransform(transitionId: string, strength: number): ClipTransform {
  return {
    id: `${transitionId}:blur`,
    type: "filter",
    filterName: "BlurFilter",
    isEnabled: true,
    parameters: { strength: Math.max(0, strength) },
  } as GenericFilterTransform;
}

function directionVector(
  direction: unknown,
  dimensions: { width: number; height: number },
  distance: number,
): { x: number; y: number } {
  if (direction === "right") {
    return { x: dimensions.width * distance, y: 0 };
  }
  if (direction === "up") {
    return { x: 0, y: -dimensions.height * distance };
  }
  if (direction === "down") {
    return { x: 0, y: dimensions.height * distance };
  }
  return { x: -dimensions.width * distance, y: 0 };
}

export function buildTransitionTransforms(
  transition: Transition,
  side: TransitionSide,
  progress: number,
  dimensions: { width: number; height: number },
): ClipTransform[] {
  const p = applyTransitionEasing(
    progress,
    transition.parameters.easing,
  );

  if (transition.type === "dissolve") {
    return [
      alphaTransform(
        `${transition.id}:${side}`,
        side === "outgoing" ? 1 - p : p,
      ),
    ];
  }

  if (transition.type === "dipToColor") {
    const alpha =
      side === "outgoing"
        ? 1 - Math.min(1, p * 2)
        : Math.max(0, p * 2 - 1);
    return [alphaTransform(`${transition.id}:${side}`, alpha)];
  }

  if (transition.type === "zoom") {
    const target = numericParameter(transition.parameters, "scale", 1.4);
    // Continuous punch-in: outgoing grows toward `target` while fading out;
    // incoming starts at `target` and settles to 1 while fading in.
    const factor =
      side === "outgoing" ? 1 + (target - 1) * p : 1 + (target - 1) * (1 - p);
    return [
      scaleTransform(`${transition.id}:${side}`, factor),
      alphaTransform(`${transition.id}:${side}`, side === "outgoing" ? 1 - p : p),
    ];
  }

  if (transition.type === "spin") {
    const rotations = numericParameter(transition.parameters, "rotations", 1);
    const sign =
      transition.parameters.direction === "counterclockwise" ? -1 : 1;
    const fullAngle = sign * rotations * Math.PI * 2;
    const minScale = 0.2;
    if (side === "outgoing") {
      return [
        rotationTransform(`${transition.id}:${side}`, fullAngle * p),
        scaleTransform(`${transition.id}:${side}`, 1 - (1 - minScale) * p),
        alphaTransform(`${transition.id}:${side}`, 1 - p),
      ];
    }
    return [
      rotationTransform(`${transition.id}:${side}`, -fullAngle * (1 - p)),
      scaleTransform(`${transition.id}:${side}`, minScale + (1 - minScale) * p),
      alphaTransform(`${transition.id}:${side}`, p),
    ];
  }

  const distance = numericParameter(transition.parameters, "distance", 1);
  const vector = directionVector(
    transition.parameters.direction,
    dimensions,
    distance,
  );

  if (transition.type === "slideAway") {
    return side === "outgoing"
      ? [
          positionTransform(
            `${transition.id}:${side}`,
            vector.x * p,
            vector.y * p,
          ),
        ]
      : [];
  }

  if (transition.type === "slideOutIn") {
    return side === "outgoing"
      ? [
          positionTransform(
            `${transition.id}:${side}`,
            vector.x * p,
            vector.y * p,
          ),
        ]
      : [
          positionTransform(
            `${transition.id}:${side}`,
            -vector.x * (1 - p),
            -vector.y * (1 - p),
          ),
        ];
  }

  if (transition.type === "whipPan") {
    // Locked directional push with motion blur that peaks mid-transition and
    // resolves to zero at both ends for a clean in/out.
    const peak = numericParameter(transition.parameters, "blur", 12);
    const blur = peak * Math.sin(Math.PI * Math.max(0, Math.min(1, p)));
    return side === "outgoing"
      ? [
          positionTransform(
            `${transition.id}:${side}`,
            vector.x * p,
            vector.y * p,
          ),
          blurTransform(`${transition.id}:${side}`, blur),
        ]
      : [
          positionTransform(
            `${transition.id}:${side}`,
            -vector.x * (1 - p),
            -vector.y * (1 - p),
          ),
          blurTransform(`${transition.id}:${side}`, blur),
        ];
  }

  return [];
}
