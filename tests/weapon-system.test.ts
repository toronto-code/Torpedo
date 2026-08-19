import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/sim/config";
import { runHeadless, SimulationEngine } from "../src/sim/engine";
import {
  assessFireability,
  computeLaunchSolution,
} from "../src/sim/fire-control";
import {
  fuzeTriggers,
  syntheticEffectiveness,
  updateFuzeArming,
} from "../src/sim/fuze";
import {
  initialHomingState,
  trackUsable,
  updateHomingPhase,
} from "../src/sim/homing";
import { solveIntercept, launchEnvelope } from "../src/sim/intercept";
import type {
  TrackEstimate,
  WeaponSystemConfig,
} from "../src/sim/types";

function track(overrides: Partial<TrackEstimate> = {}): TrackEstimate {
  return {
    timestamp: 0,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    covariance: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    age: 0,
    valid: true,
    source: "ekf",
    ...overrides,
  };
}

const weapon: WeaponSystemConfig = {
  phases: { enableTime: 4, terminalRange: 400, reacquireAfter: 2 },
  speed: { cruiseSpeed: 30, sprintSpeed: 40 },
  endurance: { runTime: 90 },
  terminalSensor: { cadenceHz: 20, innovationGate: 6 },
  fuze: { detectionRadius: 18 },
  effectiveness: { lethalRadius: 12, shape: 2 },
};

function weaponConfig() {
  const config = createDefaultConfig();
  config.runtime.maxTime = 120;
  config.weapon = structuredClone(weapon);
  config.torpedo.commandedSpeed = 30;
  return config;
}

describe("intercept geometry", () => {
  it("solves the head-on triangle exactly", () => {
    const solution = solveIntercept({
      ownPosition: { x: 0, y: 0 },
      track: track({ position: { x: 2000, y: 0 }, velocity: { x: -10, y: 0 } }),
      weaponSpeed: 40,
      maxTime: 200,
    });
    expect(solution.solvable).toBe(true);
    // Closing speed 50 m/s over 2000 m.
    expect(solution.timeToIntercept).toBeCloseTo(40, 9);
    expect(solution.heading).toBeCloseTo(0, 9);
  });

  it("solves the beam (crossing) triangle with the law of sines", () => {
    // Contact 1500 m east crossing due north at 15 m/s; weapon at 30 m/s.
    const solution = solveIntercept({
      ownPosition: { x: 0, y: 0 },
      track: track({ position: { x: 0, y: 1500 }, velocity: { x: 15, y: 0 } }),
      weaponSpeed: 30,
      maxTime: 200,
    });
    expect(solution.solvable).toBe(true);
    // The intercept closes: hypot(15t, 1500) = 30t -> t = 57.735 s, north
    // leg 866 m. Heading = atan2(East, North) = atan2(1500, 866) = 60 deg.
    expect(solution.timeToIntercept).toBeCloseTo(1500 / Math.sqrt(30 ** 2 - 15 ** 2), 9);
    expect(solution.heading).toBeCloseTo(Math.PI / 3, 9);
    expect(solution.interceptPoint.x).toBeCloseTo(
      15 * solution.timeToIntercept,
      6,
    );
    expect(solution.interceptPoint.y).toBeCloseTo(1500, 6);
    expect(Math.hypot(solution.interceptPoint.x, solution.interceptPoint.y))
      .toBeCloseTo(30 * solution.timeToIntercept, 6);
  });

  it("reports unsolvable when the weapon cannot close a stern chase", () => {
    const solution = solveIntercept({
      ownPosition: { x: 0, y: 0 },
      track: track({ position: { x: 1000, y: 0 }, velocity: { x: 50, y: 0 } }),
      weaponSpeed: 40,
      maxTime: 200,
    });
    expect(solution.solvable).toBe(false);
  });

  it("bounds the launch envelope by endurance against a fleeing contact", () => {
    expect(launchEnvelope(40, 600, 10, 120).maximumRange).toBeCloseTo(30 * 600, 9);
    expect(launchEnvelope(40, null, 10, 120).maximumRange).toBeCloseTo(30 * 120, 9);
    expect(launchEnvelope(10, 600, 40, 120).maximumRange).toBe(0);
  });
});

