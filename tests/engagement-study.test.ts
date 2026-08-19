import { describe, expect, it } from "vitest";
import { runEngagementStudy } from "../src/analysis/engagement-study";

describe("engagement study", () => {
  it("reports paired outcome mixes across presets", { timeout: 60000 }, () => {
    const report = runEngagementStudy({
      runs: 2,
      baseSeed: 20260814,
      presets: ["cluttered-approach", "decoy-stress"],
    });
    expect(report.variants).toHaveLength(2);
    for (const variant of report.variants) {
      const total = Object.values(variant.outcomes).reduce((a, b) => a + b, 0);
      expect(total).toBe(variant.runs);
      expect(variant.meanElapsed).toBeGreaterThan(0);
    }
  });
});
