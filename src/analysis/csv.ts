import type { MonteCarloReport } from "./types";

export function recordsToCsv(report: MonteCarloReport): string {
  const header = [
    "pair_index",
    "seed",
    "scenario",
    "law",
    "mode",
    "dynamics_model",
    "category",
    "termination",
    "elapsed_time",
    "closest_approach",
    "final_range",
    "final_estimation_error",
    "mean_nis",
    "mean_nees",
    "accepted",
    "rejected",
    "saturation_fraction",
    "mean_control_effort",
    "mean_actuator_tracking_error",
    "maximum_roll",
    "maximum_pitch",
    "config_hash",
  ];
  const rows = report.records.map((record) => [
    record.pairIndex,
    record.seed,
    record.result.scenario,
    record.result.law,
    record.result.mode,
    record.result.dynamicsModel,
    record.category,
    record.result.terminationReason,
    record.result.elapsedTime,
    record.result.closestApproach,
    record.result.finalRange,
    record.result.finalEstimationError ?? "",
    record.result.meanNis ?? "",
    record.result.meanNees ?? "",
    record.result.observationsAccepted,
    record.result.observationsRejected,
    record.result.saturationFraction,
    record.result.meanControlEffort,
    record.result.meanActuatorTrackingError,
    record.result.maximumRoll,
    record.result.maximumPitch,
    record.result.configHash,
  ]);
  return [header.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

export function summariesToCsv(report: MonteCarloReport): string {
  const header = [
    "group",
    "runs",
    "success_rate",
    "success_ci_lower",
    "success_ci_upper",
    "cpa_mean",
    "cpa_stddev",
    "cpa_p05",
    "cpa_median",
    "cpa_p95",
    "nis_mean",
    "nis_expected",
    "nis_aggregate_consistent",
    "nis_ensemble_coverage",
    "nees_mean",
    "nees_expected",
    "nees_aggregate_consistent",
    "nees_ensemble_coverage",
  ];
  const rows = report.groups.map((group) => [
    group.key,
    group.runs,
    group.successRate,
    group.successRateConfidenceInterval.lower,
    group.successRateConfidenceInterval.upper,
    group.closestApproach.mean,
    group.closestApproach.standardDeviation,
    group.closestApproach.p05,
    group.closestApproach.median,
    group.closestApproach.p95,
    group.consistency.nis.mean ?? "",
    group.consistency.nis.expectedMean,
    group.consistency.nis.withinAggregate95 ?? "",
    group.consistency.nis.ensemble95Coverage ?? "",
    group.consistency.nees.mean ?? "",
    group.consistency.nees.expectedMean,
    group.consistency.nees.withinAggregate95 ?? "",
    group.consistency.nees.ensemble95Coverage ?? "",
  ]);
  return [header.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

export function distributionsToCsv(report: MonteCarloReport): {
  histogram: string;
  cdf: string;
} {
  const histogramRows = report.groups.flatMap((group) =>
    group.closestApproachHistogram.map((bin) => [
      group.key,
      bin.lower,
      bin.upper,
      bin.count,
      bin.probability,
    ]),
  );
  const cdfRows = report.groups.flatMap((group) =>
    group.closestApproachCdf.map((point) => [
      group.key,
      point.value,
      point.probability,
    ]),
  );
  return {
    histogram: [
      "group,lower,upper,count,probability",
      ...histogramRows.map((row) => row.join(",")),
    ].join("\n"),
    cdf: [
      "group,value,probability",
      ...cdfRows.map((row) => row.join(",")),
    ].join("\n"),
  };
}
