import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/sim/config";
import { runHeadless, SimulationEngine } from "../src/sim/engine";
import { ContactClassifier } from "../src/sim/classify";
import { defaultDoctrine, initialTewaState, updateTewa } from "../src/sim/tewa";
import type { SimulationConfig, TrackEstimate } from "../src/sim/types";

function trackEstimate(overrides: Partial<TrackEstimate> = {}): TrackEstimate {
  return {
    timestamp: 0,
    position: { x: 1000, y: 0 },
    velocity: { x: -5, y: 0 },
    covariance: [
      [50, 0, 0, 0],
      [0, 50, 0, 0],
      [0, 0, 10, 0],
      [0, 0, 0, 10],
    ],
    age: 0.1,
    valid: true,
    source: "ekf",
    ...overrides,
  };
}

function multiConfig(overrides: {
  mode?: "ekf" | "perfect";
  doctrine?: SimulationConfig["doctrine"];
  withDecoy?: boolean;
  intercept?: number;
}): SimulationConfig {
  const base = createDefaultConfig();
  base.runtime.maxTime = 120;
  base.guidance.mode = overrides.mode ?? "ekf";
  base.interceptRadius = overrides.intercept ?? 14;
  base.weapon = {
    phases: { enableTime: 4, terminalRange: 500, reacquireAfter: 3 },
    speed: { cruiseSpeed: 30, sprintSpeed: 40 },
    endurance: { runTime: 110 },
    terminalSensor: { cadenceHz: 20, innovationGate: 9 },
    fuze: { detectionRadius: 25 },
    effectiveness: { lethalRadius: 14, shape: 2 },
  };
  base.torpedo.commandedSpeed = 30;
  base.doctrine = overrides.doctrine ?? defaultDoctrine();
  const vehicle = (x: number, y: number, heading: number, speed: number, depth: number) => {
    const v = structuredClone(base.target);
    v.initial = { position: { x, y, z: depth }, heading, speed, depth };
    v.commandedSpeed = speed;
    return v;
  };
  base.contacts = [
    {
      id: "hostile",
      kind: "hostile-sub",
      vehicle: vehicle(2000, 650, Math.PI - 0.35, 6, 30),
      targetStrengthDb: 15,
      behavior: { kind: "scripted-evasive", triggerRange: 700, rate: -0.05 },
    },
    {
      id: "friendly",
      kind: "friendly-sub",
      vehicle: vehicle(1600, -700, Math.PI, 5, 25),
      targetStrengthDb: 12,
      behavior: { kind: "constant-velocity" },
      friendlySignature: 0.9,
    },
    {
      id: "whale",
      kind: "biological",
      vehicle: vehicle(900, 900, 2.4, 1.6, 4),
      targetStrengthDb: -8,
      behavior: { kind: "biologic-wander", amplitude: 0.8, period: 35 },
    },
    {
      id: "carrier",
      kind: "commercial-surface",
      vehicle: vehicle(600, -1500, 1.2, 12, 0.5),
      targetStrengthDb: 22,
      behavior: { kind: "constant-velocity" },
    },
  ];
  if (overrides.withDecoy) {
    base.contacts.push({
      id: "decoy",
      kind: "decoy",
      vehicle: vehicle(2000, 650, Math.PI - 0.35, 4, 30),
      targetStrengthDb: 21,
      behavior: { kind: "decoy", triggerRange: 650, deploySpeed: 4, headingOffset: 0.5 },
      deployedBy: "hostile",
    });
  }
  return base;
}