describe("fire-control solution and fireability", () => {
  it("derives the solution only from track inputs", () => {
    const solution = computeLaunchSolution({
      ownPosition: { x: 0, y: 0 },
      track: track({ position: { x: 2000, y: 0 }, velocity: { x: -10, y: 0 } }),
      weapon,
      weaponSpeed: 30,
      maxRunTime: 120,
      enduranceSeconds: 90,
    });
    expect(solution.solvable).toBe(true);
    expect(solution.timeToIntercept).toBeCloseTo(2000 / 40, 9);
    // Configured enableTime wins over the half-run heuristic.
    expect(solution.enableTime).toBe(4);
    const heuristic = computeLaunchSolution({
      ownPosition: { x: 0, y: 0 },
      track: track({ position: { x: 2000, y: 0 }, velocity: { x: -10, y: 0 } }),
      weapon: { ...weapon, phases: { terminalRange: 400, reacquireAfter: 2 } },
      weaponSpeed: 30,
      maxRunTime: 120,
      enduranceSeconds: 90,
    });
    expect(heuristic.enableTime).toBeCloseTo(heuristic.timeToIntercept * 0.5, 9);
    expect(
      assessFireability(
        track({ position: { x: 2000, y: 0 }, velocity: { x: -10, y: 0 } }),
        solution,
        1.5,
        90,
      ).fireable,
    ).toBe(true);
  });

  it("flags stale, rejected, and outside-envelope tracks as not fireable", () => {
    const solution = computeLaunchSolution({
      ownPosition: { x: 0, y: 0 },
      track: track({ position: { x: 2000, y: 0 }, velocity: { x: -10, y: 0 } }),
      weapon,
      weaponSpeed: 30,
      maxRunTime: 120,
      enduranceSeconds: 10,
    });
    // Predicted intercept at 50 s exceeds the 10 s endurance budget.
    const assessment = assessFireability(
      track({ position: { x: 2000, y: 0 }, velocity: { x: -10, y: 0 } }),
      solution,
      1.5,
      10,
    );
    expect(assessment.fireable).toBe(false);
    expect(assessment.reasons).toContain("outside-envelope");

    const stale = assessFireability(track({ age: 3, valid: false }), solution, 1.5, 90);
    expect(stale.reasons).toContain("track-invalid");
    expect(stale.reasons).toContain("track-stale");

    const rejected = assessFireability(
      track({ age: 0.2, observationAccepted: false }),
      solution,
      1.5,
      90,
    );
    expect(rejected.reasons).toContain("innovation-rejected");
  });
});

describe("homing phase machine", () => {
  it("transitions run-out to homing on the enable schedule", () => {
    let state = initialHomingState();
    const first = updateHomingPhase({
      state,
      timestamp: 1,
      track: null,
      estimatedRange: null,
      distanceTravelled: 30,
      weapon,
      stalenessBound: 1.5,
    });
    expect(first.transition).toBeNull();
    state = first.state;
    const second = updateHomingPhase({
      state,
      timestamp: 4,
      track: null,
      estimatedRange: null,
      distanceTravelled: 120,
      weapon,
      stalenessBound: 1.5,
    });
    expect(second.transition?.phase).toBe("homing");
    expect(second.transition?.reason).toBe("enabled");
  });

  it("enters terminal on the range gate and applies the stricter NIS gate", () => {
    const state = { ...initialHomingState(), phase: "homing" as const, enteredPhaseAt: 4 };
    const goodTrack = track({ position: { x: 350, y: 0 }, nis: 4 });
    expect(trackUsable(goodTrack, "terminal", weapon, 1.5)).toBe(true);
    expect(trackUsable(track({ nis: 12 }), "terminal", weapon, 1.5)).toBe(false);
    expect(trackUsable(track({ nis: 12 }), "homing", weapon, 1.5)).toBe(true);
    expect(trackUsable(track({ age: 5 }), "homing", weapon, 1.5)).toBe(false);
    expect(trackUsable(track({ age: 5 }), "homing", weapon, 6.5)).toBe(true);
    expect(trackUsable(track({ observationAccepted: false }), "homing", weapon, 1.5)).toBe(false);
    const update = updateHomingPhase({
      state,
      timestamp: 10,
      track: goodTrack,
      estimatedRange: 350,
      distanceTravelled: 400,
      weapon,
      stalenessBound: 1.5,
    });
    expect(update.transition?.phase).toBe("terminal");
    expect(update.transition?.reason).toBe("terminal-gate");
  });

  it("loses and reacquires the track deterministically", () => {
    let state: ReturnType<typeof initialHomingState> = {
      ...initialHomingState(),
      phase: "homing",
      enteredPhaseAt: 4,
      lastUsableTrackAt: 10,
    };
    const lost = updateHomingPhase({
      state,
      timestamp: 12.5,
      track: null,
      estimatedRange: null,
      distanceTravelled: 500,
      weapon,
      stalenessBound: 1.5,
    });
    expect(lost.transition?.phase).toBe("reacquisition");
    state = lost.state;
    const reacquired = updateHomingPhase({
      state,
      timestamp: 13,
      track: track({ position: { x: 100, y: 0 } }),
      estimatedRange: 100,
      distanceTravelled: 520,
      weapon,
      stalenessBound: 1.5,
    });
    expect(reacquired.transition?.phase).toBe("homing");
    expect(reacquired.transition?.reason).toBe("reacquired");
  });

  it("run-out ignores track loss", () => {
    const update = updateHomingPhase({
      state: initialHomingState(),
      timestamp: 1,
      track: null,
      estimatedRange: null,
      distanceTravelled: 10,
      weapon,
      stalenessBound: 1.5,
    });
    expect(update.transition).toBeNull();
    expect(update.state.phase).toBe("run-out");
  });
});

