import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/sim/config";
import { computeGuidance } from "../src/sim/guidance";
import type { NavigationInput } from "../src/sim/types";

const input: NavigationInput = {
  timestamp: 0,
  ownPosition: { x: 0, y: 0 },
  ownVelocity: { x: 20, y: 0 },
  ownHeading: 0,
  track: {
    timestamp: 0,
    position: { x: 1000, y: 100 },
    velocity: { x: -5, y: 0 },
    covariance: Array.from({ length: 4 }, (_, i) =>
      Array.from({ length: 4 }, (_, j) => (i === j ? 1 : 0)),
    ),
    age: 0,
    valid: true,
    source: "perfect",
  },
};

describe("guidance", () => {
  it("commands no PN acceleration when LOS rate is zero", () => {
    const config = createDefaultConfig().guidance;
    const command = computeGuidance(
      {
        ...input,
        track: {
          ...input.track,
          position: { x: 1000, y: 0 },
          velocity: { x: -5, y: 0 },
        },
      },
      config,
    );
    expect(command.losRate).toBeCloseTo(0, 12);
    expect(command.lateralAcceleration).toBeCloseTo(0, 12);
  });

  it("uses the correct turn sign for a target moving above the LOS", () => {
    const config = createDefaultConfig().guidance;
    const command = computeGuidance(
      {
        ...input,
        track: { ...input.track, velocity: { x: -5, y: 3 } },
      },
      config,
    );
    expect(command.losRate).toBeGreaterThan(0);
    expect(command.lateralAcceleration).toBeGreaterThan(0);
  });
});
