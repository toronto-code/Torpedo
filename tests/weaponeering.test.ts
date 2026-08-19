import { describe, expect, it } from "vitest";

import { runWeaponeeringStudy, defaultVariants } from "../src/analysis/weaponeering";
import { createDefaultConfig } from "../src/sim/config";
import type { SimulationConfig } from "../src/sim/types";

function weaponConfig(): SimulationConfig {
  const config = createDefaultConfig();
  config.runtime.maxTime = 120;
  config.weapon = {
    phases: { enableTime: 4, terminalRange: 400, reacquireAfter: 2 },
    speed: { cruiseSpeed: 30, sprintSpeed: 40 },
    endurance: { runTime: 90 },
    terminalSensor: { cadenceHz: 20, innovationGate: 6 },
    fuze: { detectionRadius: 18 },
    effectiveness: { lethalRadius: 12, shape: 2 },
  };
  config.torpedo.commandedSpeed = 30;
  return config;
}

describe("weaponeering study", () => {
  it("sweeps paired seeds across weapon variants with consistent accounting", () => {
    const base = weaponConfig();
    const variants = defaultVariants(base.weapon!).slice(0, 3);
    const report = runWeaponeeringStudy({
      runs: 3,
      baseSeed: 20260814,
      variants,
      createConfig: () => structuredClone(base),
    });
    expect(report.variants).toHaveLength(3);
    expect(report.runsPerVariant).toBe(3);
    expect(report.pairedDeltas).toHaveLength(2);
    for (const summary of report.variants) {
      expect(summary.runs).toBe(3);
      expect(summary.detonationRate + summary.interceptRate + summary.exhaustionRate)
        .toBeLessThanOrEqual(1 + 1e-9);
      expect(summary.meanClosestApproach).toBeGreaterThan(0);
      expect(summary.meanElapsed).toBeGreaterThan(0);
    }
    const baseline = report.variants[0];
    expect(baseline.id).toBe("baseline");
    expect(baseline.detonationRate).toBeGreaterThan(0.5);
  });

  it("rejects configurations without a weapon block", () => {
    expect(() =>
      runWeaponeeringStudy({
        runs: 1,
        baseSeed: 1,
        createConfig: createDefaultConfig,
      }),
    ).toThrow(/weapon block/);
  });
});
