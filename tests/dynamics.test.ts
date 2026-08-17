import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/sim/config";
import {
  initialVehicleState,
  integrateVehicle,
} from "../src/sim/dynamics";

describe("2.5D dynamics", () => {
  it("matches constant velocity motion when already trimmed", () => {
    const config = createDefaultConfig().torpedo;
    const trimmedSpeed = Math.min(1, config.parameters.maxSpeed);
    config.initial.heading = 0;
    config.initial.speed = trimmedSpeed;
    config.commandedSpeed = trimmedSpeed;
    const initial = initialVehicleState(config);
    const next = integrateVehicle(
      initial,
      { yawRateCommand: 0, depthRateCommand: 0, speedCommand: trimmedSpeed },
      config.parameters,
      0.5,
    );
    expect(next.position.x).toBeCloseTo(trimmedSpeed * 0.5, 8);
    expect(next.position.z).toBeCloseTo(0, 8);
    expect(next.depth).toBeCloseTo(initial.depth, 8);
  });

  it("enforces turn-rate commands and reports saturation", () => {
    const config = createDefaultConfig().torpedo;
    const initial = initialVehicleState(config);
    const next = integrateVehicle(
      initial,
      { yawRateCommand: 100, depthRateCommand: 0, speedCommand: 40 },
      config.parameters,
      0.005,
    );
    expect(next.actuator.yawRateCommand).toBe(
      config.parameters.maxTurnRate,
    );
    expect(next.actuator.saturated).toBe(true);
  });
});
