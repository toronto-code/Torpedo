import { describe, expect, it } from "vitest";
import { createDefaultConfig, createPortfolioDemoConfig, validateConfig } from "../src/sim/config";

describe("simulation configuration validation", () => {
  it("accepts the reference configuration", () => {
    expect(() => validateConfig(createDefaultConfig())).not.toThrow();
  });

  it("provides a deterministic portfolio demo preset", () => {
    const config = createPortfolioDemoConfig(42);
    expect(config.seed).toBe(42);
    expect(config.dynamics.model).toBe("six-dof");
    expect(config.scenario.kind).toBe("scripted-evasive");
    expect(config.guidance.mode).toBe("ekf");
    expect(config.guidance.law).toBe("proportional-navigation");
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("rejects non-finite sensor and guidance values", () => {
    const sensorConfig = createDefaultConfig();
    sensorConfig.sensor.dropoutProbability = Number.NaN;
    expect(() => validateConfig(sensorConfig)).toThrow(/finite/);

    const guidanceConfig = createDefaultConfig();
    guidanceConfig.guidance.staleTrackCommandScale = Number.NaN;
    expect(() => validateConfig(guidanceConfig)).toThrow(/finite/);
  });

  it("rejects physically inconsistent vehicle configuration", () => {
    const badDepth = createDefaultConfig();
    badDepth.torpedo.initial.position.y = 0;
    expect(() => validateConfig(badDepth)).toThrow(/negative initial\.depth/);

    const badResponse = createDefaultConfig();
    badResponse.torpedo.parameters.turnResponseTime = 0;
    expect(() => validateConfig(badResponse)).toThrow(/positive/);
  });

  it("rejects unknown runtime modes even when loaded from external JSON", () => {
    const config = createDefaultConfig();
    config.guidance.mode = "invalid" as typeof config.guidance.mode;
    expect(() => validateConfig(config)).toThrow(/observation mode/);
  });
});
