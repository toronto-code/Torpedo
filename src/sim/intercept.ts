import type { TrackEstimate, Vec2 } from "./types";

/**
 * Closed-form intercept geometry on the horizontal (North, East) plane.
 *
 * All functions consume TrackEstimate data only — never target truth — so
 * they are safe to use inside the information boundary. Solutions assume the
 * constant-velocity track model; an evading contact will stale the solution,
 * which is part of the experiment.
 */

export interface InterceptSolution {
  /** True when a collision-course solution exists for the weapon speed. */
  solvable: boolean;
  /** Weapon heading (rad, NED) toward the predicted intercept point. */
  heading: number;
  /** Predicted time to intercept (s) under the CV assumption. */
  timeToIntercept: number;
  /** Predicted intercept point relative to the launch position (m). */
  interceptPoint: Vec2;
}

export interface InterceptInput {
  ownPosition: Vec2;
  track: TrackEstimate;
  weaponSpeed: number;
  /** Upper bound on solution time (s) to reject absurd geometry. */
  maxTime: number;
}

/**
 * Solves |R + V t| = Vw t for the smallest positive t and returns the
 * collision heading toward the predicted intercept point. When the weapon
 * cannot outrun the estimated contact (no real root), it falls back to
 * direct pursuit of the estimated position and reports solvable = false.
 */
export function solveIntercept(input: InterceptInput): InterceptSolution {
  const relativeX = input.track.position.x - input.ownPosition.x;
  const relativeY = input.track.position.y - input.ownPosition.y;
  const targetSpeedSquared =
    input.track.velocity.x * input.track.velocity.x +
    input.track.velocity.y * input.track.velocity.y;
  const weaponSpeedSquared = input.weaponSpeed * input.weaponSpeed;
  const rangeSquared = relativeX * relativeX + relativeY * relativeY;

  // Quadratic a t^2 + 2 b t + c = 0 with a <= 0 when the weapon is not
  // faster than the contact; only a > 0 admits a positive root.
  const a = targetSpeedSquared - weaponSpeedSquared;
  const b = relativeX * input.track.velocity.x + relativeY * input.track.velocity.y;

  let timeToIntercept = Number.NaN;
  if (a > 1e-12) {
    const discriminant = b * b - a * rangeSquared;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const t1 = (-b - root) / a;
      const t2 = (-b + root) / a;
      const candidates = [t1, t2].filter((t) => t > 0 && t <= input.maxTime);
      if (candidates.length > 0) timeToIntercept = Math.min(...candidates);
    }
  } else if (a < -1e-12) {
    // Weapon faster: a < 0 form still yields one positive root when the
    // discriminant is nonnegative; solve in the (Vw^2 - Vt^2) normalization.
    const aa = weaponSpeedSquared - targetSpeedSquared;
    const discriminant = b * b + aa * rangeSquared;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const t = (b + root) / aa;
      if (t > 0 && t <= input.maxTime) timeToIntercept = t;
    }
  }

  if (!Number.isFinite(timeToIntercept)) {
    return {
      solvable: false,
      heading: Math.atan2(relativeY, relativeX),
      timeToIntercept: Number.NaN,
      interceptPoint: { x: relativeX, y: relativeY },
    };
  }
  const interceptPoint = {
    x: relativeX + input.track.velocity.x * timeToIntercept,
    y: relativeY + input.track.velocity.y * timeToIntercept,
  };
  return {
    solvable: true,
    heading: Math.atan2(interceptPoint.y, interceptPoint.x),
    timeToIntercept,
    interceptPoint,
  };
}

export interface LaunchEnvelope {
  /** Maximum advisable launch range (m) for a fleeing contact geometry. */
  maximumRange: number | null;
  reason: string;
}

/**
 * Worst-case launch envelope: a contact fleeing directly away closes at
 * Vw - Vt, so the maximum launch range is (Vw - Vt) * endurance. Without an
 * endurance budget the envelope is limited only by the run-time cap.
 */
export function launchEnvelope(
  weaponSpeed: number,
  enduranceSeconds: number | null,
  estimatedTargetSpeed: number,
  maxRunTime: number,
): LaunchEnvelope {
  if (weaponSpeed <= estimatedTargetSpeed) {
    return { maximumRange: 0, reason: "weapon-not-faster" };
  }
  const closing = weaponSpeed - estimatedTargetSpeed;
  if (enduranceSeconds === null) {
    return {
      maximumRange: closing * maxRunTime,
      reason: "run-time-limited",
    };
  }
  return {
    maximumRange: closing * enduranceSeconds,
    reason: "endurance-limited",
  };
}
