import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/sim/config";
import { initialVehicleState } from "../src/sim/dynamics";
import { engagementMetrics } from "../src/sim/metrics";

describe("three-dimensional engagement geometry", () => {
  it("includes vertical separation in range and closest approach", () => {
    const config = createDefaultConfig();
    config.torpedo.initial.position = { x: 0, y: 0, z: 30 };
    config.torpedo.initial.depth = 30;
    config.torpedo.initial.speed = 0;
    config.target.initial.position = { x: 0, y: 0, z: 8 };
    config.target.initial.depth = 8;
    config.target.initial.speed = 0;
    const metrics = engagementMetrics(
      initialVehicleState(config.torpedo),
      initialVehicleState(config.target),
      null,
    );
    expect(metrics.horizontalRange).toBe(0);
    expect(metrics.verticalSeparation).toBe(-22);
    expect(metrics.range).toBe(22);
    expect(metrics.predictedMissDistance).toBe(22);
  });
});
