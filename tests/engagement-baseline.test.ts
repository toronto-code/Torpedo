import { describe, expect, it } from "vitest";
import { runEngagementStudy } from "../src/analysis/engagement-study";

/**
 * Preset outcome baseline: a statistical regression gate. The paired seeds
 * are fixed, so these distributions are deterministic — when tuning changes
 * them, update these bounds deliberately in the same commit and say why.
 * Bounds are kept loose enough to absorb small estimator noise, tight
 * enough to catch a doctrine or classifier regression.
 */
describe("engagement outcome baseline", () => {
  it("active presets hold their calibrated outcome mixes", { timeout: 120000 }, () => {
    const report = runEngagementStudy({
      runs: 6,
      baseSeed: 20260814,
      presets: [
        "crossing-subs",
        "cluttered-approach",
        "decoy-stress",
        "ambiguous-fluctuator",
        "high-ambiguity",
        "silent-approach",
        "wire-guided",
      ],
    });
    const fraction = (preset: string, outcome: string): number => {
      const variant = report.variants.find((entry) => entry.id === preset);
      if (!variant) throw new Error(`missing variant ${preset}`);
      return variant.outcomes[outcome as never] / variant.runs;
    };

    // Clean-engagement presets: mostly correct-hostile kills.
    expect(fraction("crossing-subs", "correct-hostile")).toBeGreaterThanOrEqual(0.5);
    expect(fraction("crossing-subs", "miss")).toBeLessThanOrEqual(0.5);
    expect(fraction("cluttered-approach", "correct-hostile")).toBeGreaterThanOrEqual(0.66);
    expect(fraction("ambiguous-fluctuator", "correct-hostile")).toBeGreaterThanOrEqual(0.66);

    // Countermeasure stress: seduction must stay possible (a decoy that
    // never works tests nothing) while clean kills remain achievable.
    expect(fraction("decoy-stress", "decoy-seduction")).toBeGreaterThanOrEqual(0.33);
    expect(fraction("decoy-stress", "correct-hostile")).toBeGreaterThanOrEqual(0.16);
    expect(fraction("high-ambiguity", "decoy-seduction")).toBeGreaterThanOrEqual(0.33);
    expect(fraction("high-ambiguity", "correct-hostile")).toBeGreaterThanOrEqual(0.16);

    // Bearings-only TMA preset: a first-class scenario — mostly clean
    // kills, nothing may regress into countermeasure or wrong-contact
    // kills beyond honest ambiguity.
    expect(fraction("silent-approach", "correct-hostile")).toBeGreaterThanOrEqual(0.66);
    expect(fraction("silent-approach", "miss")).toBeLessThanOrEqual(0.34);

    // Wire-guided platform preset: the corroborated relay plus the
    // continuous-agreement wire cut make it a first-class scenario.
    expect(fraction("wire-guided", "correct-hostile")).toBeGreaterThanOrEqual(0.66);
    expect(fraction("wire-guided", "miss")).toBeLessThanOrEqual(0.34);

    // Nothing regresses into pure-timeout territory.
    for (const variant of report.variants) {
      expect(variant.outcomes.miss / variant.runs).toBeLessThanOrEqual(0.67);
    }
  });
});
