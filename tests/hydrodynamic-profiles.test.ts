import { describe, expect, it } from "vitest";

import { createDefaultConfig, createPortfolioDemoConfig, hashConfig } from "../src/sim/config";
import { runHeadless } from "../src/sim/engine";
import { applyHydrodynamicProfile } from "../src/sim/hydrodynamic-profiles";

describe("hydrodynamic reference profiles", () => {
  it("uses the generic high-speed profile by default", () => {
    const config = createDefaultConfig();
    const parameters = config.dynamics.sixDof.parameters;
    expect(config.dynamics.model).toBe("planar-2.5d");
    expect(config.dynamics.sixDof.profile).toBe("generic-fictional");
    expect(parameters.actuationModel).toBe("control-surfaces");
    expect(parameters.mass).toBe(1_550);
    expect(config.torpedo.commandedSpeed).toBe(40);
    expect(config.target.initial.position.x).toBe(2_000);
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
    applyHydrodynamicProfile(left, "bluerov2-heavy-2024");
    applyHydrodynamicProfile(right, "bluerov2-heavy-2024");
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
