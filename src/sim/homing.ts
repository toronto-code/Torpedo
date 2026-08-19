import type { HomingPhase, TrackEstimate, WeaponSystemConfig } from "./types";

/**
 * Deterministic weapon homing phase machine.
 *
 * Phase decisions consume only TrackEstimate usability and the frozen
 * launch solution — never target truth. Given the same observation stream
 * the phase timeline is identical across runs.
 */

export interface HomingState {
  phase: HomingPhase;
  enteredPhaseAt: number;
  /** Phase to resume after reacquisition completes. */
  resumePhase: HomingPhase;
  /** Timestamp of the last usable track (null before the first one). */
  lastUsableTrackAt: number | null;
}

export interface PhaseTransition {
  phase: HomingPhase;
  startedAt: number;
  reason: string;
}

export function initialHomingState(): HomingState {
  return {
    phase: "run-out",
    enteredPhaseAt: 0,
    resumePhase: "homing",
    lastUsableTrackAt: null,
  };
}

/**
 * A track is usable when its latest observation was accepted and its age
 * stays within the staleness bound. The caller passes
 * estimator.staleAfter plus the modeled delivery delay of the last
 * observation, because delivered observations are backdated by sensor
 * latency and acoustic propagation — a fresh-but-delayed observation must
 * not count as stale. In terminal, the stricter association gate also
 * applies. This is a decision-layer gate; the EKF itself is never modified.
 */
export function trackUsable(
  track: TrackEstimate | null,
  phase: HomingPhase,
  weapon: WeaponSystemConfig,
  stalenessBound: number,
): boolean {
  if (!track) return false;
  if (track.observationAccepted === false) return false;
  if (track.age > stalenessBound) return false;
  const terminalGate = weapon.terminalSensor?.innovationGate;
  if (phase === "terminal" && terminalGate !== undefined && track.nis !== undefined) {
    if (track.nis > terminalGate) return false;
  }
  return true;
}

export interface PhaseUpdate {
  state: HomingState;
  transition: PhaseTransition | null;
}

export interface PhaseUpdateInput {
  state: HomingState;
  timestamp: number;
  track: TrackEstimate | null;
  /** Estimated range to the contact (m), when a track exists. */
  estimatedRange: number | null;
  /** Distance travelled since launch (m). */
  distanceTravelled: number;
  weapon: WeaponSystemConfig;
  /** estimator.staleAfter plus the last observation's delivery delay (s). */
  stalenessBound: number;
}

export function updateHomingPhase(input: PhaseUpdateInput): PhaseUpdate {
  const phases = input.weapon.phases;
  if (!phases) {
    return { state: input.state, transition: null };
  }
  const state: HomingState = { ...input.state };
  const usable = trackUsable(
    input.track,
    state.phase,
    input.weapon,
    input.stalenessBound,
  );
  if (usable) state.lastUsableTrackAt = input.timestamp;

  const transition = (phase: HomingPhase, reason: string): PhaseUpdate => {
    state.phase = phase;
    state.enteredPhaseAt = input.timestamp;
    return {
      state,
      transition: { phase, startedAt: input.timestamp, reason },
    };
  };

  const runOutComplete =
    phases.enableTime !== undefined
      ? input.timestamp >= phases.enableTime
      : phases.enableDistance !== undefined
        ? input.distanceTravelled >= phases.enableDistance
        : true;

  switch (state.phase) {
    case "run-out":
      if (runOutComplete) {
        state.resumePhase = "homing";
        return transition("homing", "enabled");
      }
      return { state, transition: null };
    case "homing":
    case "terminal": {
      if (state.phase === "homing") {
        const terminalRange = phases.terminalRange;
        if (
          terminalRange !== undefined &&
          input.estimatedRange !== null &&
          input.estimatedRange <= terminalRange
        ) {
          state.resumePhase = "terminal";
          return transition("terminal", "terminal-gate");
        }
      }
      const reacquireAfter = phases.reacquireAfter;
      const lostFor =
        state.lastUsableTrackAt === null
          ? input.timestamp
          : input.timestamp - state.lastUsableTrackAt;
      if (reacquireAfter !== undefined && lostFor > reacquireAfter) {
        return transition("reacquisition", "track-lost");
      }
      return { state, transition: null };
    }
    case "reacquisition":
      if (usable) {
        return transition(state.resumePhase, "reacquired");
      }
      return { state, transition: null };
  }
}
