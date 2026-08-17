import { describe, expect, it } from "vitest";

import { parseReplay, ReplayCompatibilityError, serializeReplay } from "../src/replay/codec";
import { ReplayRecorder } from "../src/replay/recorder";
import { findFrameAtTime, telemetryThroughTime } from "../src/replay/timeline";
import { runNumericalSoak, verifyReplay } from "../src/replay/verification";
import { createDefaultConfig } from "../src/sim/config";
import { SimulationEngine } from "../src/sim/engine";
import type { ReplayFile } from "../src/replay/types";

function recordedRun(maxTime = 1.2): ReplayFile {
  const config = createDefaultConfig();
  config.runtime.maxTime = maxTime;
  const engine = new SimulationEngine(config);
  const recorder = new ReplayRecorder(config);
  while (!engine.completed) {
    const output = engine.step();
    if (output.snapshot) recorder.snapshot(output.snapshot);
    if (output.telemetry) recorder.telemetry(output.telemetry);
    if (output.result) recorder.complete(output.result);
  }
  return recorder.build();
}

describe("versioned replay", () => {
  it("round-trips a complete evidence package through JSON", () => {
    const replay = recordedRun();
    const parsed = parseReplay(serializeReplay(replay));
    expect(parsed).toEqual(replay);
    expect(parsed.frames.length).toBeGreaterThan(10);
    expect(parsed.telemetry.length).toBeGreaterThan(10);
    expect(parsed.events.map((event) => event.kind)).toEqual([
      "run-started",
      "run-completed",
    ]);
    expect(parsed.terminalDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reproduces terminal state and primary metrics within declared tolerance", () => {
    const verification = verifyReplay(recordedRun(), 1e-10);
    expect(verification.compatible).toBe(true);
    expect(verification.configHashMatches).toBe(true);
    expect(verification.digestMatches).toBe(true);
    expect(verification.deterministic).toBe(true);
    expect(verification.differences.every((entry) => entry.withinTolerance)).toBe(true);
  });

  it("rejects incompatible replay and event schema versions explicitly", () => {
    const wrongReplay = recordedRun() as unknown as Record<string, unknown>;
    wrongReplay.schemaVersion = 99;
    expect(() => parseReplay(JSON.stringify(wrongReplay))).toThrowError(
      new ReplayCompatibilityError("Replay schema 99 is incompatible; this build supports 2."),
    );

    const wrongEvent = recordedRun();
    wrongEvent.events[0].schemaVersion = 99 as 2;
    expect(() => parseReplay(JSON.stringify(wrongEvent))).toThrow(/event 0 is malformed or incompatible/i);
  });

  it("rejects unordered frame timestamps", () => {
    const replay = recordedRun();
    replay.frames[2].snapshot.timestamp = -1;
    expect(() => parseReplay(JSON.stringify(replay))).toThrow(/timestamps are not ordered/i);
  });

  it("rejects configuration, seed, and terminal evidence tampering", () => {
    const changedConfig = recordedRun();
    changedConfig.config.sensor.dropoutProbability = 0.75;
    expect(() => parseReplay(JSON.stringify(changedConfig))).toThrow(/configuration hash does not match/i);

    const changedSeed = recordedRun();
    changedSeed.seed += 1;
    expect(() => parseReplay(JSON.stringify(changedSeed))).toThrow(/seed does not match/i);

    const changedResult = recordedRun();
    changedResult.result!.closestApproach += 1;
    expect(() => parseReplay(JSON.stringify(changedResult))).toThrow(/terminal digest does not match/i);
  });

  it("finds synchronized scene and telemetry state on the timeline", () => {
    const replay = recordedRun();
    const frame = findFrameAtTime(replay, 0.507);
    expect(frame?.snapshot.timestamp).toBeCloseTo(0.5, 12);
    const samples = telemetryThroughTime(replay, frame!.snapshot.timestamp);
    expect(samples.at(-1)?.timestamp).toBeLessThanOrEqual(frame!.snapshot.timestamp + 1e-12);
    expect(samples.length).toBe(10);
  });

  it("keeps a prolonged numerical soak finite", () => {
    const soak = runNumericalSoak(createDefaultConfig, 60);
    expect(soak.durationSeconds).toBeCloseTo(60, 10);
    expect(soak.physicsSteps).toBe(12_000);
    expect(soak.telemetrySamples).toBeGreaterThanOrEqual(1_200);
    expect(soak.finite).toBe(true);
    expect(soak.terminationReason).toBe("timeout");
    expect(Number.isFinite(soak.maximumCovarianceTrace)).toBe(true);
  });
});
