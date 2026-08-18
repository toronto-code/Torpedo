import { describe, expect, it } from "vitest";

import { createDefaultConfig, hashConfig } from "../src/sim/config";
import { SimulationEngine } from "../src/sim/engine";

describe("render and camera isolation from the simulation", () => {
  it("has no rendering or camera state in the frozen configuration", () => {
    const config = createDefaultConfig();
    const keys = Object.keys(config).join(",");
    expect(keys).not.toMatch(/camera|render|view|overlay|trail/i);
    // Camera/overlay state lives in desktop SceneOptions and React state;
    // it has no path into the configuration hash.
    expect(hashConfig(structuredClone(config))).toBe(hashConfig(config));
  });

  it("produces identical telemetry for identical seeds regardless of caller activity", () => {
    const run = () => {
      const config = createDefaultConfig();
      config.runtime.maxTime = 6;
      const engine = new SimulationEngine(config);
      const telemetry: number[] = [];
      let discarded = 0;
      while (!engine.completed) {
        // Interleave arbitrary caller-side work (as UI/camera churn would);
        // the engine observes none of it.
        discarded += Math.random();
        const step = engine.step();
        if (step.telemetry) telemetry.push(...step.telemetry.samples.map((s) => s.timestamp));
      }
      expect(Number.isFinite(discarded)).toBe(true);
      return telemetry;
    };
    expect(run()).toEqual(run());
  });

  it("advances at exactly 200 Hz with fixed 5 ms steps", () => {
    const config = createDefaultConfig();
    config.runtime.maxTime = 2;
    const engine = new SimulationEngine(config);
    expect(config.runtime.physicsHz).toBe(200);
    const dt = 1 / 200;
    let previous = engine.timestamp;
    expect(previous).toBe(0);
    const steps = 400;
    for (let index = 0; index < steps; index += 1) {
      engine.step();
      // The engine computes tick * (1/200) with the same expression, so the
      // timestamp is the exact product of integers and the fixed step.
      expect(engine.timestamp).toBe((index + 1) * dt);
      expect(engine.timestamp - previous).toBeCloseTo(0.005, 12);
      previous = engine.timestamp;
    }
    // Guidance/autopilot scheduling derives from integer tick divisors of
    // 200 Hz, never from wall-clock time.
    expect(config.runtime.physicsHz % config.runtime.guidanceHz).toBe(0);
    expect(config.runtime.physicsHz % config.runtime.autopilotHz).toBe(0);
  });
});
