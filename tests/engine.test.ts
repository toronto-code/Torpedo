import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/sim/config";
import { SimulationEngine, runHeadless } from "../src/sim/engine";
import type { ObservationMode } from "../src/sim/types";
import type { ScenarioKind } from "../src/sim/types";

describe("headless vertical slice", () => {
  it("reproduces identical runs from identical seeds", () => {
    const first = runHeadless(createDefaultConfig()).result;
    const second = runHeadless(createDefaultConfig()).result;
    expect(second).toEqual(first);
  });

  it("runs all ablation modes without invalid numerical state", () => {
    const modes: ObservationMode[] = ["perfect", "raw", "ekf"];
    for (const mode of modes) {
      const config = createDefaultConfig();
      config.guidance.mode = mode;
      config.runtime.maxTime = 40;
      const { result, telemetry } = runHeadless(config);
      expect(result.terminationReason).not.toBe("invalid-state");
      expect(result.configHash).toMatch(/^[0-9a-f]{8}$/);
      expect(telemetry.length).toBeGreaterThan(10);
      expect(Number.isFinite(result.closestApproach)).toBe(true);
    }
  });

  it("decimates render snapshots and telemetry from the 200 Hz clock", () => {
    const engine = new SimulationEngine(createDefaultConfig());
    const outputs = Array.from({ length: 20 }, () => engine.step());
    expect(outputs.filter((output) => output.snapshot).length).toBe(5);
    expect(outputs.filter((output) => output.telemetry).length).toBe(2);
  });

  it("publishes an immediate snapshot for an explicit single-step", () => {
    const engine = new SimulationEngine(createDefaultConfig());
    const output = engine.step(true);
    expect(output.snapshot?.timestamp).toBeCloseTo(0.005, 12);
    expect(output.telemetry).toBeUndefined();
  });

  it("can publish current state without advancing the physics clock", () => {
    const engine = new SimulationEngine(createDefaultConfig());
    engine.step();
    const snapshot = engine.currentSnapshot();
    expect(snapshot.timestamp).toBeCloseTo(0.005, 12);
    expect(engine.timestamp).toBeCloseTo(0.005, 12);
  });

  it("keeps all reference target scenarios numerically finite", () => {
    const scenarios: ScenarioKind[] = [
      "constant-velocity",
      "constant-turn",
      "scripted-evasive",
    ];
    for (const scenario of scenarios) {
      const config = createDefaultConfig();
      config.scenario.kind = scenario;
      config.runtime.maxTime = 12;
      const run = runHeadless(config);
      expect(run.result.terminationReason).not.toBe("invalid-state");
      expect(run.consistency.nis.length).toBeGreaterThan(0);
      expect(run.consistency.nees.length).toBeGreaterThan(0);
    }
  });
});
