import { describe, expect, it } from "vitest";

import { acousticChannel, soundSpeedMackenzie, thorpAbsorptionDbPerKm } from "../src/sim/acoustics";
import { createDefaultConfig } from "../src/sim/config";
import { initialVehicleState } from "../src/sim/dynamics";
import { SeededRandom } from "../src/sim/random";
import { SeekerModel } from "../src/sim/sensor";

describe("bounded analytic acoustic channel", () => {
  it("produces plausible finite sound speed and frequency-dependent absorption", () => {
    expect(soundSpeedMackenzie(10, 35, 100)).toBeCloseTo(1491.4, 0);
    expect(thorpAbsorptionDbPerKm(12)).toBeGreaterThan(thorpAbsorptionDbPerKm(1));
    expect(thorpAbsorptionDbPerKm(12)).toBeGreaterThan(0);
  });

  it("adds spreading loss and two-way propagation delay with range", () => {
    const config = createDefaultConfig();
    const near = acousticChannel(0, 500, 20, 30, config.environment!, config.acoustic!);
    const far = acousticChannel(0, 1000, 20, 30, config.environment!, config.acoustic!);
    expect(far.oneWayTransmissionLossDb).toBeGreaterThan(near.oneWayTransmissionLossDb);
    expect(far.propagationDelay).toBeCloseTo(near.propagationDelay * 2, 10);
    expect(far.detectionProbability).toBeLessThan(near.detectionProbability);
    expect(Number.isFinite(far.signalToNoiseDb)).toBe(true);
  });

  it("integrates seeded channel detection and propagation latency into observations", () => {
    const config = createDefaultConfig();
    config.sensor.dropoutProbability = 0;
    config.sensor.fovHalfAngle = Math.PI;
    config.acoustic!.sourceLevelDb = 300;
    const sensor = new SeekerModel(
      config.sensor,
      new SeededRandom(1),
      new SeededRandom(2),
      config.environment,
      config.acoustic,
      new SeededRandom(3),
    );
    const sample = sensor.sample(
      0,
      initialVehicleState(config.torpedo),
      initialVehicleState(config.target),
    );
    expect(sample?.status).toBe("locked");
    expect(sample?.observation?.acoustic).toBeDefined();
    expect(sample!.observation!.deliveredAt).toBeGreaterThan(config.sensor.latency);

    config.acoustic!.sourceLevelDb = -100;
    const weak = new SeekerModel(
      config.sensor,
      new SeededRandom(1),
      new SeededRandom(2),
      config.environment,
      config.acoustic,
      new SeededRandom(3),
    );
    expect(weak.sample(0, initialVehicleState(config.torpedo), initialVehicleState(config.target))?.status).toBe("acoustic-loss");
  });
});
