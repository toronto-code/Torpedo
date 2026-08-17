import { describe, expect, it } from "vitest";

import { runFidelityStudy } from "../src/analysis/fidelity";
import { createDefaultConfig } from "../src/sim/config";

describe("paired fidelity study", () => {
  it("uses shared seeds and produces deterministic lag/authority effects", () => {
    const config = createDefaultConfig();
    config.runtime.maxTime = 3;
    const first = runFidelityStudy({ runs: 1, baseConfig: config });
    const second = runFidelityStudy({ runs: 1, baseConfig: config });
    expect(first.records).toEqual(second.records);
    expect(first.groups).toEqual(second.groups);
    expect(first.pairedEffects).toEqual(second.pairedEffects);
    expect(first.records).toHaveLength(12);
    expect(first.groups).toHaveLength(12);
    expect(first.pairedEffects).toHaveLength(10);
    expect(new Set(first.records.map((record) => record.seed))).toEqual(new Set([config.seed]));
    expect(first.records.every((record) => Number.isFinite(record.result.closestApproach))).toBe(true);
    expect(first.conclusion.statement.length).toBeGreaterThan(20);
  });
});
