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

  const eligible = input.candidates.filter(
    (candidate) =>
      !input.doctrine.excludedClasses.includes(candidate.classification.best) &&
      HOSTILITY_WEIGHT[candidate.classification.best] > 0,
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
      state.designation = { trackId: best.candidate.trackId, since: input.now };
      state.events.push({
        stage: "select",
        at: input.now,
        detail: `track ${best.candidate.trackId} (${best.candidate.classification.best}, confidence ${best.candidate.classification.confidence.toFixed(2)})`,
      });
    } else if (
      current &&
      best.candidate.trackId !== state.designation.trackId &&
      input.now - state.designation.since >= input.doctrine.redesignateAfter
    ) {
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
    satisfied =
      designated.classification.confidence >=
        input.doctrine.requiredConfidence &&
      !input.doctrine.excludedClasses.includes(
        designated.classification.best,
      ) &&
      (input.doctrine.engagementMaxRange === undefined ||
        range <= input.doctrine.engagementMaxRange);
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
