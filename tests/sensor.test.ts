import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/sim/config";
import { initialVehicleState } from "../src/sim/dynamics";
import { SeededRandom } from "../src/sim/random";
import { SeekerModel } from "../src/sim/sensor";
import { sampleStandardDeviation } from "../src/analysis/statistics";
import { mean, wrapAngle } from "../src/sim/math";

describe("seeker", () => {
  it("is deterministic for fixed independent streams", () => {
    const config = createDefaultConfig();
    config.sensor.dropoutProbability = 0;
    const own = initialVehicleState(config.torpedo);
    const target = initialVehicleState(config.target);
    const make = () =>
      new SeekerModel(
        config.sensor,
        new SeededRandom(11),
        new SeededRandom(12),
      );
    expect(make().sample(0, own, target)).toEqual(
      make().sample(0, own, target),
    );
  });

  it("returns out-of-fov rather than leaking a measurement", () => {
    const config = createDefaultConfig();
    config.torpedo.initial.heading = Math.PI;
    const own = initialVehicleState(config.torpedo);
    const target = initialVehicleState(config.target);
    const seeker = new SeekerModel(
      config.sensor,
      new SeededRandom(1),
      new SeededRandom(2),
    );
    const sample = seeker.sample(0, own, target);
    expect(sample?.status).toBe("out-of-fov");
    expect(sample?.observation).toBeNull();
  });

  it("matches configured Gaussian noise statistics over a seeded batch", () => {
    const config = createDefaultConfig();
    config.sensor.cadenceHz = 50;
    config.sensor.dropoutProbability = 0;
    const own = initialVehicleState(config.torpedo);
    const target = initialVehicleState(config.target);
    const trueRange = Math.hypot(
      target.position.x - own.position.x,
      target.position.y - own.position.y,
    );
    const trueBearing = wrapAngle(
      Math.atan2(
        target.position.y - own.position.y,
        target.position.x - own.position.x,
      ) - own.heading,
    );
    const expectedRangeSigma =
      config.sensor.rangeSigmaBase +
      config.sensor.rangeSigmaPerMeter * trueRange;
    const seeker = new SeekerModel(
      config.sensor,
      new SeededRandom(101),
      new SeededRandom(202),
    );
    const bearingResiduals: number[] = [];
    const rangeResiduals: number[] = [];
    for (let index = 0; index < 5000; index += 1) {
      const observation = seeker.sample(index / 50, own, target)?.observation;
      if (!observation) continue;
      bearingResiduals.push(wrapAngle(observation.bearing - trueBearing));
      rangeResiduals.push(observation.range - trueRange);
    }
    expect(Math.abs(mean(bearingResiduals)!)).toBeLessThan(
      config.sensor.bearingSigma * 0.08,
    );
    expect(sampleStandardDeviation(bearingResiduals)).toBeCloseTo(
      config.sensor.bearingSigma,
      2,
    );
    expect(Math.abs(mean(rangeResiduals)!)).toBeLessThan(
      expectedRangeSigma * 0.08,
    );
    expect(sampleStandardDeviation(rangeResiduals)).toBeCloseTo(
      expectedRangeSigma,
      0,
    );
  });

  it("matches configured dropout probability over a seeded batch", () => {
    const config = createDefaultConfig();
    config.sensor.cadenceHz = 50;
    config.sensor.dropoutProbability = 0.2;
    config.sensor.bearingSigma = 0;
    config.sensor.rangeSigmaBase = 0;
    config.sensor.rangeSigmaPerMeter = 0;
    const own = initialVehicleState(config.torpedo);
    const target = initialVehicleState(config.target);
    const seeker = new SeekerModel(
      config.sensor,
      new SeededRandom(303),
      new SeededRandom(404),
    );
    let dropouts = 0;
    for (let index = 0; index < 5000; index += 1) {
      if (seeker.sample(index / 50, own, target)?.status === "dropout") {
        dropouts += 1;
      }
    }
    expect(Math.abs(dropouts / 5000 - 0.2)).toBeLessThan(0.02);
  });
});
