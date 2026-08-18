import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultConfig, createPortfolioDemoConfig } from "../src/sim/config";
import { runHeadless } from "../src/sim/engine";
import { applyHydrodynamicProfile } from "../src/sim/hydrodynamic-profiles";
import { conjugateQuaternion, multiplyQuaternion } from "../src/sim/quaternion";

/**
 * Behavioral regression evidence for the NED coordinate migration.
 *
 * The golden fixtures in tests/golden/ned-migration.json were captured from
 * the pre-migration kernel (x/z-horizontal, y-up) immediately before the NED
 * refactor. The old convention maps onto NED through the proper rotation
 * (x, y, z)_old -> (x, z, -y)_ned, and old quaternions conjugate as
 * q_ned = R * q_old * R^-1 with R the quaternion of Rx(-90°). Comparisons are
 * therefore exact relabelings, not approximations: planar scenarios reproduce
 * bit-identically and six-DOF runs agree to floating-point round-off through
 * the quaternion arithmetic (measured worst case 4.5e-13 m). The documented
 * comparison tolerance is 1e-9 absolute, well inside the project's 1e-10
 * relative determinism basis for metre-scale trajectories.
 */

interface GoldenSample {
  timestamp: number;
  torpedo: GoldenVehicle;
  target: GoldenVehicle;
  estimate: { position: { x: number; z: number }; velocity: { x: number; z: number } } | null;
  metrics: {
    range: number;
    horizontalRange: number;
    verticalSeparation: number;
    closingVelocity: number;
    losRate: number;
    relativeBearing: number;
  };
  lateralAcceleration: number;
}

interface GoldenVehicle {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  heading: number;
  speed: number;
  depth: number;
  depthRate: number;
  yawRate: number;
  orientation: { w: number; x: number; y: number; z: number };
}

interface GoldenRun {
  name: string;
  result: Record<string, number | string | null>;
  samples: GoldenSample[];
}

const TOLERANCE = 1e-9;

const NED_ROTATION = { w: Math.SQRT1_2, x: -Math.SQRT1_2, y: 0, z: 0 };

function mapOldVector(value: { x: number; y: number; z: number }) {
  return { x: value.x, y: value.z, z: -value.y };
}

function mapOldQuaternion(value: { w: number; x: number; y: number; z: number }) {
  return multiplyQuaternion(
    multiplyQuaternion(NED_ROTATION, value),
    conjugateQuaternion(NED_ROTATION),
  );
}

function expectClose(actual: number, expected: number, context: string) {
  expect(Math.abs(actual - expected), `${context}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    TOLERANCE,
  );
}

function buildGoldenConfig(name: string) {
  if (name === "sixdof-demo") return createPortfolioDemoConfig();
  const config = createDefaultConfig();
  if (name === "planar-evasive-pursuit-raw") {
    config.scenario.kind = "scripted-evasive";
    config.guidance.law = "pure-pursuit";
    config.guidance.mode = "raw";
  }
  if (name === "planar-perfect-cv") {
    config.scenario.kind = "constant-velocity";
    config.guidance.mode = "perfect";
  }
  if (name === "sixdof-bluerov") {
    applyHydrodynamicProfile(config, "bluerov2-heavy-2024");
  }
  return config;
}

const golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "golden/ned-migration.json"), "utf8"),
) as { runs: GoldenRun[] };

describe("NED migration behavioral regression", () => {
  for (const run of golden.runs) {
    it(`reproduces the pre-migration ${run.name} run within the documented tolerance`, () => {
      const result = runHeadless(buildGoldenConfig(run.name));
      expect(result.result.terminationReason).toBe(run.result.terminationReason);
      expect(result.result.observationsAccepted).toBe(run.result.observationsAccepted);
      expect(result.result.observationsRejected).toBe(run.result.observationsRejected);
      expectClose(result.result.elapsedTime, run.result.elapsedTime as number, "elapsedTime");
      expectClose(result.result.closestApproach, run.result.closestApproach as number, "closestApproach");
      expectClose(result.result.finalRange, run.result.finalRange as number, "finalRange");

      expect(result.telemetry.length).toBeGreaterThanOrEqual(run.samples.length * 20 - 19);
      for (let index = 0; index < run.samples.length; index += 1) {
        const sample = run.samples[index];
        const telemetry = result.telemetry[index * 20];
        expect(telemetry, `sample ${index} exists`).toBeDefined();
        expectClose(telemetry.timestamp, sample.timestamp, "timestamp");

        for (const vehicle of ["torpedo", "target"] as const) {
          const expected = sample[vehicle];
          const actual = telemetry[vehicle];
          const position = mapOldVector(expected.position);
          const velocity = mapOldVector(expected.velocity);
          const orientation = mapOldQuaternion(expected.orientation);
          for (const axis of ["x", "y", "z"] as const) {
            expectClose(actual.position[axis], position[axis], `${vehicle}.position.${axis}`);
            expectClose(actual.velocity[axis], velocity[axis], `${vehicle}.velocity.${axis}`);
          }
          expectClose(actual.heading, expected.heading, `${vehicle}.heading`);
          expectClose(actual.speed, expected.speed, `${vehicle}.speed`);
          expectClose(actual.depth, expected.depth, `${vehicle}.depth`);
          expectClose(actual.depthRate, expected.depthRate, `${vehicle}.depthRate`);
          expectClose(actual.yawRate, expected.yawRate, `${vehicle}.yawRate`);
          for (const component of ["w", "x", "y", "z"] as const) {
            expectClose(
              actual.orientation[component],
              orientation[component],
              `${vehicle}.orientation.${component}`,
            );
          }
        }

        expectClose(telemetry.metrics.range, sample.metrics.range, "metrics.range");
        expectClose(telemetry.metrics.horizontalRange, sample.metrics.horizontalRange, "metrics.horizontalRange");
        expectClose(
          telemetry.metrics.verticalSeparation,
          -sample.metrics.verticalSeparation,
          "metrics.verticalSeparation (NED down positive)",
        );
        expectClose(telemetry.metrics.closingVelocity, sample.metrics.closingVelocity, "metrics.closingVelocity");
        expectClose(telemetry.metrics.losRate, sample.metrics.losRate, "metrics.losRate");
        expectClose(
          telemetry.guidance.lateralAcceleration,
          sample.lateralAcceleration,
          "guidance.lateralAcceleration",
        );

        if (sample.estimate && telemetry.estimate) {
          expectClose(telemetry.estimate.position.x, sample.estimate.position.x, "estimate.position.x");
          expectClose(telemetry.estimate.position.y, sample.estimate.position.z, "estimate.position.y");
          expectClose(telemetry.estimate.velocity.x, sample.estimate.velocity.x, "estimate.velocity.x");
          expectClose(telemetry.estimate.velocity.y, sample.estimate.velocity.z, "estimate.velocity.y");
        }
      }
    });
  }
});
