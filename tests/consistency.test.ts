import { describe, expect, it } from "vitest";
import { runMonteCarlo } from "../src/analysis/monte-carlo";

describe("baseline estimator consistency reporting", () => {
  it("is deterministic and reports bounded ensemble coverage", () => {
    const options = {
      runs: 4,
      baseSeed: 42,
      modes: ["ekf"],
      laws: ["proportional-navigation"],
      scenarios: ["constant-turn"],
    } as const;
    const first = runMonteCarlo({
      ...options,
      modes: [...options.modes],
      laws: [...options.laws],
      scenarios: [...options.scenarios],
    });
    const second = runMonteCarlo({
      ...options,
      modes: [...options.modes],
      laws: [...options.laws],
      scenarios: [...options.scenarios],
    });
    const firstConsistency = first.groups[0].consistency;
    const secondConsistency = second.groups[0].consistency;
    expect(secondConsistency).toEqual(firstConsistency);
    expect(firstConsistency.nis.expectedMean).toBe(2);
    expect(firstConsistency.nees.expectedMean).toBe(4);
    expect(firstConsistency.nis.ensemble95Coverage).toBeGreaterThanOrEqual(0);
    expect(firstConsistency.nis.ensemble95Coverage).toBeLessThanOrEqual(1);
    expect(firstConsistency.nees.ensemble95Coverage).toBeGreaterThanOrEqual(0);
    expect(firstConsistency.nees.ensemble95Coverage).toBeLessThanOrEqual(1);
  }, 15_000);
});
