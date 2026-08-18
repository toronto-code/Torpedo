import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/sim/config";
import {
  ExtendedKalmanFilter,
  measurementJacobian,
  measurementModel,
} from "../src/sim/ekf";
import { wrapAngle } from "../src/sim/math";
import { isPositiveSemidefinite } from "../src/sim/matrix";
import type { SensorObservation } from "../src/sim/types";

describe("extended Kalman filter", () => {
  it("matches the analytic measurement Jacobian to finite differences", () => {
    const state = [350, -120, 8, 2];
    const sensor = { x: 40, y: 30 };
    const analytic = measurementJacobian(state, sensor);
    const epsilon = 1e-5;
    for (let index = 0; index < 4; index += 1) {
      const plus = [...state];
      const minus = [...state];
      plus[index] += epsilon;
      minus[index] -= epsilon;
      const hPlus = measurementModel(plus, sensor, 0.4);
      const hMinus = measurementModel(minus, sensor, 0.4);
      const numerical = [
        wrapAngle(hPlus[0] - hMinus[0]) / (2 * epsilon),
        (hPlus[1] - hMinus[1]) / (2 * epsilon),
      ];
      expect(analytic[0][index]).toBeCloseTo(numerical[0], 6);
      expect(analytic[1][index]).toBeCloseTo(numerical[1], 6);
    }
  });

  it("initializes and predicts a valid estimate", () => {
    const filter = new ExtendedKalmanFilter(
      createDefaultConfig().estimator,
    );
    const observation: SensorObservation = {
      id: 1,
      observedAt: 0,
      deliveredAt: 0.08,
      bearing: 0.1,
      range: 1000,
      bearingVariance: 0.001,
      rangeVariance: 100,
      sensorPosition: { x: 0, y: 0 },
      sensorHeading: 0,
    };
    expect(filter.process(observation)).toBe(true);
    const estimate = filter.estimateAt(1);
    expect(estimate?.valid).toBe(true);
    expect(estimate?.position.x).toBeCloseTo(
      Math.cos(0.1) * 1000,
      6,
    );
    expect(estimate?.covariance[0][0]).toBeGreaterThan(0);
    expect(isPositiveSemidefinite(estimate!.covariance)).toBe(true);
  });

  it("rejects a statistically inconsistent observation", () => {
    const filter = new ExtendedKalmanFilter(
      createDefaultConfig().estimator,
    );
    const initial: SensorObservation = {
      id: 1,
      observedAt: 0,
      deliveredAt: 0.08,
      bearing: 0.1,
      range: 1000,
      bearingVariance: 0.0004,
      rangeVariance: 64,
      sensorPosition: { x: 0, y: 0 },
      sensorHeading: 0,
    };
    filter.process(initial);
    const outlier: SensorObservation = {
      ...initial,
      id: 2,
      observedAt: 0.125,
      deliveredAt: 0.205,
      bearing: -2.4,
      range: 2800,
    };
    expect(filter.process(outlier)).toBe(false);
    const estimate = filter.estimateAt(outlier.deliveredAt)!;
    expect(estimate.observationAccepted).toBe(false);
    expect(estimate.nis).toBeGreaterThan(
      createDefaultConfig().estimator.innovationGate,
    );
  });
});
