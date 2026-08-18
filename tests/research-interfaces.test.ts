import { describe, expect, it } from "vitest";

import {
  RESEARCH_INTERFACE_CAPABILITIES,
  RecordedSensorPlayback,
  SYNTHETIC_ACOUSTIC_SIGNATURES,
  syntheticRelativeLevelDb,
} from "../src/sim/research-interfaces";

describe("non-operational research interfaces", () => {
  it("uses explicitly synthetic acoustic signatures with finite spectra", () => {
    const signature = SYNTHETIC_ACOUSTIC_SIGNATURES["quiet-electric-rov"];
    expect(signature.basis).toBe("synthetic-non-identifying");
    expect(syntheticRelativeLevelDb(signature, 120)).toBeGreaterThan(
      syntheticRelativeLevelDb(signature, 1_200),
    );
    expect(Number.isFinite(syntheticRelativeLevelDb(signature, 0))).toBe(true);
  });

  it("plays immutable recorded frames deterministically", () => {
    const playback = new RecordedSensorPlayback([
      { timestamp: 0.1, payload: { range: 8 } },
      { timestamp: 0.2, payload: { range: 7.5 } },
    ]);
    expect(playback.readThrough(0.15)).toEqual([
      { timestamp: 0.1, payload: { range: 8 } },
    ]);
    expect(playback.readThrough(0.25)).toHaveLength(1);
    expect(playback.readThrough(0.25)).toEqual([]);
    playback.reset();
    expect(playback.readThrough(0.25)).toHaveLength(2);
  });

  it("declares that live I/O, actuator commands, and external targeting are absent", () => {
    expect(RESEARCH_INTERFACE_CAPABILITIES).toEqual({
      mode: "recorded-playback",
      liveIo: false,
      actuatorCommands: false,
      externalTargeting: false,
    });
  });

  it("rejects invalid recordings and frequency inputs", () => {
    expect(() => new RecordedSensorPlayback([{ timestamp: -1, payload: null }])).toThrow();
    expect(() => new RecordedSensorPlayback([
      { timestamp: 2, payload: null },
      { timestamp: 1, payload: null },
    ])).toThrow("sorted");
    expect(() => syntheticRelativeLevelDb(
      SYNTHETIC_ACOUSTIC_SIGNATURES["survey-thruster-lab"],
      Number.NaN,
    )).toThrow();
  });
});
