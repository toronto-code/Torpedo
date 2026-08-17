import {
  clamp,
  cross2,
  dot2,
  magnitude2,
  subtract2,
  wrapAngle,
} from "./math";
import type {
  GuidanceCommand,
  GuidanceConfig,
  NavigationInput,
} from "./types";

export function computeGuidance(
  input: NavigationInput,
  config: GuidanceConfig,
): GuidanceCommand {
  const relativePosition = subtract2(
    input.track.position,
    input.ownPosition,
  );
  const relativeVelocity = subtract2(
    input.track.velocity,
    input.ownVelocity,
  );
  const range = Math.max(1e-6, magnitude2(relativePosition));
  const losHeading = Math.atan2(relativePosition.z, relativePosition.x);
  const losRate =
    cross2(relativePosition, relativeVelocity) / (range * range);
  const closingVelocity =
    -dot2(relativePosition, relativeVelocity) / range;
  const rawAcceleration =
    config.law === "pure-pursuit"
      ? config.pursuitGain *
        Math.max(1, magnitude2(input.ownVelocity)) *
        wrapAngle(losHeading - input.ownHeading)
      : config.navigationConstant * Math.max(0, closingVelocity) * losRate;
  const staleScale = input.track.valid
    ? 1
    : config.staleTrackCommandScale;
  const requested = rawAcceleration * staleScale;
  const lateralAcceleration = clamp(
    requested,
    -config.maxLateralAcceleration,
    config.maxLateralAcceleration,
  );
  return {
    timestamp: input.timestamp,
    law: config.law,
    lateralAcceleration,
    desiredHeading: losHeading,
    losRate,
    closingVelocity,
    trackAge: input.track.age,
    saturated: lateralAcceleration !== requested,
  };
}

export function idleGuidance(
  timestamp: number,
  law: GuidanceConfig["law"],
  heading: number,
): GuidanceCommand {
  return {
    timestamp,
    law,
    lateralAcceleration: 0,
    desiredHeading: heading,
    losRate: 0,
    closingVelocity: 0,
    trackAge: Number.MAX_SAFE_INTEGER,
    saturated: false,
  };
}
