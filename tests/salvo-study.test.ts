import { describe, expect, it } from "vitest";
import { runSalvoStudy } from "../src/analysis/salvo-study";

describe("sequential salvo study", () => {
  it("is deterministic per seed and answers shots-to-kill", { timeout: 120000 }, () => {
    const first = runSalvoStudy({ runs: 3, baseSeed: 20260814 });
    const again = runSalvoStudy({ runs: 3, baseSeed: 20260814 });
    expect(again.runs.map((run) => run.shots)).toEqual(
      first.runs.map((run) => run.shots),
    );
    expect(again.runs.map((run) => run.firstOutcome)).toEqual(
      first.runs.map((run) => run.firstOutcome),
    );
    // Structural sanity: shots are censored at 3, and every run is counted.
    for (const run of first.runs) {
      expect([1, 2, 3]).toContain(run.shots);
    }
    const decoyStress = first.variants.find((v) => v.id === "decoy-stress");
    expect(decoyStress?.runs).toBe(3);
    expect(decoyStress!.oneShotKills + decoyStress!.twoShotKills + decoyStress!.survivors)
      .toBe(decoyStress!.runs);
  });

  it("countermeasure depletion lets the follow-up finish the job", { timeout: 120000 }, () => {
    // Across a wider sweep the decoy-stress gauntlet should mostly cost
    // at most one extra weapon: expendables do not survive the delay.
    const report = runSalvoStudy({ runs: 8, baseSeed: 20260814 });
    const decoyStress = report.variants.find((v) => v.id === "decoy-stress")!;
    const resolved = decoyStress.oneShotKills + decoyStress.twoShotKills;
    expect(resolved / decoyStress.runs).toBeGreaterThanOrEqual(0.75);
    expect(decoyStress.meanShots).toBeLessThan(2);
  });
});
