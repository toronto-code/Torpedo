import { mean } from "../sim/math";
import type { ConsistencySample } from "../sim/types";
import type {
  ConfidenceInterval,
  ConsistencyMetric,
  ConsistencyReport,
  DistributionSummary,
  EmpiricalCdfPoint,
  HistogramBin,
} from "./types";

const Z_95 = 1.959963984540054;

export function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values)!;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

export function meanConfidenceInterval(
  values: readonly number[],
): ConfidenceInterval {
  const average = mean(values) ?? Number.NaN;
  const margin =
    values.length > 0
      ? (Z_95 * sampleStandardDeviation(values)) / Math.sqrt(values.length)
      : Number.NaN;
  return {
    confidence: 0.95,
    lower: average - margin,
    upper: average + margin,
  };
}

export function wilsonInterval(
  successes: number,
  total: number,
): ConfidenceInterval {
  if (total === 0) {
    return { confidence: 0.95, lower: Number.NaN, upper: Number.NaN };
  }
  const proportion = successes / total;
  const z2 = Z_95 ** 2;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const margin =
    (Z_95 / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / total + z2 / (4 * total ** 2),
    );
  return {
    confidence: 0.95,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

export function summarizeDistribution(
  values: readonly number[],
): DistributionSummary {
  if (values.length === 0) {
    throw new Error("Cannot summarize an empty distribution.");
  }
  return {
    count: values.length,
    mean: mean(values)!,
    standardDeviation: sampleStandardDeviation(values),
    minimum: Math.min(...values),
    p05: quantile(values, 0.05),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    maximum: Math.max(...values),
    meanConfidenceInterval: meanConfidenceInterval(values),
  };
}

export function histogram(
  values: readonly number[],
  requestedBins = 12,
): HistogramBin[] {
  if (values.length === 0) return [];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum === maximum) {
    return [{
      lower: minimum,
      upper: maximum,
      count: values.length,
      probability: 1,
    }];
  }
  const binCount = Math.max(1, Math.floor(requestedBins));
  const width = (maximum - minimum) / binCount;
  const counts = Array(binCount).fill(0) as number[];
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - minimum) / width));
    counts[index] += 1;
  }
  return counts.map((count, index) => ({
    lower: minimum + index * width,
    upper: index === binCount - 1 ? maximum : minimum + (index + 1) * width,
    count,
    probability: count / values.length,
  }));
}

export function empiricalCdf(
  values: readonly number[],
): EmpiricalCdfPoint[] {
  return [...values]
    .sort((a, b) => a - b)
    .map((value, index, sorted) => ({
      value,
      probability: (index + 1) / sorted.length,
    }));
}

function chiSquareMeanInterval(
  degreesOfFreedom: number,
  count: number,
): ConfidenceInterval | null {
  if (count === 0) return null;
  const aggregateDegrees = degreesOfFreedom * count;
  const quantileApproximation = (z: number) =>
    aggregateDegrees *
    (1 - 2 / (9 * aggregateDegrees) + z * Math.sqrt(2 / (9 * aggregateDegrees))) ** 3 /
    count;
  return {
    confidence: 0.95,
    lower: quantileApproximation(-Z_95),
    upper: quantileApproximation(Z_95),
  };
}

const INDIVIDUAL_95: Record<number, [number, number]> = {
  2: [0.0506356, 7.3777589],
  4: [0.4844186, 11.1432868],
};

function consistencyMetric(
  name: "NIS" | "NEES",
  degreesOfFreedom: number,
  samples: readonly number[],
): ConsistencyMetric {
  const average = mean(samples);
  const aggregate95 = chiSquareMeanInterval(degreesOfFreedom, samples.length);
  const individualBounds = INDIVIDUAL_95[degreesOfFreedom];
  const coverage =
    samples.length === 0
      ? null
      : samples.filter(
          (value) =>
            value >= individualBounds[0] && value <= individualBounds[1],
        ).length / samples.length;
  return {
    name,
    degreesOfFreedom,
    sampleCount: samples.length,
    mean: average,
    expectedMean: degreesOfFreedom,
    aggregate95,
    withinAggregate95:
      average === null || aggregate95 === null
        ? null
        : average >= aggregate95.lower && average <= aggregate95.upper,
    individual95Coverage: coverage,
  };
}

export function buildConsistencyReport(
  nis: readonly number[],
  nees: readonly number[],
): ConsistencyReport {
  return {
    nis: consistencyMetric("NIS", 2, nis),
    nees: consistencyMetric("NEES", 4, nees),
  };
}

function ensembleConsistencyMetric(
  name: "NIS" | "NEES",
  degreesOfFreedom: number,
  runs: readonly (readonly ConsistencySample[])[],
): ConsistencyMetric {
  const finiteRuns = runs.filter((run) => run.length > 0);
  const flattened = finiteRuns
    .flat()
    .map((sample) => sample.value)
    .filter(Number.isFinite);
  const samplesByTimestamp = new Map<string, number[]>();
  for (const run of finiteRuns) {
    for (const sample of run) {
      if (!Number.isFinite(sample.timestamp) || !Number.isFinite(sample.value)) {
        continue;
      }
      const timestamp = sample.timestamp.toFixed(6);
      samplesByTimestamp.set(timestamp, [
        ...(samplesByTimestamp.get(timestamp) ?? []),
        sample.value,
      ]);
    }
  }
  const ensembleChecks: boolean[] = [];
  for (const samples of samplesByTimestamp.values()) {
    if (samples.length < 2) continue;
    const interval = chiSquareMeanInterval(degreesOfFreedom, samples.length)!;
    const average = mean(samples)!;
    ensembleChecks.push(
      average >= interval.lower && average <= interval.upper,
    );
  }
  const ensembleCoverage =
    ensembleChecks.length === 0
      ? null
      : ensembleChecks.filter(Boolean).length / ensembleChecks.length;
  const independentRuns = finiteRuns.length;
  const aggregate95 = chiSquareMeanInterval(
    degreesOfFreedom,
    independentRuns,
  );
  const individualBounds = INDIVIDUAL_95[degreesOfFreedom];
  const individualCoverage =
    flattened.length === 0
      ? null
      : flattened.filter(
          (value) =>
            value >= individualBounds[0] && value <= individualBounds[1],
        ).length / flattened.length;
  return {
    name,
    degreesOfFreedom,
    sampleCount: flattened.length,
    mean: mean(flattened),
    expectedMean: degreesOfFreedom,
    aggregate95,
    withinAggregate95:
      ensembleCoverage === null ? null : ensembleCoverage >= 0.9,
    individual95Coverage: individualCoverage,
    ensemble95Coverage: ensembleCoverage,
  };
}

export function buildEnsembleConsistencyReport(
  nisRuns: readonly (readonly ConsistencySample[])[],
  neesRuns: readonly (readonly ConsistencySample[])[],
): ConsistencyReport {
  return {
    nis: ensembleConsistencyMetric("NIS", 2, nisRuns),
    nees: ensembleConsistencyMetric("NEES", 4, neesRuns),
  };
}
