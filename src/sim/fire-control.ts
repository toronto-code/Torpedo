import { magnitude2 } from "./math";
import { launchEnvelope, solveIntercept } from "./intercept";
import type { TrackEstimate, Vec2, WeaponSystemConfig } from "./types";

/**
 * Fire-control launch solutions.
 *
 * Every input here is a delivered TrackEstimate (the same delayed, noisy
 * track the guidance law sees) plus ownship navigation data. Nothing in
 * this module accepts target truth; solutions are frozen at launch and
 * never re-derived from ground truth later.
 */

export interface LaunchSolution {
  /** Advisory collision-course heading for the weapon (rad). */
  heading: number;
  /** Estimated run time to intercept (s); NaN when unsolvable. */
  timeToIntercept: number;
  /** Predicted intercept point relative to the launch position (m). */
  interceptPoint: Vec2;
  /** Advisory run-out duration before homing enables (s). */
  enableTime: number;
  /** Launch envelope bounds (m). */
  maximumRange: number | null;
  envelopeReason: string;
  solvable: boolean;
}

export interface FireabilityAssessment {
  fireable: boolean;
  reasons: string[];
}

export interface FireControlInput {
  ownPosition: Vec2;
  track: TrackEstimate | null;
  weapon: WeaponSystemConfig;
  /** Weapon cruise speed used for the intercept triangle (m/s). */
  weaponSpeed: number;
  maxRunTime: number;
  enduranceSeconds: number | null;
}

export function computeLaunchSolution(input: FireControlInput): LaunchSolution {
  const track = input.track;
  if (!track) {
    return {
      heading: Number.NaN,
      timeToIntercept: Number.NaN,
      interceptPoint: { x: 0, y: 0 },
      enableTime: input.weapon.phases?.enableTime ?? 0,
      maximumRange: null,
      envelopeReason: "no-track",
      solvable: false,
    };
  }
  const solution = solveIntercept({
    ownPosition: input.ownPosition,
    track,
    weaponSpeed: input.weaponSpeed,
    maxTime: input.maxRunTime,
  });
  const targetSpeed = magnitude2(track.velocity);
  const envelope = launchEnvelope(
    input.weaponSpeed,
    input.enduranceSeconds,
    targetSpeed,
    input.maxRunTime,
  );
  const configuredEnable = input.weapon.phases?.enableTime;
  const enableTime = solution.solvable && configuredEnable === undefined
    // Default advisory: enable homing shortly before the predicted
    // intercept so the seeker sees the contact from midcourse.
    ? Math.max(0, solution.timeToIntercept * 0.5)
    : (configuredEnable ?? 0);
  return {
    heading: solution.heading,
    timeToIntercept: solution.timeToIntercept,
    interceptPoint: solution.interceptPoint,
    enableTime,
    maximumRange: envelope.maximumRange,
    envelopeReason: envelope.reason,
    solvable: solution.solvable,
  };
}

/**
 * Advisory fireability of the current track: a valid, fresh, consistently
 * gating solution whose predicted intercept fits the endurance budget. The
 * worst-case envelope is advisory display data; engagement feasibility
 * against the estimated geometry is the predicted time to intercept. The
 * operator may always fire manually against this advisory.
 */
export function assessFireability(
  track: TrackEstimate | null,
  solution: LaunchSolution,
  staleAfter: number,
  enduranceSeconds: number | null,
): FireabilityAssessment {
  const reasons: string[] = [];
  if (!track) {
    reasons.push("no-track");
  } else {
    if (!track.valid) reasons.push("track-invalid");
    if (track.age > staleAfter) reasons.push("track-stale");
    if (track.observationAccepted === false) reasons.push("innovation-rejected");
  }
  if (!solution.solvable) reasons.push("no-intercept-solution");
  if (
    solution.solvable &&
    enduranceSeconds !== null &&
    solution.timeToIntercept > enduranceSeconds
  ) {
    reasons.push("outside-envelope");
  }
  return { fireable: reasons.length === 0, reasons };
}