describe("fuze and synthetic effectiveness", () => {
  it("arms on schedule and triggers inside the detection radius", () => {
    let state = { armed: false };
    state = updateFuzeArming(state, 3.9, 4);
    expect(state.armed).toBe(false);
    state = updateFuzeArming(state, 4.0, 4);
    expect(state.armed).toBe(true);
    expect(fuzeTriggers(15, { detectionRadius: 18 })).toBe(true);
    expect(fuzeTriggers(20, { detectionRadius: 18 })).toBe(false);
    expect(fuzeTriggers(15, {})).toBe(false);
  });

  it("scores synthetic effectiveness as a smooth decreasing function", () => {
    const config = { lethalRadius: 10, shape: 2 };
    expect(syntheticEffectiveness(0, config)).toBeCloseTo(1, 12);
    expect(syntheticEffectiveness(10, config)).toBeCloseTo(Math.exp(-1), 12);
    expect(syntheticEffectiveness(40, config)).toBeCloseTo(Math.exp(-16), 12);
    expect(syntheticEffectiveness(10, {})).toBe(0);
  });
});

describe("weapon engagement integration", () => {
  it("executes the full phase timeline and detonates the fuze", () => {
    const run = runHeadless(weaponConfig());
    expect(run.result.terminationReason).toBe("fuzed-detonation");
    expect(run.result.fuzeMissDistance).toBeDefined();
    expect(run.result.fuzeMissDistance!).toBeLessThanOrEqual(18);
    expect(run.result.effectivenessScore).toBeGreaterThanOrEqual(0);
    expect(run.result.effectivenessScore!).toBeLessThanOrEqual(1);
    const phases = run.result.phaseTimeline!.map((entry) => entry.phase);
    expect(phases[0]).toBe("run-out");
    expect(phases).toContain("homing");
    expect(phases).toContain("terminal");
  });

  it("holds run-out on the fire-control heading before homing", () => {
    const config = weaponConfig();
    config.guidance.mode = "perfect";
    const engine = new SimulationEngine(config);
    // Before enable, guidance is idle toward the frozen solution heading.
    engine.step();
    const early = engine.currentSnapshot();
    expect(early.weapon?.phase).toBe("run-out");
    // The first guidance update happens at tick 0 with the launch solution.
    expect(early.guidance.lateralAcceleration).toBe(0);
  });

  it("keeps observation delivery monotonic across the terminal cadence switch", () => {
    const run = runHeadless(weaponConfig());
    const weaponSamples = run.telemetry.filter((s) => s.weapon);
    expect(weaponSamples.length).toBeGreaterThan(10);
    let previous = 0;
    for (const sample of run.telemetry) {
      expect(sample.timestamp).toBeGreaterThanOrEqual(previous);
      previous = sample.timestamp;
    }
    // Phase timeline must be strictly time-ordered.
    const timeline = run.result.phaseTimeline!;
    for (let index = 1; index < timeline.length; index += 1) {
      expect(timeline[index].startedAt).toBeGreaterThan(timeline[index - 1].startedAt);
    }
  });

  it("terminates on endurance exhaustion when the target runs far", () => {
    const config = weaponConfig();
    config.weapon!.endurance = { runTime: 20 };
    config.weapon!.fuze = { detectionRadius: 0 };
    config.interceptRadius = 0.5;
    config.target.commandedSpeed = 17;
    config.target.initial.speed = 17;
    const run = runHeadless(config);
    expect(run.result.terminationReason).toBe("endurance-exhausted");
    expect(run.result.elapsedTime).toBeGreaterThanOrEqual(20);
  });

  it("reproduces identical phase timelines and results for identical seeds", () => {
    const a = runHeadless(weaponConfig());
    const b = runHeadless(weaponConfig());
    expect(a.result).toEqual(b.result);
    expect(a.telemetry.length).toBe(b.telemetry.length);
  });

  it("leaves legacy configurations completely untouched", () => {
    const legacy = createDefaultConfig();
    expect(legacy.weapon).toBeUndefined();
    const run = runHeadless(legacy);
    expect(run.result.terminationReason).toBe("intercept");
    expect(run.result.phaseTimeline).toBeUndefined();
    expect(run.result.fuzeMissDistance).toBeUndefined();
    expect(run.telemetry.every((sample) => sample.weapon === undefined)).toBe(true);
  });
});