describe("classification from observables", () => {
  it("separates a whale from a sub-like contact on features", () => {
    const classifier = new ContactClassifier();
    const sub = trackEstimate({ velocity: { x: -5, y: 0 } });
    const whale = trackEstimate({
      position: { x: 500, y: 200 },
      velocity: { x: -1.4, y: 0.5 },
    });
    let subClass = classifier.update(1, 0, sub, {
      impliedTargetStrengthDb: 14,
      snrDb: 10,
      signatureCorrelation: 0.1,
      observationCount: 1,
    });
    let whaleClass = classifier.update(2, 0, whale, {
      impliedTargetStrengthDb: -7,
      snrDb: 4,
      signatureCorrelation: 0.1,
      observationCount: 1,
    });
    for (let index = 1; index <= 20; index += 1) {
      subClass = classifier.update(1, index, sub, {
        impliedTargetStrengthDb: 14,
        snrDb: 10,
        signatureCorrelation: 0.1,
        observationCount: index,
      });
      whaleClass = classifier.update(2, index, whale, {
        impliedTargetStrengthDb: -7,
        snrDb: 4,
        signatureCorrelation: 0.1,
        observationCount: index,
      });
    }
    expect(subClass.best).toBe("sub-like");
    expect(subClass.confidence).toBeGreaterThan(0.6);
    expect(whaleClass.best).toBe("biological");
    expect(whaleClass.confidence).toBeGreaterThan(0.6);
  });

  it("keeps an ambiguous echo honestly uncertain", () => {
    const classifier = new ContactClassifier();
    const estimate = trackEstimate({ velocity: { x: -4, y: 0 } });
    let classification = classifier.update(1, 0, estimate, {
      impliedTargetStrengthDb: 8,
      snrDb: 6,
      signatureCorrelation: 0.1,
      observationCount: 1,
    });
    for (let index = 1; index <= 15; index += 1) {
      classification = classifier.update(1, index, estimate, {
        impliedTargetStrengthDb: 8 + 6 * Math.sin(index),
        snrDb: 6,
        signatureCorrelation: 0.1,
        observationCount: index,
      });
    }
    expect(classification.confidence).toBeLessThan(0.9);
  });
});

describe("TEWA selection and authorization", () => {
  const candidates = (ids: number[], best: string, confidence: number) =>
    ids.map((id) => ({
      trackId: id,
      estimate: trackEstimate(),
      quality: "confirmed",
      classification: {
         best,
         confidence,
         probabilities: {} as Record<string, number>,
       },
    }));

  it("never selects excluded classes", () => {
    const doctrine = defaultDoctrine();
    let state = updateTewa({
      state: initialTewaState(),
      now: 5,
      candidates: candidates([1], "biological", 0.95) as never,
      ownPosition: { x: 0, y: 0 },
      doctrine,
    });
    expect(state.designation).toBeNull();

    state = updateTewa({
      state,
      now: 10,
      candidates: candidates([2], "surface-commercial", 0.99) as never,
      ownPosition: { x: 0, y: 0 },
      doctrine,
    });
    expect(state.designation).toBeNull();
    expect(state.authorized).toBe(false);
  });

  it("authorizes autonomously only after sustained doctrine satisfaction", () => {
    const doctrine = { ...defaultDoctrine(), autoAuthorizeSustain: 3 };
    let state = initialTewaState();
    const good = candidates([1], "sub-like", 0.9) as never;
    state = updateTewa({ state, now: 1, candidates: good, ownPosition: { x: 0, y: 0 }, doctrine });
    expect(state.authorized).toBe(false);
    state = updateTewa({ state, now: 2.5, candidates: good, ownPosition: { x: 0, y: 0 }, doctrine });
    expect(state.authorized).toBe(false);
    state = updateTewa({ state, now: 4.1, candidates: good, ownPosition: { x: 0, y: 0 }, doctrine });
    expect(state.authorized).toBe(true);
    expect(state.authorizedAt).toBeGreaterThanOrEqual(4);
  });

  it("resets the satisfaction window when doctrine breaks", () => {
    const doctrine = { ...defaultDoctrine(), autoAuthorizeSustain: 2 };
    let state = initialTewaState();
    const good = candidates([1], "sub-like", 0.9) as never;
    const weak = candidates([1], "sub-like", 0.2) as never;
    state = updateTewa({ state, now: 1, candidates: good, ownPosition: { x: 0, y: 0 }, doctrine });
    state = updateTewa({ state, now: 2, candidates: weak, ownPosition: { x: 0, y: 0 }, doctrine });
    state = updateTewa({ state, now: 3.5, candidates: good, ownPosition: { x: 0, y: 0 }, doctrine });
    expect(state.authorized).toBe(false);
    state = updateTewa({ state, now: 5.4, candidates: good, ownPosition: { x: 0, y: 0 }, doctrine });
    expect(state.authorized).toBe(false);
    state = updateTewa({ state, now: 5.6, candidates: good, ownPosition: { x: 0, y: 0 }, doctrine });
    expect(state.authorized).toBe(true);
  });

  it("holds designation with hysteresis against a flickering challenger", () => {
    const doctrine = { ...defaultDoctrine(), redesignateAfter: 5, redesignateMargin: 0.5 };
    let state = initialTewaState();
    const own = { x: 0, y: 0 };
    state = updateTewa({
      state, now: 1, ownPosition: own, doctrine,
      candidates: [
        { trackId: 1, estimate: trackEstimate(), quality: "confirmed", classification: { best: "sub-like", confidence: 0.8, probabilities: {} as never } },
      ],
    });
    expect(state.designation?.trackId).toBe(1);
    // Challenger marginally better inside the hold window: no switch.
    state = updateTewa({
      state, now: 3, ownPosition: own, doctrine,
      candidates: [
        { trackId: 1, estimate: trackEstimate(), quality: "confirmed", classification: { best: "sub-like", confidence: 0.6, probabilities: {} as never } },
        { trackId: 2, estimate: trackEstimate(), quality: "confirmed", classification: { best: "sub-like", confidence: 0.75, probabilities: {} as never } },
      ],
    });
    expect(state.designation?.trackId).toBe(1);
    // After the hold window with a clear margin: switch.
    state = updateTewa({
      state, now: 8, ownPosition: own, doctrine,
      candidates: [
        { trackId: 1, estimate: trackEstimate(), quality: "confirmed", classification: { best: "sub-like", confidence: 0.3, probabilities: {} as never } },
        { trackId: 2, estimate: trackEstimate(), quality: "confirmed", classification: { best: "sub-like", confidence: 0.9, probabilities: {} as never } },
      ],
    });
    expect(state.designation?.trackId).toBe(2);
  });
});

