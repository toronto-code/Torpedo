import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/sim/config";
import { initialVehicleState } from "../src/sim/dynamics";
import { runHeadless } from "../src/sim/engine";
import { orientationAngles, quaternionFromEuler } from "../src/sim/quaternion";
import type { SimulationConfig } from "../src/sim/types";

describe("opt-in 3D target motion", () => {
  function threeDConfig(): SimulationConfig {
    const config = createDefaultConfig();
    config.dynamics.model = "six-dof";
    config.runtime.maxTime = 30;
    config.target.dynamicsModel = "six-dof";
    config.target.commandedDepth = 60;
    config.target.initial.depth = 20;
    config.target.initial.position.z = 20;
    config.target.parameters.maxDepthRate = 2;
    config.target.parameters.maxDepthAcceleration = 0.5;
    config.target.parameters.depthResponseTime = 3;
    config.torpedo.commandedDepth = 30;
    config.interceptRadius = 14;
    return config;
  }

  it("both objects hold nonzero and distinct depths", { timeout: 60000 }, () => {
    const run = runHeadless(threeDConfig());
    expect(run.result.terminationReason).not.toBe("invalid-state");
    const mid = run.telemetry[Math.floor(run.telemetry.length / 2)];
    expect(mid.torpedo.depth).toBeGreaterThan(1);
    expect(mid.target.depth).toBeGreaterThan(1);
    expect(Math.abs(mid.torpedo.depth - mid.target.depth)).toBeGreaterThan(5);
    for (const sample of run.telemetry) {
      for (const vehicle of [sample.torpedo, sample.target]) {
        expect(Number.isFinite(vehicle.position.x)).toBe(true);
        expect(Number.isFinite(vehicle.position.y)).toBe(true);
        expect(Number.isFinite(vehicle.position.z)).toBe(true);
        expect(vehicle.depth).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("the 3D target changes depth while the default target stays planar", { timeout: 60000 }, () => {
    const moving = runHeadless(threeDConfig());
    const depthSamples = moving.telemetry.map((sample) => sample.target.depth);
    const maxDepthChange = Math.max(...depthSamples) - Math.min(...depthSamples);
    expect(maxDepthChange).toBeGreaterThan(0.5);

    const planar = createDefaultConfig();
    planar.runtime.maxTime = 10;
    const planarRun = runHeadless(planar);
    const planarDepths = planarRun.telemetry.map((sample) => sample.target.depth);
    expect(Math.max(...planarDepths)).toBeCloseTo(Math.min(...planarDepths), 9);
  });

  it("initial pitch and roll map onto the NED attitude", { timeout: 60000 }, () => {
    const config = createDefaultConfig();
    config.torpedo.initial.pitch = 0.18;
    config.torpedo.initial.roll = -0.42;
    config.torpedo.initial.verticalSpeed = 1.5;
    const state = initialVehicleState(config.torpedo);
    const angles = orientationAngles(state.orientation);
    expect(angles.pitch).toBeCloseTo(0.18, 10);
    expect(angles.roll).toBeCloseTo(-0.42, 10);
    expect(state.depthRate).toBeCloseTo(1.5, 10);
    expect(state.velocity.z).toBeCloseTo(1.5, 10);
    expect(state.position.z).toBeCloseTo(config.torpedo.initial.depth, 10);
  });

  it("quaternionFromEuler composes yaw, pitch, and roll in NED", { timeout: 60000 }, () => {
    const yaw = 0.7;
    const pitch = -0.25;
    const roll = 0.5;
    const orientation = quaternionFromEuler(yaw, pitch, roll);
    const angles = orientationAngles(orientation);
    expect(angles.heading).toBeCloseTo(yaw, 10);
    expect(angles.pitch).toBeCloseTo(pitch, 10);
    expect(angles.roll).toBeCloseTo(roll, 10);
    // Positive pitch must tilt the body-forward direction upward (negative
    // NED z), and positive roll must drop starboard.
    const level = quaternionFromEuler(0, 0.2, 0);
    const pitched = orientationAngles(level);
    expect(pitched.pitch).toBeGreaterThan(0);
    const rolled = quaternionFromEuler(0, 0, 0.2);
    const rolledAngles = orientationAngles(rolled);
    expect(rolledAngles.roll).toBeGreaterThan(0);
  });

  it("keeps existing configurations valid without the optional fields", { timeout: 60000 }, () => {
    const config = createDefaultConfig();
    expect(config.torpedo.dynamicsModel).toBeUndefined();
    expect(config.target.dynamicsModel).toBeUndefined();
    const run = runHeadless(config);
    expect(run.result.dynamicsModel).toBe("planar-2.5d");
    expect(run.telemetry[0].target.dynamicsModel).toBe("planar-2.5d");
  });
});
