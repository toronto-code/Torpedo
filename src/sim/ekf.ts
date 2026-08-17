import {
  add,
  column,
  diagonal,
  identity,
  inverse,
  multiply,
  quadraticForm,
  subtract,
  symmetrize,
  transpose,
  type Matrix,
} from "./matrix";
import { wrapAngle } from "./math";
import type {
  EstimatorConfig,
  SensorObservation,
  TrackEstimate,
  Vec2,
} from "./types";

interface FilterState {
  timestamp: number;
  state: number[];
  covariance: Matrix;
}

export function measurementModel(
  state: readonly number[],
  sensorPosition: Vec2,
  sensorHeading: number,
): [number, number] {
  const dx = state[0] - sensorPosition.x;
  const dz = state[1] - sensorPosition.z;
  return [
    wrapAngle(Math.atan2(dz, dx) - sensorHeading),
    Math.hypot(dx, dz),
  ];
}

export function measurementJacobian(
  state: readonly number[],
  sensorPosition: Vec2,
): Matrix {
  const dx = state[0] - sensorPosition.x;
  const dz = state[1] - sensorPosition.z;
  const rangeSquared = Math.max(1e-9, dx * dx + dz * dz);
  const range = Math.sqrt(rangeSquared);
  return [
    [-dz / rangeSquared, dx / rangeSquared, 0, 0],
    [dx / range, dz / range, 0, 0],
  ];
}

function transition(dt: number): Matrix {
  return [
    [1, 0, dt, 0],
    [0, 1, 0, dt],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
}

function processNoise(dt: number, accelerationNoise: number): Matrix {
  const q = accelerationNoise ** 2;
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const dt4 = dt2 * dt2;
  return [
    [(q * dt4) / 4, 0, (q * dt3) / 2, 0],
    [0, (q * dt4) / 4, 0, (q * dt3) / 2],
    [(q * dt3) / 2, 0, q * dt2, 0],
    [0, (q * dt3) / 2, 0, q * dt2],
  ];
}

function predict(
  filter: FilterState,
  timestamp: number,
  config: EstimatorConfig,
): FilterState {
  const dt = timestamp - filter.timestamp;
  if (dt < -1e-9) {
    throw new Error("Out-of-sequence observation received by EKF.");
  }
  if (dt <= 1e-12) {
    return {
      ...filter,
      state: [...filter.state],
      covariance: filter.covariance.map((row) => [...row]),
    };
  }
  const f = transition(dt);
  return {
    timestamp,
    state: multiply(f, column(filter.state)).map((row) => row[0]),
    covariance: symmetrize(
      add(
        multiply(multiply(f, filter.covariance), transpose(f)),
        processNoise(dt, config.accelerationNoise),
      ),
    ),
  };
}

export class ExtendedKalmanFilter {
  private filter: FilterState | null = null;
  private lastObservationAt: number | null = null;
  private lastInnovation: [number, number] | undefined;
  private lastNis: number | undefined;
  private lastAccepted: boolean | undefined;

  constructor(private readonly config: EstimatorConfig) {}

  process(observation: SensorObservation): boolean {
    if (!this.filter) {
      const absoluteBearing = observation.sensorHeading + observation.bearing;
      const positionVariance =
        observation.rangeVariance +
        observation.range ** 2 * observation.bearingVariance;
      this.filter = {
        timestamp: observation.observedAt,
        state: [
          observation.sensorPosition.x +
            observation.range * Math.cos(absoluteBearing),
          observation.sensorPosition.z +
            observation.range * Math.sin(absoluteBearing),
          0,
          0,
        ],
        covariance: diagonal([
          positionVariance,
          positionVariance,
          this.config.initialVelocityVariance,
          this.config.initialVelocityVariance,
        ]),
      };
      this.lastObservationAt = observation.observedAt;
      this.lastAccepted = true;
      return true;
    }

    const predicted = predict(this.filter, observation.observedAt, this.config);
    const h = measurementJacobian(predicted.state, observation.sensorPosition);
    const expected = measurementModel(
      predicted.state,
      observation.sensorPosition,
      observation.sensorHeading,
    );
    const innovation: [number, number] = [
      wrapAngle(observation.bearing - expected[0]),
      observation.range - expected[1],
    ];
    const r = diagonal([
      observation.bearingVariance,
      observation.rangeVariance,
    ]);
    const s = add(
      multiply(multiply(h, predicted.covariance), transpose(h)),
      r,
    );
    const sInverse = inverse(s);
    if (!sInverse) {
      this.filter = predicted;
      this.lastAccepted = false;
      return false;
    }
    const nis = quadraticForm(innovation, sInverse);
    this.lastInnovation = innovation;
    this.lastNis = nis;
    if (nis > this.config.innovationGate) {
      this.filter = predicted;
      this.lastAccepted = false;
      return false;
    }

    const k = multiply(
      multiply(predicted.covariance, transpose(h)),
      sInverse,
    );
    const correction = multiply(k, column(innovation)).map((row) => row[0]);
    const state = predicted.state.map(
      (value, index) => value + correction[index],
    );
    const iMinusKh = subtract(identity(4), multiply(k, h));
    const covariance = symmetrize(
      add(
        multiply(
          multiply(iMinusKh, predicted.covariance),
          transpose(iMinusKh),
        ),
        multiply(multiply(k, r), transpose(k)),
      ),
    );
    this.filter = { timestamp: observation.observedAt, state, covariance };
    this.lastObservationAt = observation.observedAt;
    this.lastAccepted = true;
    return true;
  }

  estimateAt(timestamp: number): TrackEstimate | null {
    if (!this.filter) return null;
    const predicted = predict(this.filter, timestamp, this.config);
    const age = timestamp - (this.lastObservationAt ?? this.filter.timestamp);
    const estimate: TrackEstimate = {
      timestamp,
      position: { x: predicted.state[0], z: predicted.state[1] },
      velocity: { x: predicted.state[2], z: predicted.state[3] },
      covariance: predicted.covariance,
      age,
      valid: age <= this.config.staleAfter,
      source: "ekf",
      observationAccepted: this.lastAccepted,
    };
    if (this.lastInnovation !== undefined) estimate.innovation = this.lastInnovation;
    if (this.lastNis !== undefined) estimate.nis = this.lastNis;
    return estimate;
  }
}
