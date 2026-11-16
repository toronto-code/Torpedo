import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/sim/config";
import { runHeadless } from "../src/sim/engine";
import { effectiveTargetStrength } from "../src/sim/contacts";
import { createContactRuntime } from "../src/sim/contacts";
import { createAmbiguityScenarioConfig } from "../src/sim/scenarios";
import { SeekerModel } from "../src/sim/sensor";
import { initialVehicleState } from "../src/sim/dynamics";
import { SeededRandom } from "../src/sim/random";
import type { ContactSpec, SimulationConfig } from "../src/sim/types";

describe("speed-dependent self-noise", () => {
  function seekerWith(selfNoise?: { baseDb: number; dbPerMs: number }) {
    const config = createDefaultConfig();
    if (selfNoise) config.sensor.selfNoise = selfNoise;
    return {
      config,
      seeker: new SeekerModel(
        config.sensor,
        new SeededRandom(11),
        new SeededRandom(12),
        config.environment,
        config.acoustic,
        new SeededRandom(13),
      ),
      target: initialVehicleState(config.target),
    };
  }

  it("degrades detection probability at high speed", { timeout: 60000 }, () => {
    const quiet = seekerWith({ baseDb: 52, dbPerMs: 0.55 });
    const slow = quiet.seeker.sample(
      0,
      { ...quiet.target, speed: 5, position: { x: 0, y: 0, z: 35 }, heading: 0.3 },
      quiet.target,
    );
    const fast = quiet.seeker.sample(
      0.2,
      { ...quiet.target, speed: 40, position: { x: 0, y: 0, z: 35 }, heading: 0.3 },
      quiet.target,
    );
    expect(slow?.acoustic).not.toBeNull();
    expect(fast?.acoustic).not.toBeNull();
    expect(fast!.acoustic!.detectionProbability)
      .toBeLessThan(slow!.acoustic!.detectionProbability);
  });

  it("keeps the legacy channel bit-identical when unconfigured", { timeout: 60000 }, () => {
    const a = seekerWith();
    const b = seekerWith();
    const sensorState = { ...a.target, position: { x: 0, y: 0, z: 35 } };
    expect(a.seeker.sample(0, sensorState, a.target))
      .toEqual(b.seeker.sample(0, sensorState, b.target));
    const without = seekerWith();
    const withNoise = seekerWith({ baseDb: -60, dbPerMs: 0 });
    // Zero-strength self-noise must also reduce to the legacy level.
    expect(
      withNoise.seeker.sample(0, sensorState, withNoise.target)?.acoustic
        ?.detectionProbability,
    ).toBeCloseTo(
      without.seeker.sample(0, sensorState, without.target)?.acoustic
        ?.detectionProbability ?? 0,
      12,
    );
  });
});

describe("energy-budget endurance", () => {
  function batteryConfig(cruise: number, capacityWs = 8e5): SimulationConfig {
    const config = createDefaultConfig();
    config.runtime.maxTime = 400;
    config.interceptRadius = 0.5;
    config.weapon = {
      speed: { cruiseSpeed: cruise },
      endurance: { battery: { capacityWs, hotelW: 200, dragKW: 0.8 } },
    };
    config.torpedo.commandedSpeed = cruise;
    // Keep the target unreachable so the run is endurance-limited.
    config.target.initial.position = { x: 100_000, y: 0, z: 8 };
    config.sensor.maxRange = 200_000;
    return config;
  }

  it("drains with speed-cubed drag and exhausts earlier at sprint", { timeout: 60000 }, () => {
    const slow = runHeadless(batteryConfig(15)).result;
    const fast = runHeadless(batteryConfig(40)).result;
    expect(slow.terminationReason).toBe("endurance-exhausted");
    expect(fast.terminationReason).toBe("endurance-exhausted");
    // Power ratio ~ (40/15)^3 => the fast run dies far sooner.
    expect(fast.elapsedTime).toBeLessThan(slow.elapsedTime / 5);
  });

  it("scales run time with capacity", { timeout: 60000 }, () => {
    const small = runHeadless(batteryConfig(20, 4e5)).result;
    const large = runHeadless(batteryConfig(20, 8e5)).result;
    expect(large.elapsedTime).toBeGreaterThan(small.elapsedTime * 1.5);
  });

  it("keeps the legacy time budget when no battery is configured", { timeout: 60000 }, () => {
    const config = createDefaultConfig();
    config.weapon = { endurance: { runTime: 20 } };
    config.runtime.maxTime = 60;
    config.interceptRadius = 0.5;
    const run = runHeadless(config);
    expect(run.result.terminationReason).toBe("endurance-exhausted");
    expect(run.result.elapsedTime).toBeGreaterThanOrEqual(20);
  });
});

describe("aspect-dependent echo", () => {
  const spec: ContactSpec = {
    id: "sub",
    kind: "hostile-sub",
    vehicle: createDefaultConfig().target,
    aspectEcho: { bowDb: 8, beamDb: 19 },
  };

  function runtimeAt(heading: number, x = 0, y = 0) {
    const config = createDefaultConfig();
    const runtime = createContactRuntime(spec, config);
    runtime.state.heading = heading;
    runtime.state.position = { x, y, z: 30 };
    return runtime;
  }

  it("is weak bow-on and strong beam-on", { timeout: 60000 }, () => {
    const weapon = { x: 2000, y: 0 };
    const bow = effectiveTargetStrength(runtimeAt(0), weapon, 10);
    const beam = effectiveTargetStrength(runtimeAt(Math.PI / 2), weapon, 10);
    expect(bow).toBeCloseTo(8, 6);
    expect(beam).toBeCloseTo(19, 6);
  });

  it("stays constant for contacts without aspect echo (decoys)", { timeout: 60000 }, () => {
    const config = createDefaultConfig();
    const decoySpec: ContactSpec = {
      id: "decoy",
      kind: "decoy",
      vehicle: config.target,
      targetStrengthDb: 21,
    };
    const runtime = createContactRuntime(decoySpec, config);
    runtime.state.position = { x: 0, y: 0, z: 30 };
    for (const heading of [0, 1, 2, 3]) {
      runtime.state.heading = heading;
      expect(effectiveTargetStrength(runtime, { x: 500, y: 500 }, 15)).toBe(21);
    }
  });

  it("varies smoothly as geometry evolves in a full engagement", { timeout: 60000 }, () => {
    const run = runHeadless(createAmbiguityScenarioConfig("cluttered-approach"));
    expect(run.result.terminationReason).not.toBe("invalid-state");
    const again = runHeadless(createAmbiguityScenarioConfig("cluttered-approach"));
    expect(again.result).toEqual(run.result);
  });
});
