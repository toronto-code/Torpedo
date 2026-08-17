import { createDefaultConfig } from "../sim/config";
import { runHeadless } from "../sim/engine";
import { mean } from "../sim/math";
import type {
  ConsistencySample,
  GuidanceLaw,
  ObservationMode,
  ScenarioKind,
  SimulationConfig,
} from "../sim/types";
import {
  buildEnsembleConsistencyReport,
  empiricalCdf,
  histogram,
  quantile,
  summarizeDistribution,
  wilsonInterval,
} from "./statistics";
import type {
  FailureCategory,
  MonteCarloGroupSummary,
  MonteCarloReport,
  MonteCarloRunRecord,
  PairedComparison,
} from "./types";

export interface MonteCarloOptions {
  runs: number;
  baseSeed: number;
  modes: ObservationMode[];
  laws: GuidanceLaw[];
  scenarios: ScenarioKind[];
  histogramBins?: number;
  createConfig?: () => SimulationConfig;
  onProgress?: (completed: number, total: number) => void;
}

const ALL_FAILURES: FailureCategory[] = [
  "success",
  "guidance-miss",
  "insufficient-track",
  "track-loss",
  "numerical-instability",
  "time-limit",
];

export function classifyFailure(
  result: MonteCarloRunRecord["result"],
): FailureCategory {
  if (result.terminationReason === "intercept") return "success";
  if (result.terminationReason === "invalid-state") {
    return "numerical-instability";
  }
  if (result.observationsAccepted < 3) return "insufficient-track";
  if (
    result.finalEstimationError !== null &&
    result.finalEstimationError > Math.max(250, result.closestApproach * 4)
  ) {
    return "track-loss";
  }
  if (result.closestApproach < 250) return "guidance-miss";
  return "time-limit";
}

function groupKey(record: MonteCarloRunRecord): string {
  return [
    record.result.scenario,
    record.result.dynamicsModel,
    record.result.law,
    record.result.mode,
  ].join("/");
}

function summarizeGroup(
  records: MonteCarloRunRecord[],
  consistency: Map<
    string,
    { nis: ConsistencySample[][]; nees: ConsistencySample[][] }
  >,
  bins: number,
): MonteCarloGroupSummary {
  const first = records[0].result;
  const successes = records.filter((record) => record.category === "success").length;
  const failureCounts = Object.fromEntries(
    ALL_FAILURES.map((category) => [
      category,
      records.filter((record) => record.category === category).length,
    ]),
  ) as Record<FailureCategory, number>;
  const closestApproaches = records.map(
    (record) => record.result.closestApproach,
  );
  const estimationErrors = records
    .map((record) => record.result.finalEstimationError)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const samples = consistency.get(groupKey(records[0])) ?? {
    nis: [],
    nees: [],
  };
  return {
    key: groupKey(records[0]),
    scenario: first.scenario,
    law: first.law,
    mode: first.mode,
    dynamicsModel: first.dynamicsModel,
    runs: records.length,
    successRate: successes / records.length,
    successRateConfidenceInterval: wilsonInterval(successes, records.length),
    failureCounts,
    closestApproach: summarizeDistribution(closestApproaches),
    elapsedTime: summarizeDistribution(
      records.map((record) => record.result.elapsedTime),
    ),
    estimationError:
      estimationErrors.length > 0
        ? summarizeDistribution(estimationErrors)
        : null,
    consistency: buildEnsembleConsistencyReport(samples.nis, samples.nees),
    closestApproachHistogram: histogram(closestApproaches, bins),
    closestApproachCdf: empiricalCdf(closestApproaches),
  };
}

