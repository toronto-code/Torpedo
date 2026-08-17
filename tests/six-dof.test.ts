import { describe, expect, it } from "vitest";

import { createDefaultConfig, validateConfig } from "../src/sim/config";
import { runHeadless } from "../src/sim/engine";
import { quaternionNorm } from "../src/sim/quaternion";
import {
  initialSixDofState,
  integrateSixDofVehicle,
  solveSixDofTrim,
} from "../src/sim/six-dof";

describe("fictional 6-DOF dynamics", () => {
  it("finds a level, neutrally buoyant propulsion trim", () => {
    const config = createDefaultConfig();
    config.dynamics.sixDof.currentMean = { x: 0, y: 0, z: 0 };
    config.dynamics.sixDof.currentAmplitude = { x: 0, y: 0, z: 0 };
    const trim = solveSixDofTrim(config.torpedo, config.dynamics.sixDof);
    expect(trim.converged).toBe(true);
    expect(Math.abs(trim.residualForce.x)).toBeLessThan(1e-8);
    expect(Math.abs(trim.residualForce.y)).toBeLessThan(1e-8);
    expect(trim.propulsionForce).toBeGreaterThan(0);
    expect(trim.throttle).toBeGreaterThan(0);
    expect(trim.throttle).toBeLessThan(1);
  });

  it("holds level constant-speed trim and preserves quaternion norm", () => {
    const config = createDefaultConfig();
    const sixDof = config.dynamics.sixDof;
    sixDof.currentMean = { x: 0, y: 0, z: 0 };
    sixDof.currentAmplitude = { x: 0, y: 0, z: 0 };
    config.torpedo.commandedSpeed = config.torpedo.initial.speed;
    config.torpedo.commandedDepth = config.torpedo.initial.depth;
    let state = initialSixDofState(config.torpedo, sixDof);
    const control = {
      yawRateCommand: 0,
      depthRateCommand: 0,
      speedCommand: config.torpedo.initial.speed,
    };
    for (let index = 0; index < 2_000; index += 1) {
      state = integrateSixDofVehicle(state, control, config.torpedo, sixDof, 0.005);
    }
    expect(state.depth).toBeCloseTo(config.torpedo.initial.depth, 7);
    expect(state.speed).toBeCloseTo(config.torpedo.initial.speed, 6);
    expect(quaternionNorm(state.orientation)).toBeCloseTo(1, 12);
    expect(state.angularVelocity.x).toBeCloseTo(0, 9);
    expect(state.angularVelocity.y).toBeCloseTo(0, 9);
    expect(state.angularVelocity.z).toBeCloseTo(0, 9);
  });

  it("models control-surface lag and remains close under timestep refinement", () => {
    const config = createDefaultConfig();
    const sixDof = config.dynamics.sixDof;
    sixDof.currentMean = { x: 0, y: 0, z: 0 };
    sixDof.currentAmplitude = { x: 0, y: 0, z: 0 };
    const initial = initialSixDofState(config.torpedo, sixDof);
    const control = {
      yawRateCommand: 0.08,
      depthRateCommand: 0,
      speedCommand: config.torpedo.initial.speed,
    };
    let coarse = initial;
    let fine = initial;
    for (let index = 0; index < 400; index += 1) {
      coarse = integrateSixDofVehicle(coarse, control, config.torpedo, sixDof, 0.005);
    }
    for (let index = 0; index < 800; index += 1) {
      fine = integrateSixDofVehicle(fine, control, config.torpedo, sixDof, 0.0025);
    }
    expect(coarse.actuator.rudderAngle).toBeGreaterThan(0);
    expect(coarse.actuator.rudderAngle).toBeLessThanOrEqual(
      sixDof.parameters.maxControlSurfaceAngle,
    );
    expect(coarse.heading).toBeGreaterThan(initial.heading);
    expect(coarse.position.x).toBeCloseTo(fine.position.x, 3);
    expect(coarse.position.z).toBeCloseTo(fine.position.z, 3);
  });

  it("dissipates kinetic energy when propulsion is commanded off", () => {
    const config = createDefaultConfig();
    const sixDof = config.dynamics.sixDof;
    sixDof.currentMean = { x: 0, y: 0, z: 0 };
    sixDof.currentAmplitude = { x: 0, y: 0, z: 0 };
    let state = initialSixDofState(config.torpedo, sixDof);
    state = {
      ...state,
      actuator: { ...state.actuator, propulsionForce: 0 },
    };
    const initialSpeed = state.speed;
    for (let index = 0; index < 1_000; index += 1) {
      state = integrateSixDofVehicle(
        state,
        { yawRateCommand: 0, depthRateCommand: 0, speedCommand: 0 },
        config.torpedo,
        sixDof,
        0.005,
      );
    }
    expect(state.speed).toBeLessThan(initialSpeed);
    expect(state.speed).toBeGreaterThan(0);
  });

  it("runs the integrated 6-DOF engagement without invalid state", () => {
    const config = createDefaultConfig();
    config.dynamics.model = "six-dof";
    config.runtime.maxTime = 12;
    const run = runHeadless(config);
    expect(run.result.terminationReason).not.toBe("invalid-state");
    expect(run.result.dynamicsModel).toBe("six-dof");
    expect(run.result.maximumPitch * 180 / Math.PI).toBeLessThan(10);
    expect(run.result.meanControlEffort).toBeGreaterThan(0);
    expect(run.telemetry.every((sample) => Number.isFinite(sample.torpedo.orientation.w))).toBe(true);
  });

  it("rejects invalid 6-DOF coefficient ranges", () => {
    const config = createDefaultConfig();
    config.dynamics.sixDof.parameters.mass = 0;
    expect(() => validateConfig(config)).toThrow(/mass.*positive/i);
  });
});
