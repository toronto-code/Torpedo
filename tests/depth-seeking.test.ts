import { describe, expect, it } from "vitest";
import { createAmbiguityScenarioConfig } from "../src/sim/scenarios";
import { runHeadless } from "../src/sim/engine";
import { MultiTargetTracker } from "../src/sim/tracker";
import { SeekerModel } from "../src/sim/sensor";
import { SeededRandom } from "../src/sim/random";
import { createDefaultConfig } from "../src/sim/config";
import {
  initialFuzeState,
  updateProximityFuze,
} from "../src/sim/fuze";
import type { SensorObservation, VehicleState } from "../src/sim/types";

const vehicleAt = (
  x: number,
  y: number,
  depth: number,
): VehicleState =>
  ({
    timestamp: 0,
    position: { x, y, z: depth },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    speed: 0,
    depth,
    depthRate: 0,
    yawRate: 0,
    dynamicsModel: "planar-2.5d",
    orientation: { w: 1, x: 0, y: 0, z: 0 },
    bodyVelocity: { x: 0, y: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    actuator: {
      yawRateCommand: 0,
      depthRateCommand: 0,
      speedCommand: 0,
      saturated: false,
      rudderAngle: 0,
      elevatorAngle: 0,
      propulsionForce: 0,
      controlEffort: 0,
      trackingError: 0,
    },
  }) as never;

describe("depth observability", () => {
  it("reports noisy contact depth only from a dedicated stream", () => {
    const config = createDefaultConfig();
    config.sensor.depthSigmaM = 4;
    const seeker = new SeekerModel(
      config.sensor,
      new SeededRandom(11),
      new SeededRandom(12),
    );
    const sensor = vehicleAt(0, 0, 8);
    const contact = vehicleAt(500, 0, 130);
    const depthRandom = new SeededRandom(77);
    const streams = [
      {
        noise: new SeededRandom(1),
        dropout: new SeededRandom(2),
        channel: new SeededRandom(3),
        depth: depthRandom,
      },
    ];
    const samples = seeker.sampleContacts(
      0,
      sensor,
      [{ state: contact, targetStrengthDb: 12 }],
      streams,
      { noise: new SeededRandom(0), dropout: new SeededRandom(0), channel: new SeededRandom(0) },
    )!;
    expect(samples).toHaveLength(1);
    const observation = samples[0].observation as SensorObservation;
    expect(observation.targetDepth).toBeDefined();
    expect(Math.abs(observation.targetDepth! - 130)).toBeLessThan(20);

    // The legacy single-return path never reports depth and never consumes
    // draws from the shared noise stream.
    const legacy = new SeekerModel(
      { ...config.sensor, depthSigmaM: undefined },
      new SeededRandom(11),
      new SeededRandom(12),
    );
    const legacySample = legacy.sample(0, sensor, contact)!;
    expect(legacySample.observation?.targetDepth).toBeUndefined();
  });

  it("smooths depth per track and exposes it for depth steering", () => {
    const tracker = new MultiTargetTracker(
      {
        estimator: createDefaultConfig().estimator,
        confirmationCount: 2,
        tentativeTimeout: 2.5,
        deletionTimeout: 6,
      },
      "ekf",
    );
    let observed = 0;
    for (let index = 0; index < 20; index += 1) {
      const observation: SensorObservation = {
        id: index,
        observedAt: index * 0.125,
        deliveredAt: index * 0.125 + 0.1,
        bearing: 0.05,
        range: 1000 - index,
        bearingVariance: 0.0001,
        rangeVariance: 64,
        sensorPosition: { x: 0, y: 0 },
        sensorHeading: 0,
        targetDepth: 40 + index * 0.5, // steady dive 0.5 m per sample
      };
      const result = tracker.process(index * 0.125 + 0.1, observation);
      if (result.accepted) observed += 1;
    }
    expect(observed).toBeGreaterThan(10);
    const live = tracker.liveTracks(20);
    expect(live.length).toBeGreaterThan(0);
    const depth = tracker.depthForTrack(live[0].meta.id);
    expect(depth).not.toBeNull();
    // EMA tracks a 1 m/s dive with modest lag, far from the initial value.
    expect(depth!).toBeGreaterThan(40);
    expect(depth!).toBeLessThan(52);
  });
});

describe("closest-point proximity fuze", () => {
  it("holds while closing and fires at the closest approach", () => {
    let state = initialFuzeState();
    state = { ...state, armed: true };
    // Approach 40 -> 12 -> 15 (opening): no fire while closing, fire at open.
    const closing = updateProximityFuze(state, 40, { detectionRadius: 25 });
    expect(closing.detonate).toBe(false);
    state = closing.state;
    const near = updateProximityFuze(state, 12, { detectionRadius: 25 });
    expect(near.detonate).toBe(false);
    state = near.state;
    const opening = updateProximityFuze(state, 13, { detectionRadius: 25 });
    expect(opening.detonate).toBe(true);
    expect(opening.detonationSeparation).toBe(13);
  });

  it("fires immediately deep inside the volume", () => {
    const state = { ...initialFuzeState(), armed: true };
    const update = updateProximityFuze(state, 5, { detectionRadius: 25 });
    expect(update.detonate).toBe(true);
    expect(update.detonationSeparation).toBe(5);
  });

  it("detonates at the first opening sample after a grazing pass", () => {
    let state = { ...initialFuzeState(), armed: true };
    for (const separation of [26, 24, 23.5, 24.2]) {
      const update = updateProximityFuze(state, separation, { detectionRadius: 25 });
      state = update.state;
      if (separation !== 24.2) expect(update.detonate).toBe(false);
      else {
        expect(update.detonate).toBe(true);
        expect(update.detonationSeparation).toBe(24.2);
      }
    }
  });
});

describe("weapon dives with a designated deep contact", () => {
  it("default preset: weapon reaches the hostile's depth band before the fuze fires", () => {
    const config = createAmbiguityScenarioConfig("high-ambiguity", 20260816);
    const run = runHeadless(config);
    const result = run.result;
    expect(result.terminationReason).toBe("fuzed-detonation");
    expect(result.engagementOutcome).toBe("correct-hostile");
    // The fuze reports the true closest approach, not its trigger radius.
    expect(result.fuzeMissDistance!).toBeLessThan(15);
    // Effectiveness calibrated against the 14 m lethal radius.
    expect(result.effectivenessScore!).toBeGreaterThan(0.5);
    // The weapon actually descended with the target across the run.
    const final = run.telemetry[run.telemetry.length - 1];
    const hostile = final.contacts!.find((contact) => contact.id === "hostile")!;
    expect(Math.abs(final.torpedo.depth - hostile.depth)).toBeLessThan(60);
  });

  it("is deterministic per seed", () => {
    const config = createAmbiguityScenarioConfig("crossing-subs", 4242);
    const first = runHeadless(config).result;
    const second = runHeadless(config).result;
    expect(second.terminationReason).toEqual(first.terminationReason);
    expect(second.fuzeMissDistance).toEqual(first.fuzeMissDistance);
    expect(second.engagedContact).toEqual(first.engagedContact);
  });
});
