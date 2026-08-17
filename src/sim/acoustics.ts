import type {
  AcousticChannelState,
  AcousticConfig,
  EnvironmentConfig,
} from "./types";

/** Mackenzie (1981) sound-speed approximation for ordinary ocean conditions. */
export function soundSpeedMackenzie(
  temperatureC: number,
  salinityPsu: number,
  depthM: number,
): number {
  const t = temperatureC;
  const d = Math.max(0, depthM);
  const salinityOffset = salinityPsu - 35;
  return 1448.96
    + 4.591 * t
    - 5.304e-2 * t ** 2
    + 2.374e-4 * t ** 3
    + 1.34 * salinityOffset
    + 1.63e-2 * d
    + 1.675e-7 * d ** 2
    - 1.025e-2 * t * salinityOffset
    - 7.139e-13 * t * d ** 3;
}

/** Thorp volume-absorption approximation used as an analytic baseline by BELLHOP. */
export function thorpAbsorptionDbPerKm(frequencyKhz: number): number {
  const f2 = Math.max(0, frequencyKhz) ** 2;
  return 0.11 * f2 / (1 + f2)
    + 44 * f2 / (4100 + f2)
    + 2.75e-4 * f2
    + 0.003;
}

export function acousticChannel(
  timestamp: number,
  rangeM: number,
  sourceDepthM: number,
  receiverDepthM: number,
  environment: EnvironmentConfig,
  acoustic: AcousticConfig,
): AcousticChannelState {
  const range = Math.max(1, rangeM);
  const meanDepth = Math.min(
    environment.waterDepth,
    Math.max(0, (sourceDepthM + receiverDepthM) / 2),
  );
  const soundSpeed = soundSpeedMackenzie(
    environment.temperatureC,
    environment.salinityPsu,
    meanDepth,
  );
  const absorptionDbPerKm = thorpAbsorptionDbPerKm(acoustic.frequencyKhz);
  const oneWayTransmissionLossDb =
    environment.spreadingCoefficient * Math.log10(range)
    + absorptionDbPerKm * range / 1000;
  const receivedEchoLevelDb =
    acoustic.sourceLevelDb
    - 2 * oneWayTransmissionLossDb
    + acoustic.targetStrengthDb;
  const signalToNoiseDb = receivedEchoLevelDb
    - (acoustic.ambientNoiseDb - acoustic.receiverDirectivityIndexDb);
  const scale = Math.max(0.01, acoustic.detectionTransitionDb);
  const detectionProbability = 1 / (
    1 + Math.exp(-(signalToNoiseDb - acoustic.detectionThresholdDb) / scale)
  );
  return {
    timestamp,
    soundSpeed,
    absorptionDbPerKm,
    oneWayTransmissionLossDb,
    receivedEchoLevelDb,
    signalToNoiseDb,
    detectionProbability,
    propagationDelay: 2 * range / soundSpeed,
  };
}
