import type { EffectivenessConfig, FuzeConfig } from "./types";
import type { SeededRandom } from "./random";

/**
 * Fuze and synthetic effectiveness.
 *
 * The fuze is the one weapon-side consumer of TRUE geometry: like the
 * acoustic channel, it is a physical proximity sensor that reacts to the
 * real target, not to an estimate. It arms on a time schedule and triggers
 * when the true 3D separation falls inside its detection radius (with
 * optional seeded actuation jitter drawn from the dedicated "fuze" stream).
 *
 * The effectiveness function is a synthetic scoring curve for algorithm
 * benchmarking: exp(-(miss / lethalRadius)^shape) with fictional constants.
 * It has no physical calibration, is consumed only by results and the UI,
 * and can never feed back into guidance, estimation, or control.
 */

export interface FuzeState {
  armed: boolean;
}

export function fuzeArmedAt(weapon: { phases?: { enableTime?: number }; fuze?: FuzeConfig }): number {
  return weapon.fuze?.armDelay ?? weapon.phases?.enableTime ?? 0;
}

export function updateFuzeArming(
  state: FuzeState,
  timestamp: number,
  armAt: number,
): FuzeState {
  if (!state.armed && timestamp >= armAt) return { armed: true };
  return state;
}

export function fuzeTriggers(
  trueSeparationMeters: number,
  fuze: FuzeConfig,
  jitterRandom?: SeededRandom,
): boolean {
  const radius = fuze.detectionRadius ?? 0;
  if (radius <= 0) return false;
  const jitter = fuze.jitter ?? 0;
  const effectiveRadius =
    jitter > 0 && jitterRandom
      ? Math.max(0, radius + jitterRandom.gaussian(0, jitter))
      : radius;
  return trueSeparationMeters <= effectiveRadius;
}

/** Synthetic point-effectiveness score in [0, 1]; fictional calibration. */
export function syntheticEffectiveness(
  missDistanceMeters: number,
  config: EffectivenessConfig,
): number {
  const lethalRadius = config.lethalRadius ?? 0;
  if (lethalRadius <= 0) return 0;
  const shape = config.shape ?? 2;
  const ratio = Math.max(0, missDistanceMeters) / lethalRadius;
  return Math.exp(-(ratio ** shape));
}
