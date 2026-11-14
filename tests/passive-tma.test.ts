import { describe, expect, it } from "vitest";
import { ExtendedKalmanFilter } from "../src/sim/ekf";
import { wrapAngle } from "../src/sim/math";
import { SeededRandom } from "../src/sim/random";
import { SeekerModel } from "../src/sim/sensor";
import { MultiTargetTracker } from "../src/sim/tracker";
import { createDefaultConfig } from "../src/sim/config";
import { updateTargetPerception, initialTargetPerceptionState } from "../src/sim/target-perception";
import type { SensorObservation } from "../src/sim/types";

const vehicleAt = (x: number, y: number, depth: number, speed = 0) =>
  ({
    timestamp: 0,
    position: { x, y, z: depth },
    velocity: { x: speed, y: 0, z: 0 },
    heading: 0,
    speed,
    depth,
    depthRate: 0,
    yawRate: 0,
    dynamicsModel: "planar-2.5d",
    orientation: { w: 1, x: 0, y: 0, z: 0 },
    bodyVelocity: { x: speed, y: 0 },
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

describe("bearings-only TMA estimation", () => {
  it("converges from a wide prior under alternating own-ship legs", () => {
    const filter = new ExtendedKalmanFilter({
      accelerationNoise: 0.3,
      initialVelocityVariance: 16,
      innovationGate: 9.21,
      staleAfter: 1.5,
    });
    let own = { x: 0, y: 0, heading: 0 };
    const truth = { x: 1500, y: 300, vx: -5, vy: -2 };
    const random = new SeededRandom(7);
    const dt = 0.125;
    let id = 0;
    let finalSigma = Number.POSITIVE_INFINITY;
    let finalError = Number.POSITIVE_INFINITY;
    for (let t = dt; t <= 100; t += dt) {
      const bearingToTarget = Math.atan2(truth.y - own.y, truth.x - own.x);
      const legHeading =
        bearingToTarget + (Math.floor(t / 20) % 2 === 0 ? 0.87 : -0.87);
      own = {
        x: own.x + Math.cos(legHeading) * 18 * dt,
        y: own.y + Math.sin(legHeading) * 18 * dt,
        heading: legHeading,
      };
      truth.x += truth.vx * dt;
      truth.y += truth.vy * dt;
      const dx = truth.x - own.x;
      const dy = truth.y - own.y;
      const observation: SensorObservation = {
        id: id++,
        observedAt: t,
        deliveredAt: t + 0.1,
        bearing: wrapAngle(Math.atan2(dy, dx) - legHeading) +
          random.gaussian(0, 0.0335),
        range: 2200,
        bearingVariance: 0.0335 ** 2,
        rangeVariance: 1400 ** 2,
        bearingOnly: true,
        sensorPosition: { x: own.x, y: own.y },
        sensorHeading: legHeading,
      };
      filter.process(observation);
      const estimate = filter.estimateAt(t)!;
      finalSigma =
        2 * Math.sqrt(Math.max(0, estimate.covariance[0][0] + estimate.covariance[1][1]));
      finalError = Math.hypot(
        estimate.position.x - truth.x,
        estimate.position.y - truth.y,
      );
    }
    // Four legs of geometry diversity: the solution has collapsed.
    expect(finalSigma).toBeLessThan(150);
    expect(finalError).toBeLessThan(120);
  });
});

describe("passive seeker sampling", () => {
  const seekerWithEnvironment = () => {
    const config = createDefaultConfig();
    config.sensor.dropoutProbability = 0;
    return new SeekerModel(
      config.sensor,
      new SeededRandom(11),
      new SeededRandom(12),
      {
        temperatureC: 12,
        salinityPsu: 35,
        waterDepth: 400,
        spreadingCoefficient: 17,
      },
      {
        enabled: true,
        frequencyKhz: 8,
        sourceLevelDb: 210,
        targetStrengthDb: 10,
        ambientNoiseDb: 60,
        receiverDirectivityIndexDb: 15,
        detectionThresholdDb: 6,
        detectionTransitionDb: 3,
      },
    );
  };

  it("produces bearing-only observations for radiating contacts only", () => {
    const seeker = seekerWithEnvironment();
    const samples = seeker.samplePassive(
      0,
      vehicleAt(0, 0, 8, 18),
      [
        { state: vehicleAt(1200, 0, 40), targetStrengthDb: 10, radiatedNoiseDb: 165 },
        { state: vehicleAt(-900, 400, 30), targetStrengthDb: 10 },
      ],
      [
        { noise: new SeededRandom(1), passive: new SeededRandom(2) },
        { noise: new SeededRandom(3), passive: new SeededRandom(4) },
      ],
      { noise: new SeededRandom(0), passive: new SeededRandom(0) },
    )!;
    expect(samples).toHaveLength(2);
    const loud = samples[0];
    expect(loud.status).toBe("locked");
    expect(loud.observation?.bearingOnly).toBe(true);
    expect(loud.observation?.range).toBeGreaterThan(0); // nominal prior
    expect(loud.observation?.rangeVariance).toBeGreaterThan(1e6); // deliberately huge
    expect(loud.observation?.passiveSnrDb).toBeGreaterThan(30);
    // Passive-silent contact: never heard.
    expect(samples[1].observation).toBeNull();
  });
});

describe("weapon radiated-noise counter-detection", () => {
  const perception = { detectionThresholdDb: 45, detectionTransitionDb: 3, reactionDelay: 4, reactionGrace: 6, evasiveRate: 0.05, diveDepth: 130, bearingSigmaRad: 0.1 };
  const environment = { temperatureC: 12, salinityPsu: 35, waterDepth: 400, spreadingCoefficient: 17 };
  const acoustic = { enabled: true, frequencyKhz: 8, sourceLevelDb: 210, targetStrengthDb: 10, ambientNoiseDb: 60, receiverDirectivityIndexDb: 15, detectionThresholdDb: 6, detectionTransitionDb: 3 };

  it("hears a sprinting weapon's radiated noise but not a quiet one", () => {
    const contact = vehicleAt(1000, 0, 60);
    // Sprint: radiated 130 + 0.8*40 = 162 dB — detected essentially always.
    let state = initialTargetPerceptionState();
    for (let index = 0; index < 20; index += 1) {
      state = updateTargetPerception({
        state,
        now: index * 0.125,
        weapon: vehicleAt(600, 0, 20, 40),
        contact,
        perception,
        environment,
        acoustic,
        random: new SeededRandom(5),
        overrideSourceLevelDb: 130 + 0.8 * 40,
      });
    }
    expect(state.detectedSince).not.toBeNull();

    // Quiet search: 130 + 0.8*18 = 144.4 dB — below counter-detection.
    state = initialTargetPerceptionState();
    for (let index = 0; index < 20; index += 1) {
      state = updateTargetPerception({
        state,
        now: index * 0.125,
        weapon: vehicleAt(600, 0, 20, 18),
        contact,
        perception,
        environment,
        acoustic,
        random: new SeededRandom(5),
        overrideSourceLevelDb: 130 + 0.8 * 18,
      });
    }
    expect(state.detectedSince).toBeNull();
  });

  it("is fully silent when the policy emits nothing", () => {
    let state = initialTargetPerceptionState();
    for (let index = 0; index < 20; index += 1) {
      state = updateTargetPerception({
        state,
        now: index * 0.125,
        weapon: vehicleAt(100, 0, 20, 40),
        contact: vehicleAt(1000, 0, 60),
        perception,
        environment,
        acoustic,
        random: new SeededRandom(5),
        silent: true,
      });
    }
    expect(state.detectedSince).toBeNull();
    expect(state.heardBearing).toBeNull();
  });
});

describe("multi-hypothesis bearing-only tracking", () => {
  it("spawns range hypotheses at birth and prunes them to the truth", () => {
    const tracker = new MultiTargetTracker(
      {
        estimator: {
          accelerationNoise: 0.3,
          initialVelocityVariance: 16,
          innovationGate: 9.21,
          staleAfter: 1.5,
        },
        confirmationCount: 5,
        tentativeTimeout: 2.5,
        deletionTimeout: 6,
      },
      "ekf",
    );
    // Truth: contact at 1600 m bearing ~0. Own-ship legs diversify.
    const truth = { x: 1600, y: 100 };
    let own = { x: 0, y: 0 };
    const random = new SeededRandom(3);
    const dt = 0.125;
    let delivered = 0;
    for (let t = dt; t <= 90; t += dt) {
      const bearingToTarget = Math.atan2(truth.y - own.y, truth.x - own.x);
      const legHeading =
        bearingToTarget + (Math.floor(t / 20) % 2 === 0 ? 0.87 : -0.87);
      own = {
        x: own.x + Math.cos(legHeading) * 18 * dt,
        y: own.y + Math.sin(legHeading) * 18 * dt,
      };
      const dx = truth.x - own.x;
      const dy = truth.y - own.y;
      const observation: SensorObservation = {
        id: delivered++,
        observedAt: t,
        deliveredAt: t + 0.1,
        bearing: wrapAngle(Math.atan2(dy, dx) - legHeading) +
          random.gaussian(0, 0.0335),
        range: 2200,
        bearingVariance: 0.0335 ** 2,
        rangeVariance: 1400 ** 2,
        bearingOnly: true,
        sensorPosition: { x: own.x, y: own.y },
        sensorHeading: legHeading,
      };
      tracker.process(t + 0.1, observation);
      tracker.prune(t + 0.1);
    }
    const live = tracker.liveTracks(90);
    // The fan collapses ONTO the solution: own-ship legs make the true
    // range the only consistent hypothesis, so every survivor converges
    // to the contact — no wrong-range ghosts persist.
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(live.length).toBeLessThanOrEqual(3);
    for (const survivor of live) {
      const error = Math.hypot(
        survivor.estimate.position.x - truth.x,
        survivor.estimate.position.y - truth.y,
      );
      expect(error).toBeLessThan(200);
    }
  });
});
