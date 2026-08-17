import { diagonal } from "./matrix";
import { wrapAngle } from "./math";
import type {
  SensorObservation,
  TrackEstimate,
  VehicleState,
} from "./types";

export class RawObservationTracker {
  private previous: { timestamp: number; x: number; z: number } | null = null;
  private current: {
    timestamp: number;
    x: number;
    z: number;
    vx: number;
    vz: number;
    covariance: number[][];
  } | null = null;

  process(observation: SensorObservation): void {
    const absoluteBearing = wrapAngle(
      observation.sensorHeading + observation.bearing,
    );
    const x =
      observation.sensorPosition.x +
      Math.cos(absoluteBearing) * observation.range;
    const z =
      observation.sensorPosition.z +
      Math.sin(absoluteBearing) * observation.range;
    const dt = this.previous
      ? observation.observedAt - this.previous.timestamp
      : 0;
    const measuredVx =
      dt > 1e-6 && this.previous ? (x - this.previous.x) / dt : 0;
    const measuredVz =
      dt > 1e-6 && this.previous ? (z - this.previous.z) / dt : 0;
    const alpha = 0.35;
    const vx = this.current
      ? this.current.vx * (1 - alpha) + measuredVx * alpha
      : measuredVx;
    const vz = this.current
      ? this.current.vz * (1 - alpha) + measuredVz * alpha
      : measuredVz;
    const positionVariance =
      observation.rangeVariance +
      observation.range ** 2 * observation.bearingVariance;
    this.previous = { timestamp: observation.observedAt, x, z };
    this.current = {
      timestamp: observation.observedAt,
      x,
      z,
      vx,
      vz,
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
        z: this.current.z + this.current.vz * age,
      },
      velocity: { x: this.current.vx, z: this.current.vz },
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
    position: { x: target.position.x, z: target.position.z },
    velocity: { x: target.velocity.x, z: target.velocity.z },
    covariance: diagonal([1e-9, 1e-9, 1e-9, 1e-9]),
    age: 0,
    valid: true,
    source: "perfect",
  };
}
