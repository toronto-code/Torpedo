/**
 * Non-operational research fixtures for reproducible acoustic experiments.
 *
 * This module intentionally exposes recorded-data playback only. It contains no
 * transport discovery, network/serial access, actuator messages, or live control.
 */

export interface SyntheticAcousticBand {
  centerFrequencyHz: number;
  relativeLevelDb: number;
  bandwidthHz: number;
}

export interface SyntheticAcousticSignature {
  id: "quiet-electric-rov" | "survey-thruster-lab";
  basis: "synthetic-non-identifying";
  broadbandFloorDb: number;
  bands: readonly SyntheticAcousticBand[];
}

export const SYNTHETIC_ACOUSTIC_SIGNATURES: Record<
  SyntheticAcousticSignature["id"],
  SyntheticAcousticSignature
> = {
  "quiet-electric-rov": {
    id: "quiet-electric-rov",
    basis: "synthetic-non-identifying",
    broadbandFloorDb: -32,
    bands: [
      { centerFrequencyHz: 120, relativeLevelDb: -12, bandwidthHz: 18 },
      { centerFrequencyHz: 360, relativeLevelDb: -18, bandwidthHz: 42 },
    ],
  },
  "survey-thruster-lab": {
    id: "survey-thruster-lab",
    basis: "synthetic-non-identifying",
    broadbandFloorDb: -24,
    bands: [
      { centerFrequencyHz: 90, relativeLevelDb: -8, bandwidthHz: 22 },
      { centerFrequencyHz: 270, relativeLevelDb: -14, bandwidthHz: 55 },
    ],
  },
};

export function syntheticRelativeLevelDb(
  signature: SyntheticAcousticSignature,
  frequencyHz: number,
): number {
  if (!Number.isFinite(frequencyHz) || frequencyHz < 0) {
    throw new Error("frequencyHz must be finite and nonnegative.");
  }
  let linearPower = 10 ** (signature.broadbandFloorDb / 10);
  for (const band of signature.bands) {
    const normalizedOffset =
      (frequencyHz - band.centerFrequencyHz) / Math.max(1, band.bandwidthHz);
    linearPower += 10 ** (band.relativeLevelDb / 10) * Math.exp(-0.5 * normalizedOffset ** 2);
  }
  return 10 * Math.log10(linearPower);
}

export interface RecordedSensorFrame<TPayload = unknown> {
  timestamp: number;
  payload: TPayload;
}

export const RESEARCH_INTERFACE_CAPABILITIES = Object.freeze({
  mode: "recorded-playback" as const,
  liveIo: false as const,
  actuatorCommands: false as const,
  externalTargeting: false as const,
});

/** Deterministic playback adapter for checked-in or user-supplied recordings. */
export class RecordedSensorPlayback<TPayload = unknown> {
  readonly capabilities = RESEARCH_INTERFACE_CAPABILITIES;
  private cursor = 0;
  private readonly frames: readonly RecordedSensorFrame<TPayload>[];

  constructor(frames: readonly RecordedSensorFrame<TPayload>[]) {
    this.frames = frames.map((frame, index) => {
      if (!Number.isFinite(frame.timestamp) || frame.timestamp < 0) {
        throw new Error(`frames[${index}].timestamp must be finite and nonnegative.`);
      }
      if (index > 0 && frame.timestamp < frames[index - 1].timestamp) {
        throw new Error("Recorded frames must be sorted by timestamp.");
      }
      return Object.freeze({ timestamp: frame.timestamp, payload: structuredClone(frame.payload) });
    });
  }

  reset(): void {
    this.cursor = 0;
  }

  readThrough(timestamp: number): RecordedSensorFrame<TPayload>[] {
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new Error("timestamp must be finite and nonnegative.");
    }
    const available: RecordedSensorFrame<TPayload>[] = [];
    while (this.cursor < this.frames.length && this.frames[this.cursor].timestamp <= timestamp) {
      available.push(structuredClone(this.frames[this.cursor]));
      this.cursor += 1;
    }
    return available;
  }
}
