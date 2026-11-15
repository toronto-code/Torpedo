import { magnitude2, wrapAngle } from "./math";
import type { TrackEstimate } from "./types";
import type { TrackFeatures } from "./tracker";

/**
 * Contact classification from observables.
 *
 * Inputs are only what the weapon can measure: the track's estimated
 * kinematics (speed, heading-rate behavior) and acoustic features carried on
 * observations (implied target strength = echo level with spreading
 * removed). Ground-truth contact identity never reaches this module.
 *
 * Evidence accumulates in log-space with exponential forgetting; class
 * probabilities are a softmax over accumulated evidence. The class bands
 * below are synthetic, deliberately overlapping, and chosen so separable
 * contacts converge while genuinely ambiguous contacts (fluctuating echo,
 * borderline kinematics) stay honestly uncertain. Classification lag —
 * wrong early, converging late — is the experiment.
 */

export type ContactClass =
  | "sub-like"
  | "friendly-sub"
  | "surface-commercial"
  | "biological"
  | "decoy"
  | "unknown";

const CLASSES: ContactClass[] = [
  "sub-like",
  "friendly-sub",
  "surface-commercial",
  "biological",
  "decoy",
  "unknown",
];

interface ClassBand {
  tsCenter: number;
  tsSigma: number;
  speedCenter: number;
  speedSigma: number;
}

/** Synthetic, overlapping class bands. */
const BANDS: Record<ContactClass, ClassBand> = {
  "sub-like": { tsCenter: 14, tsSigma: 7, speedCenter: 6, speedSigma: 3 },
  "friendly-sub": { tsCenter: 13, tsSigma: 7, speedCenter: 5, speedSigma: 3 },
  "surface-commercial": { tsCenter: 18, tsSigma: 9, speedCenter: 11, speedSigma: 4 },
  biological: { tsCenter: -6, tsSigma: 7, speedCenter: 1.5, speedSigma: 1.2 },
  decoy: { tsCenter: 20, tsSigma: 6, speedCenter: 3, speedSigma: 1.5 },
  unknown: { tsCenter: 5, tsSigma: 25, speedCenter: 5, speedSigma: 12 },
};

const LEARNING_RATE = 0.35;
/** Evidence sharpening: log-likelihood gaps are scaled so separable
 *  contacts reach doctrine confidence while overlapping bands stay soft. */
const FEATURE_GAIN = 3;
/** Base evidence for any feature-explaining class. "unknown" is the
 *  fixed-evidence fallback (0) — it never accumulates feature evidence, so
 *  it wins only when no class explains the observations. */
const MATCH_BONUS = 1;

export interface TrackClassification {
  best: ContactClass;
  confidence: number;
  probabilities: Record<ContactClass, number>;
}

interface ClassifierState {
  evidence: Record<ContactClass, number>;
  lastHeading: number | null;
  lastUpdateAt: number;
  wanderAccumulator: number;
  wanderSamples: number;
}

function gaussianLogLikelihood(value: number, center: number, sigma: number): number {
  const z = (value - center) / sigma;
  return -0.5 * z * z;
}

export class ContactClassifier {
  private readonly states = new Map<number, ClassifierState>();

