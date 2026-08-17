import { describe, expect, it } from "vitest";
import {
  buildConsistencyReport,
  empiricalCdf,
  histogram,
  summarizeDistribution,
  wilsonInterval,
} from "../src/analysis/statistics";

describe("statistical reporting", () => {
  it("summarizes distributions and empirical probabilities", () => {
    const values = [1, 2, 3, 4, 5];
    const summary = summarizeDistribution(values);
    expect(summary.mean).toBe(3);
    expect(summary.median).toBe(3);
    expect(histogram(values, 2).reduce((sum, bin) => sum + bin.count, 0)).toBe(5);
    expect(empiricalCdf(values).at(-1)?.probability).toBe(1);
  });

  it("produces bounded Wilson confidence intervals", () => {
    const interval = wilsonInterval(7, 10);
    expect(interval.lower).toBeGreaterThan(0);
    expect(interval.upper).toBeLessThan(1);
    expect(interval.lower).toBeLessThan(0.7);
    expect(interval.upper).toBeGreaterThan(0.7);
  });

  it("reports NIS and NEES consistency against their expected dimensions", () => {
    const report = buildConsistencyReport(
      Array(100).fill(2),
      Array(100).fill(4),
    );
    expect(report.nis.expectedMean).toBe(2);
    expect(report.nees.expectedMean).toBe(4);
    expect(report.nis.withinAggregate95).toBe(true);
    expect(report.nees.withinAggregate95).toBe(true);
  });
});
