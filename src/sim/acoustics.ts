import type {
  AcousticChannelState,
  AcousticConfig,
  EnvironmentConfig,
  SoundProfileConfig,
} from "./types";

/** Piecewise synthetic sound-speed profile: constant in the mixed layer,
 *  falling across the thermocline, then rising with the deep gradient. */
export function soundSpeedAtDepth(
  profile: SoundProfileConfig,
  environment: EnvironmentConfig,
  depthM: number,
): number {
  const surfaceSpeed = soundSpeedMackenzie(
    environment.temperatureC,
    environment.salinityPsu,
    0,
  );
  const depth = Math.max(0, depthM);
  const thermoclineThickness = Math.max(
    1,
    Math.min(150, profile.layerDepth * 0.75),
  );
  if (depth <= profile.layerDepth) return surfaceSpeed;
  if (depth <= profile.layerDepth + thermoclineThickness) {
    const fraction = (depth - profile.layerDepth) / thermoclineThickness;
    return surfaceSpeed - profile.thermoclineDrop * fraction;
  }
  return (
    surfaceSpeed -
    profile.thermoclineDrop +
    profile.deepGradient * (depth - profile.layerDepth - thermoclineThickness)
  );
}

/** Layer-straddling refraction loss: full within recoveryRange, fading to
 *  zero across fadeWidth beyond it (convergence-zone flavor). Synthetic. */
export function refractionLossDb(
  profile: SoundProfileConfig,
  sourceDepthM: number,
  receiverDepthM: number,
  rangeM: number,
): number {
  const straddles =
    (sourceDepthM - profile.layerDepth) * (receiverDepthM - profile.layerDepth) < 0;
  if (!straddles || rangeM >= profile.recoveryRange + profile.fadeWidth) return 0;
  const bounded = Math.max(1, rangeM);
  const factor =
    bounded <= profile.recoveryRange
      ? 1
      : 1 - (bounded - profile.recoveryRange) / profile.fadeWidth;
  return profile.layerLossDb * factor;
}

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
  const profile = environment.soundProfile;
  const soundSpeed = profile
    ? 0.5 *
      (soundSpeedAtDepth(profile, environment, sourceDepthM) +
        soundSpeedAtDepth(profile, environment, receiverDepthM))
    : soundSpeedMackenzie(
        environment.temperatureC,
        environment.salinityPsu,
        meanDepth,
      );
  const refraction = profile
    ? refractionLossDb(profile, sourceDepthM, receiverDepthM, range)
    : 0;
  const absorptionDbPerKm = thorpAbsorptionDbPerKm(acoustic.frequencyKhz);
  const oneWayTransmissionLossDb =
    environment.spreadingCoefficient * Math.log10(range)
    + absorptionDbPerKm * range / 1000
    + refraction;
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
    ...(profile ? { refractionLossDb: refraction } : {}),
  };
}

export interface ScreeningVolume {
  x: number;
  y: number;
  radiusM: number;
  lossDb: number;
}

/** Extra one-way loss when the direct path passes through a screening
 *  volume (a bubble cloud): full loss through the center, fading to zero
 *  at the rim. Returns 0 when the path misses every volume. */
export function pathScreeningLossDb(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  volumes: readonly ScreeningVolume[],
): number {
  if (volumes.length === 0) return 0;
  const dx = toX - fromX;
  const dy = toY - fromY;
  const lengthSquared = dx * dx + dy * dy;
  let total = 0;
  for (const volume of volumes) {
    let t = lengthSquared > 1e-9
      ? ((volume.x - fromX) * dx + (volume.y - fromY) * dy) / lengthSquared
      : 0;
    t = Math.max(0, Math.min(1, t));
    const closestX = fromX + dx * t;
    const closestY = fromY + dy * t;
    const miss = Math.hypot(volume.x - closestX, volume.y - closestY);
    if (miss < volume.radiusM) {
      const depth = 1 - miss / volume.radiusM;
      total += volume.lossDb * depth;
    }
  }
  return total;
}

/** Power-sums an in-band jammer's noise into an ambient level (dB). */
export function powerSumDb(a: number, b: number): number {
  return 10 * Math.log10(10 ** (a / 10) + 10 ** (b / 10));
}
