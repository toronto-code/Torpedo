import { diagonal } from "./matrix";
import { wrapAngle } from "./math";
import type {
  SensorObservation,
  TrackEstimate,
  VehicleState,
} from "./types";

export class RawObservationTracker {
  private previous: { timestamp: number; x: number; y: number } | null = null;
  private current: {
    timestamp: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    covariance: number[][];
  } | null = null;

  process(observation: SensorObservation): void {
    const absoluteBearing = wrapAngle(
      observation.sensorHeading + observation.bearing,
    );
    const x =
      observation.sensorPosition.x +
      Math.cos(absoluteBearing) * observation.range;
    const y =
      observation.sensorPosition.y +
      Math.sin(absoluteBearing) * observation.range;
    const dt = this.previous
      ? observation.observedAt - this.previous.timestamp
      : 0;
    const measuredVx =
      dt > 1e-6 && this.previous ? (x - this.previous.x) / dt : 0;
    const measuredVy =
      dt > 1e-6 && this.previous ? (y - this.previous.y) / dt : 0;
    const alpha = 0.35;
    const vx = this.current
      ? this.current.vx * (1 - alpha) + measuredVx * alpha
      : measuredVx;
    const vy = this.current
      ? this.current.vy * (1 - alpha) + measuredVy * alpha
      : measuredVy;
    const positionVariance =
      observation.rangeVariance +
      observation.range ** 2 * observation.bearingVariance;
    this.previous = { timestamp: observation.observedAt, x, y };
    this.current = {
      timestamp: observation.observedAt,
      x,
      y,
      vx,
      vy,
      covariance: diagonal([
        positionVariance,
        positionVariance,
        900,
        900,
      ]),
    };
  }

  estimateAt(timestamp: number): TrackEstimate | null {
    if (!this.current) return null;
    const age = timestamp - this.current.timestamp;
    return {
      timestamp,
      position: {
        x: this.current.x + this.current.vx * age,
        y: this.current.y + this.current.vy * age,
      },
      velocity: { x: this.current.vx, y: this.current.vy },
      covariance: this.current.covariance,
      age,
      valid: age <= 1.5,
      source: "raw",
    };
  }
}

export function perfectTrack(
  target: VehicleState,
  timestamp: number,
): TrackEstimate {
  return {
    timestamp,
    position: { x: target.position.x, y: target.position.y },
    velocity: { x: target.velocity.x, y: target.velocity.y },
    covariance: diagonal([1e-9, 1e-9, 1e-9, 1e-9]),
    age: 0,
    valid: true,
    source: "perfect",
  };
}
