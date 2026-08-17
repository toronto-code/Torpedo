import { describe, expect, it } from "vitest";
import {
  distributionsToCsv,
  recordsToCsv,
  summariesToCsv,
} from "../src/analysis/csv";
import { runMonteCarlo } from "../src/analysis/monte-carlo";
import { createDefaultConfig } from "../src/sim/config";

describe("paired Monte Carlo runner", () => {
  it("reuses seeds across estimator and guidance variants", () => {
    const report = runMonteCarlo({
      runs: 2,
      baseSeed: 900,
      modes: ["raw", "ekf"],
      laws: ["pure-pursuit", "proportional-navigation"],
      scenarios: ["constant-velocity"],
      createConfig() {
        const config = createDefaultConfig();
        config.runtime.maxTime = 8;
        return config;
      },
    });
    expect(report.pairedSeeds).toEqual([900, 901]);
    expect(report.records).toHaveLength(8);
    expect(report.groups).toHaveLength(4);
    expect(report.comparisons).toHaveLength(4);
    for (const seed of report.pairedSeeds) {
      expect(report.records.filter((record) => record.seed === seed)).toHaveLength(4);
    }
  });

  it("exports raw, summary, histogram, and CDF tables", () => {
    const report = runMonteCarlo({
      runs: 1,
      baseSeed: 42,
      modes: ["ekf"],
      laws: ["proportional-navigation"],
      scenarios: ["constant-velocity"],
      createConfig() {
        const config = createDefaultConfig();
        config.runtime.maxTime = 2;
        return config;
      },
    });
    expect(recordsToCsv(report)).toContain("config_hash");
    expect(summariesToCsv(report)).toContain("nis_aggregate_consistent");
    const distributions = distributionsToCsv(report);
    expect(distributions.histogram).toContain("probability");
    expect(distributions.cdf).toContain("group,value,probability");
  });
});
