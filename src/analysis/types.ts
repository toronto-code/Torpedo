import type {
  DynamicsModel,
  ExperimentResult,
  GuidanceLaw,
  ObservationMode,
  ScenarioKind,
} from "../sim/types";

export type FailureCategory =
  | "success"
  | "guidance-miss"
  | "insufficient-track"
  | "track-loss"
  | "numerical-instability"
  | "time-limit";

export interface ConfidenceInterval {
  confidence: 0.95;
  lower: number;
  upper: number;
}

export interface DistributionSummary {
  count: number;
  mean: number;
  standardDeviation: number;
  minimum: number;
  p05: number;
  median: number;
  p95: number;
  maximum: number;
  meanConfidenceInterval: ConfidenceInterval;
}

export interface ConsistencyMetric {
  name: "NIS" | "NEES";
  degreesOfFreedom: number;
  sampleCount: number;
  mean: number | null;
  expectedMean: number;
  aggregate95: ConfidenceInterval | null;
  withinAggregate95: boolean | null;
  individual95Coverage: number | null;
  ensemble95Coverage?: number | null;
}

export interface ConsistencyReport {
  nis: ConsistencyMetric;
  nees: ConsistencyMetric;
}

export interface HistogramBin {
  lower: number;
  upper: number;
  count: number;
  probability: number;
}

export interface EmpiricalCdfPoint {
  value: number;
  probability: number;
}

export interface MonteCarloRunRecord {
  pairIndex: number;
  seed: number;
  category: FailureCategory;
  result: ExperimentResult;
}

export interface MonteCarloGroupSummary {
  key: string;
  scenario: ScenarioKind;
  law: GuidanceLaw;
  mode: ObservationMode;
  dynamicsModel: DynamicsModel;
  runs: number;
  successRate: number;
  successRateConfidenceInterval: ConfidenceInterval;
  failureCounts: Record<FailureCategory, number>;
  closestApproach: DistributionSummary;
  elapsedTime: DistributionSummary;
  estimationError: DistributionSummary | null;
  consistency: ConsistencyReport;
  closestApproachHistogram: HistogramBin[];
  closestApproachCdf: EmpiricalCdfPoint[];
}

export interface PairedComparison {
  key: string;
  scenario: ScenarioKind;
  dimension: "estimator" | "guidance";
  left: string;
  right: string;
  pairs: number;
  leftWinRate: number;
  meanClosestApproachDelta: number;
  medianClosestApproachDelta: number;
}

export interface MonteCarloReport {
  version: 2;
  generatedAt: string;
  baseSeed: number;
  pairedSeeds: number[];
  records: MonteCarloRunRecord[];
  groups: MonteCarloGroupSummary[];
  comparisons: PairedComparison[];
}

export type FidelityVariantId =
  | "planar-baseline"
  | "six-dof-nominal"
  | "six-dof-low-lag"
  | "six-dof-high-lag"
  | "six-dof-low-authority"
  | "six-dof-high-authority";

export interface FidelityVariant {
  id: FidelityVariantId;
  label: string;
  dynamicsModel: DynamicsModel;
  actuatorLagScale: number;
  controlAuthorityScale: number;
}

export interface FidelityRunRecord {
  pairIndex: number;
  seed: number;
  variant: FidelityVariantId;
  law: GuidanceLaw;
  interceptAchieved: boolean;
  result: ExperimentResult;
}

export interface FidelityGroupSummary {
  key: string;
  variant: FidelityVariantId;
  law: GuidanceLaw;
  dynamicsModel: DynamicsModel;
  runs: number;
  interceptRate: number;
  closestApproach: DistributionSummary;
  controlEffort: DistributionSummary;
  actuatorTrackingError: DistributionSummary;
  saturationFraction: DistributionSummary;
  estimationError: DistributionSummary | null;
  maximumRoll: DistributionSummary;
  maximumPitch: DistributionSummary;
}

export interface FidelityPairedEffect {
  key: string;
  left: FidelityVariantId;
  right: FidelityVariantId;
  law: GuidanceLaw;
  pairs: number;
  meanClosestApproachDelta: number;
  meanControlEffortDelta: number;
  meanSaturationDelta: number;
  meanActuatorTrackingErrorDelta: number;
  closestApproachDelta: DistributionSummary;
  controlEffortDelta: DistributionSummary;
  saturationDelta: DistributionSummary;
  actuatorTrackingErrorDelta: DistributionSummary;
}

export interface GuidanceFidelityConclusion {
  planarPnAdvantage: number;
  sixDofPnAdvantage: number;
  advantagePersists: boolean;
  likelyLimitingFactor: "actuator-lag" | "control-authority" | "vehicle-coupling" | "none";
  statement: string;
}

export interface FidelityStudyReport {
  version: 1;
  generatedAt: string;
  configHash: string;
  baseSeed: number;
  pairedSeeds: number[];
  interceptThreshold: number;
  variants: FidelityVariant[];
  records: FidelityRunRecord[];
  groups: FidelityGroupSummary[];
  pairedEffects: FidelityPairedEffect[];
  conclusion: GuidanceFidelityConclusion;
}
