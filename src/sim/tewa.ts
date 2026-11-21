import { magnitude2 } from "./math";
import type { ContactClass, TrackClassification } from "./classify";
import type { DoctrineConfig, TrackEstimate, Vec2 } from "./types";

/**
 * Threat evaluation, weapon-target pairing, and engagement authorization.
 *
 * Consumes classification and track state only — never truth identity. The
 * pipeline stages (select → authorize) are logged as timeline events. All
 * decisions are deterministic given the track picture.
 */

export type PipelineStage =
  | "select"
  | "relinquish"
  | "authorize"
  | "manual-override";

export interface PipelineEvent {
  stage: PipelineStage;
  at: number;
  detail: string;
}

export interface TewaCandidate {
  trackId: number;
  estimate: TrackEstimate;
  classification: TrackClassification;
  quality: string;
  /** Smoothed depression-angle depth (m down) for depth steering; measurement
   *  data, never truth. Null until a depth-bearing observation arrives. */
  depth: number | null;
  /** Sim time when the track was initiated (s) — drives the doctrine's
   *  picture-development window. */
  createdAt: number;
}

export interface TewaState {
  designation: { trackId: number; since: number } | null;
  authorized: boolean;
  authorizedAt: number | null;
  doctrineSatisfiedSince: number | null;
  events: PipelineEvent[];
}

export const HOSTILITY_WEIGHT: Record<ContactClass, number> = {
  "sub-like": 1,
  "friendly-sub": 0,
  "surface-commercial": 0,
  biological: 0,
  decoy: 0.25,
  unknown: 0,
};

export function defaultDoctrine(): DoctrineConfig {
  return {
    mode: "autonomous",
    requiredConfidence: 0.6,
    excludedClasses: [
      "friendly-sub",
      "surface-commercial",
      "biological",
      "unknown",
      "decoy",
    ],
    autoAuthorizeSustain: 3,
    redesignateAfter: 5,
    redesignateMargin: 1,
  };
}

export function initialTewaState(): TewaState {
  return {
    designation: null,
    authorized: false,
    authorizedAt: null,
    doctrineSatisfiedSince: null,
    events: [],
  };
}

function qualityFactor(quality: string): number {
  if (quality === "confirmed") return 1;
  if (quality === "coasting") return 0.6;
  return 0.4;
}

/** Doctrine kinematic override: classification can call a fast contact a
 *  merchant, but speed is a threat cue no label overrules — a surface
 *  contact at warship speed remains an engagement candidate (real
 *  doctrine: warships hide among merchant traffic; speed betrays them). */
export const FAST_SURFACE_THRESHOLD_MS = 15;

function threatEligible(
  candidate: TewaCandidate,
  doctrine: DoctrineConfig,
): boolean {
  const excluded = doctrine.excludedClasses.includes(
    candidate.classification.best,
  );
  if (!excluded) return HOSTILITY_WEIGHT[candidate.classification.best] > 0;
  if (candidate.classification.best !== "surface-commercial") return false;
  // Uncertainty-aware: a young, noisy velocity estimate cannot prove
  // warship speed — the lower confidence bound must clear the bar.
  const speed = magnitude2(candidate.estimate.velocity);
  const velocitySigma = Math.sqrt(
    Math.max(
      0,
      (candidate.estimate.covariance[2]?.[2] ?? 0) +
        (candidate.estimate.covariance[3]?.[3] ?? 0),
    ),
  );
  return speed - 2 * velocitySigma >= FAST_SURFACE_THRESHOLD_MS;
}

export function candidateScore(
  candidate: TewaCandidate,
  ownPosition: Vec2,
): number {
  const range = Math.max(
    1,
    Math.hypot(
      candidate.estimate.position.x - ownPosition.x,
      candidate.estimate.position.y - ownPosition.y,
    ),
  );
  const geometry = 1 / (1 + range / 2000);
  return (
    HOSTILITY_WEIGHT[candidate.classification.best] *
    candidate.classification.confidence *
    qualityFactor(candidate.quality) *
    geometry
  );
}

export interface TewaUpdateInput {
  state: TewaState;
  now: number;
  candidates: TewaCandidate[];
  ownPosition: Vec2;
  doctrine: DoctrineConfig;
}

