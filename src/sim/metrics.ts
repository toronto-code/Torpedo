import {
  cross2,
  dot2,
  magnitude2,
  subtract2,
  wrapAngle,
} from "./math";
import { inverse, quadraticForm } from "./matrix";
import type {
  EngagementMetrics,
  TrackEstimate,
  VehicleState,
} from "./types";

export function engagementMetrics(
  torpedo: VehicleState,
  target: VehicleState,
  estimate: TrackEstimate | null,
): EngagementMetrics {
  const truthPosition = subtract2(target.position, torpedo.position);
  const truthVelocity = subtract2(target.velocity, torpedo.velocity);
  const horizontalRange = magnitude2(truthPosition);
  const verticalSeparation = target.position.y - torpedo.position.y;
  const verticalRelativeVelocity = target.velocity.y - torpedo.velocity.y;
  const range = Math.max(
    1e-9,
    Math.hypot(horizontalRange, verticalSeparation),
  );
  const predictionPosition = estimate
    ? subtract2(estimate.position, torpedo.position)
    : truthPosition;
  const predictionVelocity = estimate
    ? subtract2(estimate.velocity, torpedo.velocity)
    : truthVelocity;
  const predictedVelocitySquared =
    dot2(predictionVelocity, predictionVelocity) +
    verticalRelativeVelocity ** 2;
  const predictedTime =
    predictedVelocitySquared < 1e-12
      ? 0
      : Math.max(
          0,
          -(
            dot2(predictionPosition, predictionVelocity) +
            verticalSeparation * verticalRelativeVelocity
          ) / predictedVelocitySquared,
        );
  const predictedHorizontalX =
    predictionPosition.x + predictionVelocity.x * predictedTime;
  const predictedHorizontalZ =
    predictionPosition.z + predictionVelocity.z * predictedTime;
  const predictedVertical =
    verticalSeparation + verticalRelativeVelocity * predictedTime;
  const threeDimensionalClosingVelocity =
    -(
      dot2(truthPosition, truthVelocity) +
      verticalSeparation * verticalRelativeVelocity
    ) / range;
  return {
    range,
    horizontalRange,
    verticalSeparation,
    relativeBearing: wrapAngle(
      Math.atan2(truthPosition.z, truthPosition.x) - torpedo.heading,
    ),
    closingVelocity: threeDimensionalClosingVelocity,
    losRate:
      cross2(truthPosition, truthVelocity) /
      Math.max(1e-9, horizontalRange * horizontalRange),
    predictedMissDistance: Math.hypot(
      predictedHorizontalX,
      predictedHorizontalZ,
      predictedVertical,
    ),
    predictedTimeToCpa: predictedTime,
  };
}

export function estimationError(
  estimate: TrackEstimate | null,
  target: VehicleState,
): number | null {
  if (!estimate) return null;
  return Math.hypot(
    estimate.position.x - target.position.x,
    estimate.position.z - target.position.z,
  );
}

export function normalizedEstimationErrorSquared(
  estimate: TrackEstimate | null,
  target: VehicleState,
): number | null {
  if (!estimate || estimate.source !== "ekf") return null;
  const covarianceInverse = inverse(estimate.covariance);
  if (!covarianceInverse) return null;
  const error = [
    target.position.x - estimate.position.x,
    target.position.z - estimate.position.z,
    target.velocity.x - estimate.velocity.x,
    target.velocity.z - estimate.velocity.z,
  ];
  return quadraticForm(error, covarianceInverse);
}