function comparePairs(
  records: MonteCarloRunRecord[],
  scenario: ScenarioKind,
  dimension: PairedComparison["dimension"],
  left: string,
  right: string,
  fixed: string,
): PairedComparison | null {
  const selected = records.filter((record) => {
    if (record.result.scenario !== scenario) return false;
    if (dimension === "estimator") return record.result.law === fixed;
    return record.result.mode === fixed;
  });
  const deltas: number[] = [];
  let leftWins = 0;
  for (const pairIndex of new Set(selected.map((record) => record.pairIndex))) {
    const pair = selected.filter((record) => record.pairIndex === pairIndex);
    const leftRecord = pair.find((record) =>
      dimension === "estimator"
        ? record.result.mode === left
        : record.result.law === left,
    );
    const rightRecord = pair.find((record) =>
      dimension === "estimator"
        ? record.result.mode === right
        : record.result.law === right,
    );
    if (!leftRecord || !rightRecord) continue;
    const delta =
      leftRecord.result.closestApproach - rightRecord.result.closestApproach;
    deltas.push(delta);
    if (delta < 0) leftWins += 1;
  }
  if (deltas.length === 0) return null;
  return {
    key: `${scenario}/${dimension}/${fixed}/${left}-vs-${right}`,
    scenario,
    dimension,
    left,
    right,
    pairs: deltas.length,
    leftWinRate: leftWins / deltas.length,
    meanClosestApproachDelta: mean(deltas)!,
    medianClosestApproachDelta: quantile(deltas, 0.5),
  };
}

export function runMonteCarlo(options: MonteCarloOptions): MonteCarloReport {
  if (!Number.isInteger(options.runs) || options.runs <= 0) {
    throw new Error("Monte Carlo run count must be a positive integer.");
  }
  if (
    options.modes.length === 0 ||
    options.laws.length === 0 ||
    options.scenarios.length === 0
  ) {
    throw new Error("At least one mode, law, and scenario are required.");
  }

  const total =
    options.runs *
    options.modes.length *
    options.laws.length *
    options.scenarios.length;
  let completed = 0;
  const records: MonteCarloRunRecord[] = [];
  const consistency = new Map<
    string,
    { nis: ConsistencySample[][]; nees: ConsistencySample[][] }
  >();
  const pairedSeeds = Array.from(
    { length: options.runs },
    (_, index) => (options.baseSeed + index) >>> 0,
  );

  for (const scenario of options.scenarios) {
    for (const law of options.laws) {
      for (const mode of options.modes) {
        for (let pairIndex = 0; pairIndex < pairedSeeds.length; pairIndex += 1) {
          const config = (options.createConfig ?? createDefaultConfig)();
          config.seed = pairedSeeds[pairIndex];
          config.scenario.kind = scenario;
          config.guidance.law = law;
          config.guidance.mode = mode;
          const run = runHeadless(config);
          const record: MonteCarloRunRecord = {
            pairIndex,
            seed: config.seed,
            category: classifyFailure(run.result),
            result: run.result,
          };
          records.push(record);
          const key = groupKey(record);
          const samples = consistency.get(key) ?? { nis: [], nees: [] };
          samples.nis.push(run.consistency.nis);
          samples.nees.push(run.consistency.nees);
          consistency.set(key, samples);
          completed += 1;
          options.onProgress?.(completed, total);
        }
      }
    }
  }

  const grouped = new Map<string, MonteCarloRunRecord[]>();
  for (const record of records) {
    const key = groupKey(record);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  const groups = [...grouped.values()].map((group) =>
    summarizeGroup(group, consistency, options.histogramBins ?? 12),
  );
  const comparisons: PairedComparison[] = [];
  for (const scenario of options.scenarios) {
    for (const law of options.laws) {
      const comparison = comparePairs(
        records,
        scenario,
        "estimator",
        "ekf",
        "raw",
        law,
      );
      if (comparison) comparisons.push(comparison);
    }
    for (const mode of options.modes) {
      const comparison = comparePairs(
        records,
        scenario,
        "guidance",
        "proportional-navigation",
        "pure-pursuit",
        mode,
      );
      if (comparison) comparisons.push(comparison);
    }
  }

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    baseSeed: options.baseSeed,
    pairedSeeds,
    records,
    groups,
    comparisons,
  };
}