export function updateTewa(input: TewaUpdateInput): TewaState {
  const state: TewaState = {
    ...input.state,
    designation: input.state.designation ? { ...input.state.designation } : null,
    events: [...input.state.events],
  };

  const eligible = input.candidates.filter((candidate) =>
    threatEligible(candidate, input.doctrine),
  );
  const scored = eligible
    .map((candidate) => ({
      candidate,
      score: candidateScore(candidate, input.ownPosition),
    }))
    .sort(
      (a, b) =>
        b.score - a.score || a.candidate.trackId - b.candidate.trackId,
    );

  const current = state.designation
    ? input.candidates.find(
        (candidate) => candidate.trackId === state.designation!.trackId,
      )
    : null;

  if (state.designation && !current) {
    state.events.push({
      stage: "relinquish",
      at: input.now,
      detail: `track ${state.designation.trackId} lost`,
    });
    state.designation = null;
  }

  if (scored.length > 0) {
    const best = scored[0];
    if (!state.designation) {
      // Post-authorization re-selection may carry an evidence floor (see
      // DoctrineConfig): a track born seconds ago has not had time for
      // slow evidence to classify it away from sub-like.
      const floorAge = input.doctrine.postAuthDesignationAgeS ?? 0;
      const candidate =
        state.authorized && floorAge > 0
          ? scored.find(
              (entry) =>
                input.now - entry.candidate.createdAt >= floorAge,
            ) ?? null
          : best;
      if (!candidate) {
        // Nothing mature enough to re-designate: search on, hold fire.
      } else {
      state.designation = { trackId: candidate.candidate.trackId, since: input.now };
      state.events.push({
        stage: "select",
        at: input.now,
        detail: `track ${candidate.candidate.trackId} (${candidate.candidate.classification.best}, confidence ${candidate.candidate.classification.confidence.toFixed(2)})`,
      });
      }
    } else if (
      !state.authorized &&
      current &&
      best.candidate.trackId !== state.designation.trackId &&
      input.now - state.designation.since >= input.doctrine.redesignateAfter
    ) {
      // Redesignation only happens before authorization: once a weapon is
      // committed, it stays paired with its designated track until that
      // track is lost. Mid-flight retargeting is an operator action.
      const currentScore = candidateScore(current, input.ownPosition);
      if (best.score > currentScore * (1 + input.doctrine.redesignateMargin)) {
        state.events.push({
          stage: "select",
          at: input.now,
          detail: `redesignate ${state.designation.trackId} -> ${best.candidate.trackId}`,
        });
        state.designation = {
          trackId: best.candidate.trackId,
          since: input.now,
        };
      }
    }
  }

  // Doctrine satisfaction for authorization.
  const designated = state.designation
    ? input.candidates.find(
        (candidate) => candidate.trackId === state.designation!.trackId,
      )
    : null;
  let satisfied = false;
  if (designated) {
    const range = magnitude2({
      x: designated.estimate.position.x - input.ownPosition.x,
      y: designated.estimate.position.y - input.ownPosition.y,
    });
    const solutionSigma =
      input.doctrine.maxSolutionSigmaM === undefined
        ? null
        : 2 *
          Math.sqrt(
            Math.max(
              0,
              (designated.estimate.covariance[0]?.[0] ?? 0) +
                (designated.estimate.covariance[1]?.[1] ?? 0),
            ),
          );
    satisfied =
      designated.classification.confidence >=
        input.doctrine.requiredConfidence &&
      threatEligible(designated, input.doctrine) &&
      (input.doctrine.engagementMaxRange === undefined ||
        range <= input.doctrine.engagementMaxRange) &&
      (input.doctrine.minTrackAgeS === undefined ||
        input.now - designated.createdAt >= input.doctrine.minTrackAgeS) &&
      (solutionSigma === null ||
        input.doctrine.maxSolutionSigmaM === undefined ||
        solutionSigma <= input.doctrine.maxSolutionSigmaM);
  }

  if (!state.authorized) {
    if (satisfied && state.doctrineSatisfiedSince === null) {
      state.doctrineSatisfiedSince = input.now;
    } else if (!satisfied) {
      state.doctrineSatisfiedSince = null;
    }
    if (
      input.doctrine.mode === "autonomous" &&
      satisfied &&
      state.doctrineSatisfiedSince !== null &&
      input.now - state.doctrineSatisfiedSince >=
        input.doctrine.autoAuthorizeSustain
    ) {
      state.authorized = true;
      state.authorizedAt = input.now;
      state.events.push({
        stage: "authorize",
        at: input.now,
        detail: `autonomous, track ${state.designation?.trackId}`,
      });
    }
  }

  return state;
}

/** Manual authorization (operator override). */
export function manualAuthorize(state: TewaState, now: number): TewaState {
  if (state.authorized) return state;
  return {
    ...state,
    authorized: true,
    authorizedAt: now,
    events: [
      ...state.events,
      { stage: "manual-override", at: now, detail: "operator authorized" },
    ],
  };
}
