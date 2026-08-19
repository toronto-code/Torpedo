import { describe, expect, it } from "vitest";

import {
  createAmbiguityScenarioConfig,
  type AmbiguityPreset,
} from "../src/sim/scenarios";
import { runHeadless } from "../src/sim/engine";

const PRESETS: AmbiguityPreset[] = [
  "crossing-subs",
  "cluttered-approach",
  "decoy-stress",
  "ambiguous-fluctuator",
  "high-ambiguity",
];

describe("ambiguity scenario presets", () => {
  for (const preset of PRESETS) {
    it(`runs ${preset} deterministically with a complete decision chain`, () => {
      const config = createAmbiguityScenarioConfig(preset);
      expect(config.contacts).toBeDefined();
      expect(config.contacts!.length).toBeGreaterThan(0);
      const run = runHeadless(config);
      expect(run.result.terminationReason).not.toBe("invalid-state");
      expect(run.result.tewaEvents).toBeDefined();
      expect(run.result.engagementOutcome).toBeDefined();
      for (const sample of run.telemetry) {
        for (const contact of sample.contacts ?? []) {
          expect(Number.isFinite(contact.position.x)).toBe(true);
        }
      }
      const again = runHeadless(createAmbiguityScenarioConfig(preset));
      expect(again.result).toEqual(run.result);
    });
  }

  it("pairs identical seeds across presets for comparative studies", () => {
    const a = createAmbiguityScenarioConfig("decoy-stress", 42);
    const b = createAmbiguityScenarioConfig("high-ambiguity", 42);
    expect(a.seed).toBe(b.seed);
    expect(a.contacts!.map((contact) => contact.id)).toContain("hostile");
  });
});