describe("autonomous engagement integration", () => {
  it("classifies, selects, authorizes, and correctly engages the hostile", () => {
    const run = runHeadless(multiConfig({}));
    expect(run.result.terminationReason).toBe("fuzed-detonation");
    expect(run.result.engagedContact?.id).toBe("hostile");
    expect(run.result.engagementOutcome).toBe("correct-hostile");
    const stages = run.result.tewaEvents?.map((event) => event.stage);
    expect(stages).toContain("select");
    expect(stages).toContain("authorize");
  });

  it("blocks engagement in manual doctrine until the operator authorizes", () => {
    const config = multiConfig({
      doctrine: { ...defaultDoctrine(), mode: "manual" },
    });
    config.runtime.maxTime = 20;
    config.interceptRadius = 0.5;
    const run = runHeadless(config);
    // Never authorized: no engagement, run times out.
    expect(run.result.terminationReason).toBe("timeout");
    expect(run.result.engagementOutcome).toBe("miss");
    expect(run.result.tewaEvents?.every((e) => e.stage !== "authorize")).toBe(true);

    const engine = new SimulationEngine(structuredClone(config));
    for (let index = 0; index < 200 && !engine.completed; index += 1) {
      engine.step();
    }
    engine.authorize();
    expect(engine.engagementAuthorized).toBe(true);
  });

  it("can be seduced onto a decoy when classification lags", () => {
    const run = runHeadless(multiConfig({ withDecoy: true }));
    expect(["fuzed-detonation", "intercept"]).toContain(run.result.terminationReason);
    expect(run.result.engagedContact).toBeDefined();
    // Deterministic outcome for this seed/config.
    const again = runHeadless(multiConfig({ withDecoy: true }));
    expect(again.result.engagedContact).toEqual(run.result.engagedContact);
    expect(again.result.engagementOutcome).toBe(run.result.engagementOutcome);
  });

  it("skips biologics and commercial traffic in perfect mode too", () => {
    const run = runHeadless(multiConfig({ mode: "perfect" }));
    expect(run.result.terminationReason).toBe("fuzed-detonation");
    expect(run.result.engagementOutcome).toBe("correct-hostile");
    expect(run.result.engagedContact?.id).toBe("hostile");
  });

  it("reproduces the entire decision chain deterministically", () => {
    const a = runHeadless(multiConfig({ withDecoy: true }));
    const b = runHeadless(multiConfig({ withDecoy: true }));
    expect(a.result).toEqual(b.result);
  });

  it("leaves legacy runs without contacts entirely untouched", () => {
    const legacy = createDefaultConfig();
    const run = runHeadless(legacy);
    expect(run.result.terminationReason).toBe("intercept");
    expect(run.result.engagementOutcome).toBeUndefined();
    expect(run.result.tewaEvents).toBeUndefined();
    expect(run.result.elapsedTime).toBeCloseTo(40.905, 3);
  });
});
