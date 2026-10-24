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
  /** Previous true separation (m); null before the first armed sample. */
  lastSeparation: number | null;
  insideVolume: boolean;
  /** Smallest separation observed inside the detection volume (m). */
  bestInsideSeparation: number | null;
}

export function initialFuzeState(): FuzeState {
  return {
    armed: false,
    lastSeparation: null,
    insideVolume: false,
    bestInsideSeparation: null,
  };
}

export function fuzeArmedAt(weapon: { phases?: { enableTime?: number }; fuze?: FuzeConfig }): number {
  return weapon.fuze?.armDelay ?? weapon.phases?.enableTime ?? 0;
}

export function updateFuzeArming(
  state: FuzeState,
  timestamp: number,
  armAt: number,
): FuzeState {
  if (!state.armed && timestamp >= armAt) return { ...state, armed: true };
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

export interface ProximityFuzeUpdate {
  state: FuzeState;
  detonate: boolean;
  /** Separation to report as the fuze miss distance when detonating. */
  detonationSeparation: number | null;
}

/**
 * Closest-point proximity fuze: like a real influence fuze it holds while
 * the separation still closes inside the detection volume and fires at the
 * closest point of approach (or on leaving the volume, reporting the best
 * separation seen inside, so a grazing pass still detonates). A small
 * fraction-of-radius floor guarantees a trigger on very fast fly-throughs.
 */
export function updateProximityFuze(
  state: FuzeState,
  trueSeparationMeters: number,
  fuze: FuzeConfig,
  jitterRandom?: SeededRandom,
): ProximityFuzeUpdate {
  const radius = fuze.detectionRadius ?? 0;
  const jitter = fuze.jitter ?? 0;
  const effectiveRadius =
    jitter > 0 && jitterRandom
      ? Math.max(0, radius + jitterRandom.gaussian(0, jitter))
      : radius;
  const inside = radius > 0 && trueSeparationMeters <= effectiveRadius;
  const closing =
    state.lastSeparation === null ||
    trueSeparationMeters < state.lastSeparation;
  const bestInside = inside
    ? Math.min(
        state.bestInsideSeparation ?? Number.POSITIVE_INFINITY,
        trueSeparationMeters,
      )
    : state.bestInsideSeparation;

  let detonate = false;
  let detonationSeparation: number | null = null;
  if (inside) {
    // Fire at the closest approach: separation stopped closing, or the
    // weapon is deep enough inside that waiting costs nothing.
    if (!closing || trueSeparationMeters <= radius * 0.35) {
      detonate = true;
      detonationSeparation = trueSeparationMeters;
    }
  } else if (state.insideVolume) {
    // Left the volume without a closest-point trigger (grazing geometry):
    // fire on exit at the best separation observed inside.
    detonate = true;
    detonationSeparation = bestInside ?? state.lastSeparation;
  }

  return {
    state: {
      ...state,
      lastSeparation: trueSeparationMeters,
      insideVolume: inside,
      bestInsideSeparation: bestInside,
    },
    detonate,
    detonationSeparation,
  };
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
