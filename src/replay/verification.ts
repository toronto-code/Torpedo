import { hashConfig } from "../sim/config";
import { runHeadless } from "../sim/engine";
import { quaternionNorm } from "../sim/quaternion";
import type { ExperimentResult, SimulationConfig } from "../sim/types";
import { validateReplay } from "./codec";
import { replayDigest } from "./hash";
import type {
  MetricDifference,
  ReplayFile,
  ReplayVerification,
} from "./types";

const RESULT_FIELDS: Array<keyof ExperimentResult> = [
  "seed",
  "configHash",
  "mode",
  "law",
  "scenario",
  "dynamicsModel",
  "terminationReason",
  "elapsedTime",
  "closestApproach",
  "finalRange",
  "finalEstimationError",
  "meanNis",
  "meanNees",
  "observationsAccepted",
  "observationsRejected",
  "saturationFraction",
  "meanControlEffort",
  "meanActuatorTrackingError",
  "maximumRoll",
  "maximumPitch",
];

function difference(
  name: keyof ExperimentResult,
  expected: ExperimentResult[keyof ExperimentResult],
  actual: ExperimentResult[keyof ExperimentResult],
  tolerance: number,
): MetricDifference {
  if (typeof expected === "number" && typeof actual === "number") {
    const absoluteDifference = Math.abs(expected - actual);
    return { name, expected, actual, absoluteDifference, withinTolerance: absoluteDifference <= tolerance };
  }
  return {
    name,
    expected: expected as string | number | null,
    actual: actual as string | number | null,
    absoluteDifference: null,
    withinTolerance: expected === actual,
  };
}

export function verifyReplay(
  replay: ReplayFile,
  tolerance = 1e-9,
): ReplayVerification {
  const startedAt = performance.now();
  validateReplay(replay);
  if (!replay.result) {
    return {
      compatible: true,
      deterministic: false,
      tolerance,
      configHashMatches: hashConfig(replay.config) === replay.configHash,
      digestMatches: false,
      differences: [],
      rerunResult: null,
      elapsedWallMs: performance.now() - startedAt,
    };
  }
  const rerun = runHeadless(structuredClone(replay.config));
  const differences = RESULT_FIELDS.map((name) =>
    difference(name, replay.result![name], rerun.result[name], tolerance),
  );
  const rerunDigest = replayDigest({
    configHash: hashConfig(replay.config),
    result: rerun.result,
    finalTelemetry: rerun.telemetry.at(-1) ?? null,
  });
  const configHashMatches = hashConfig(replay.config) === replay.configHash;
  const digestMatches = rerunDigest === replay.terminalDigest;
  return {
    compatible: true,
    deterministic:
      configHashMatches && digestMatches && differences.every((entry) => entry.withinTolerance),
    tolerance,
    configHashMatches,
    digestMatches,
    differences,
    rerunResult: rerun.result,
    elapsedWallMs: performance.now() - startedAt,
  };
}

export interface SoakResult {
  dynamicsModel: SimulationConfig["dynamics"]["model"];
  durationSeconds: number;
  physicsSteps: number;
  telemetrySamples: number;
  elapsedWallMs: number;
  finite: boolean;
  terminationReason: ExperimentResult["terminationReason"];
  maximumAbsoluteCoordinate: number;
  maximumCovarianceTrace: number;
  maximumQuaternionNormError: number;
  maximumAngularRate: number;
}

export function runNumericalSoak(
  createConfig: () => SimulationConfig,
  durationSeconds = 600,
): SoakResult {
  const config = createConfig();
  config.runtime.maxTime = durationSeconds;
  config.target.initial.position = {
    x: 100_000,
    y: -config.target.initial.depth,
    z: 45_000,
  };
  config.sensor.maxRange = 200_000;
  config.interceptRadius = 0.1;
  const startedAt = performance.now();
  const run = runHeadless(config);
  let finite = true;
  let maximumAbsoluteCoordinate = 0;
  let maximumCovarianceTrace = 0;
  let maximumQuaternionNormError = 0;
  let maximumAngularRate = 0;
  for (const sample of run.telemetry) {
    const values = [
      sample.torpedo.position.x,
      sample.torpedo.position.y,
      sample.torpedo.position.z,
      sample.target.position.x,
      sample.target.position.y,
      sample.target.position.z,
      sample.metrics.range,
      sample.covarianceTrace ?? 0,
      sample.torpedo.orientation.w,
      sample.torpedo.orientation.x,
      sample.torpedo.orientation.y,
      sample.torpedo.orientation.z,
      sample.torpedo.angularVelocity.x,
      sample.torpedo.angularVelocity.y,
      sample.torpedo.angularVelocity.z,
    ];
    finite = finite && values.every(Number.isFinite);
    maximumAbsoluteCoordinate = Math.max(
      maximumAbsoluteCoordinate,
      ...values.slice(0, 6).map(Math.abs),
    );
    maximumCovarianceTrace = Math.max(
      maximumCovarianceTrace,
      sample.covarianceTrace ?? 0,
    );
    maximumQuaternionNormError = Math.max(
      maximumQuaternionNormError,
      Math.abs(quaternionNorm(sample.torpedo.orientation) - 1),
    );
    maximumAngularRate = Math.max(
      maximumAngularRate,
      Math.hypot(
        sample.torpedo.angularVelocity.x,
        sample.torpedo.angularVelocity.y,
        sample.torpedo.angularVelocity.z,
      ),
    );
  }
  return {
    dynamicsModel: config.dynamics.model,
    durationSeconds: run.result.elapsedTime,
    physicsSteps: Math.round(run.result.elapsedTime * config.runtime.physicsHz),
    telemetrySamples: run.telemetry.length,
    elapsedWallMs: performance.now() - startedAt,
    finite,
    terminationReason: run.result.terminationReason,
    maximumAbsoluteCoordinate,
    maximumCovarianceTrace,
    maximumQuaternionNormError,
    maximumAngularRate,
  };
}