  update(
    trackId: number,
    now: number,
    estimate: TrackEstimate,
    features: TrackFeatures,
  ): TrackClassification {
    let state = this.states.get(trackId);
    if (!state) {
      const evidence = {} as Record<ContactClass, number>;
      for (const cls of CLASSES) evidence[cls] = 0;
      state = {
        evidence,
        lastHeading: null,
        lastUpdateAt: now,
        wanderAccumulator: 0,
        wanderSamples: 0,
      };
      this.states.set(trackId, state);
    }

    const speed = magnitude2(estimate.velocity);
    const heading = Math.atan2(estimate.velocity.y, estimate.velocity.x);
    let wanderRate = 0;
    if (state.lastHeading !== null && now > state.lastUpdateAt && speed > 0.5) {
      const dt = now - state.lastUpdateAt;
      wanderRate = Math.abs(wrapAngle(heading - state.lastHeading)) / dt;
      state.wanderAccumulator += wanderRate;
      state.wanderSamples += 1;
    }
    state.lastHeading = speed > 0.5 ? heading : state.lastHeading;
    state.lastUpdateAt = now;
    const meanWander =
      state.wanderSamples > 0
        ? state.wanderAccumulator / state.wanderSamples
        : 0;
    const impliedTs = features.impliedTargetStrengthDb;
    const tsSigma = features.impliedTsSigmaDb;
    const correlation = features.signatureCorrelation;
    const depthRate = features.depthRateMPerS;
    // Uncertainty-aware kinematics: the speed estimate carries the filter's
    // own velocity variance, so a young track (sigma of several m/s)
    // classifies honestly-uncertain — every band softens — instead of
    // snapping to whatever its noisy speed resembles. Classification
    // sharpens as the solution matures, which is the honest behavior.
    const speedVariance =
      speed > 0.5
        ? (estimate.velocity.x ** 2 * (estimate.covariance[2]?.[2] ?? 0) +
            estimate.velocity.y ** 2 * (estimate.covariance[3]?.[3] ?? 0)) /
          (speed * speed)
        : (estimate.covariance[2]?.[2] ?? 0) + (estimate.covariance[3]?.[3] ?? 0);
    for (const cls of CLASSES) {
      if (cls === "unknown") continue;
      const band = BANDS[cls];
      let likelihood = MATCH_BONUS;
      if (impliedTs !== null) {
        likelihood +=
          FEATURE_GAIN * gaussianLogLikelihood(impliedTs, band.tsCenter, band.tsSigma);
      }
      likelihood +=
        FEATURE_GAIN *
        gaussianLogLikelihood(
          speed,
          band.speedCenter,
          Math.sqrt(band.speedSigma ** 2 + speedVariance),
        );
      // Biologics wander; commercial traffic runs straight.
      if (cls === "biological") likelihood += Math.min(1.5, meanWander * 6);
      if (cls === "surface-commercial") likelihood -= Math.min(1.5, meanWander * 6);
      // Synthetic IFF analog: a strong friendly-marking correlation boosts
      // the friendly class and dampens everything else.
      if (correlation !== null) {
        if (cls === "friendly-sub") {
          likelihood += 8 * (correlation - 0.5);
        } else if (correlation > 0.5) {
          likelihood -= 4 * (correlation - 0.5);
        }
      }
      // Depth behavior (measured, not truth): sustained vertical motion is
      // submarine-like; surface traffic and decoys hold depth. Whales dive
      // gently, so biologics earn a smaller share.
      if (depthRate !== null && depthRate > 0.3) {
        const motion = Math.min(1, depthRate / 1.2);
        if (cls === "sub-like" || cls === "friendly-sub") likelihood += 1.6 * motion;
        else if (cls === "biological") likelihood += 0.6 * motion;
        else likelihood -= 0.8 * motion;
      }
      // Depth-static penalty: a long-tracked contact whose depth never
      // moves is less submarine-like — real boats trim and re-depth, while
      // decoys and fluctuators hold exactly level. Grows with evidence so
      // young tracks are unaffected.
      if (
        depthRate !== null &&
        depthRate < 0.05 &&
        features.observationCount > 30
      ) {
        const staticPenalty =
          Math.min(1, (features.observationCount - 30) / 120) * 0.9;
        if (cls === "sub-like" || cls === "friendly-sub") {
          likelihood -= staticPenalty;
        }
      }
      // Echo stability: a streaky, fluctuating return (high TS sigma) is
      // less like any clean class; smooth aspect-driven returns are.
      if (tsSigma !== null && tsSigma > 3) {
        likelihood -= Math.min(1, (tsSigma - 3) / 6);
      }
      // Passive radiated noise: an independent, non-echo axis. A contact
      // this loud is surface machinery or a vocal biological, never a
      // quiet boat; moderate broadband fits a moving vessel; near-silence
      // at speed fits a mute decoy more than a real submarine.
      if (features.passiveSnrDb !== null) {
        const passive = features.passiveSnrDb;
        if (passive > 30) {
          if (cls === "surface-commercial") likelihood += 1.5;
          else if (cls === "biological") likelihood += 0.5;
          else likelihood -= 0.8;
        } else if (passive > 5) {
          if (cls === "sub-like" || cls === "friendly-sub") likelihood += 0.6;
          else if (cls === "biological") likelihood += 0.4;
        } else if (passive < 0) {
          if (cls === "decoy") likelihood += 0.8;
          else if (cls === "sub-like") likelihood -= 0.3;
        }
      }
      state.evidence[cls] =
        state.evidence[cls] * (1 - LEARNING_RATE) + likelihood * LEARNING_RATE;
    }

    return this.classificationOf(state);
  }

  classificationFor(trackId: number): TrackClassification | null {
    const state = this.states.get(trackId);
    return state ? this.classificationOf(state) : null;
  }

  private classificationOf(state: ClassifierState): TrackClassification {
    let total = 0;
    const weights: Record<string, number> = {};
    for (const cls of CLASSES) {
      const weight = Math.exp(state.evidence[cls]);
      weights[cls] = weight;
      total += weight;
    }
    const probabilities = {} as Record<ContactClass, number>;
    let best: ContactClass = "unknown";
    let bestWeight = -1;
    for (const cls of CLASSES) {
      probabilities[cls] = weights[cls] / total;
      if (probabilities[cls] > bestWeight) {
        bestWeight = probabilities[cls];
        best = cls;
      }
    }
    return { best, confidence: bestWeight, probabilities };
  }
}
