import { describe, expect, it } from "vitest";

import { createDefaultConfig, createPortfolioDemoConfig, hashConfig } from "../src/sim/config";
import { runHeadless } from "../src/sim/engine";
import { applyHydrodynamicProfile } from "../src/sim/hydrodynamic-profiles";

describe("hydrodynamic reference profiles", () => {
  it("uses the published civilian BlueROV2 Heavy coefficients by default", () => {
    const config = createDefaultConfig();
    const parameters = config.dynamics.sixDof.parameters;
    expect(config.dynamics.model).toBe("six-dof");
    expect(config.dynamics.sixDof.profile).toBe("bluerov2-heavy-2024");
    expect(parameters.actuationModel).toBe("vectored-thrust");
    expect(parameters.mass).toBe(11.5);
    expect(parameters.inertia).toEqual({ x: 0.8571, y: 1, z: 1 });
    expect(parameters.addedMass.x).toBe(10.77);
    expect(parameters.addedMass.z).toBe(24.86);
    expect(parameters.linearDamping.x).toBe(38.95);
    expect(parameters.quadraticDamping.x).toBe(31.01);
    expect(parameters.maximumThrust).toBeCloseTo(88.25985, 8);
    expect(config.torpedo.parameters.maxSpeed).toBe(1.55);
  });

  it("keeps the archived portfolio preset on its declared fictional coefficient set", () => {
    const config = createPortfolioDemoConfig();
    expect(config.dynamics.sixDof.profile).toBe("generic-fictional");
    expect(config.dynamics.sixDof.parameters.mass).toBe(1_550);
    expect(config.torpedo.commandedSpeed).toBe(40);
  });

  it("is deterministic and finite with the civilian reference profile", () => {
    const left = createDefaultConfig();
    const right = createDefaultConfig();
    left.runtime.maxTime = 20;
    right.runtime.maxTime = 20;
    const leftRun = runHeadless(left);
    const rightRun = runHeadless(right);
    expect(hashConfig(left)).toBe(hashConfig(right));
    expect(leftRun.result).toEqual(rightRun.result);
    expect(leftRun.result.terminationReason).not.toBe("invalid-state");
    expect(leftRun.telemetry.every((sample) => Number.isFinite(sample.torpedo.speed))).toBe(true);

    applyHydrodynamicProfile(right, "generic-fictional");
    expect(hashConfig(left)).not.toBe(hashConfig(right));
  });
});
