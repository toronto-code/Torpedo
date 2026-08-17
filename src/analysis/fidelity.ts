import { hashConfig } from "../sim/config";
import { runHeadless } from "../sim/engine";
import { mean } from "../sim/math";
import type { GuidanceLaw, SimulationConfig } from "../sim/types";
import { summarizeDistribution } from "./statistics";
import type {
  FidelityGroupSummary,
  FidelityPairedEffect,
  FidelityRunRecord,
  FidelityStudyReport,
  FidelityVariant,
  FidelityVariantId,
} from "./types";

export interface FidelityStudyOptions {
  runs: number;
  baseConfig: SimulationConfig;
  onProgress?: (completed: number, total: number) => void;
}

export const FIDELITY_VARIANTS: FidelityVariant[] = [
  {
    id: "planar-baseline",
    label: "2.5D baseline",
    dynamicsModel: "planar-2.5d",
    actuatorLagScale: 1,
    controlAuthorityScale: 1,
  },
  {
    id: "six-dof-nominal",
    label: "6-DOF nominal",
    dynamicsModel: "six-dof",
    actuatorLagScale: 1,
    controlAuthorityScale: 1,
  },
  {
    id: "six-dof-low-lag",
    label: "6-DOF lag ×0.35",
    dynamicsModel: "six-dof",
    actuatorLagScale: 0.35,
    controlAuthorityScale: 1,
  },
  {
    id: "six-dof-high-lag",
    label: "6-DOF lag ×2.0",
    dynamicsModel: "six-dof",
    actuatorLagScale: 2,
    controlAuthorityScale: 1,
  },
  {
    id: "six-dof-low-authority",
    label: "6-DOF authority ×0.65",
    dynamicsModel: "six-dof",
    actuatorLagScale: 1,
    controlAuthorityScale: 0.65,
  },
  {
    id: "six-dof-high-authority",
    label: "6-DOF authority ×1.5",
    dynamicsModel: "six-dof",
    actuatorLagScale: 1,
    controlAuthorityScale: 1.5,
  },
];

const LAWS: GuidanceLaw[] = ["pure-pursuit", "proportional-navigation"];

function groupKey(variant: FidelityVariantId, law: GuidanceLaw): string {
  return `${variant}/${law}`;
}

function finite(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

function summarizeGroup(records: FidelityRunRecord[], variant: FidelityVariant): FidelityGroupSummary {
  const first = records[0];
  const estimationErrors = finite(records.map((record) => record.result.finalEstimationError));
  return {
    key: groupKey(first.variant, first.law),
    variant: first.variant,
    law: first.law,
    dynamicsModel: variant.dynamicsModel,
    runs: records.length,
    interceptRate: records.filter((record) => record.interceptAchieved).length / records.length,
    closestApproach: summarizeDistribution(records.map((record) => record.result.closestApproach)),
    controlEffort: summarizeDistribution(records.map((record) => record.result.meanControlEffort)),
    actuatorTrackingError: summarizeDistribution(
      records.map((record) => record.result.meanActuatorTrackingError),
    ),
    saturationFraction: summarizeDistribution(records.map((record) => record.result.saturationFraction)),
    estimationError: estimationErrors.length > 0 ? summarizeDistribution(estimationErrors) : null,
    maximumRoll: summarizeDistribution(records.map((record) => record.result.maximumRoll)),
    maximumPitch: summarizeDistribution(records.map((record) => record.result.maximumPitch)),
  };
}

function pairedEffect(
  records: FidelityRunRecord[],
  left: FidelityVariantId,
  right: FidelityVariantId,
  law: GuidanceLaw,
): FidelityPairedEffect {
  const cpa: number[] = [];
  const effort: number[] = [];
  const saturation: number[] = [];
  const tracking: number[] = [];
  for (const pairIndex of new Set(records.map((record) => record.pairIndex))) {
    const leftRun = records.find((record) => record.pairIndex === pairIndex && record.variant === left && record.law === law);
    const rightRun = records.find((record) => record.pairIndex === pairIndex && record.variant === right && record.law === law);
    if (!leftRun || !rightRun) continue;
    cpa.push(leftRun.result.closestApproach - rightRun.result.closestApproach);
    effort.push(leftRun.result.meanControlEffort - rightRun.result.meanControlEffort);
    saturation.push(leftRun.result.saturationFraction - rightRun.result.saturationFraction);
    tracking.push(leftRun.result.meanActuatorTrackingError - rightRun.result.meanActuatorTrackingError);
  }
  return {
    key: `${left}-vs-${right}/${law}`,
    left,
    right,
    law,
    pairs: cpa.length,
    meanClosestApproachDelta: mean(cpa) ?? 0,
    meanControlEffortDelta: mean(effort) ?? 0,
    meanSaturationDelta: mean(saturation) ?? 0,
    meanActuatorTrackingErrorDelta: mean(tracking) ?? 0,
    closestApproachDelta: summarizeDistribution(cpa),
    controlEffortDelta: summarizeDistribution(effort),
    saturationDelta: summarizeDistribution(saturation),
    actuatorTrackingErrorDelta: summarizeDistribution(tracking),
  };
}

function guidanceAdvantage(
  groups: FidelityGroupSummary[],
  variant: FidelityVariantId,
): number {
  const pursuit = groups.find((group) => group.variant === variant && group.law === "pure-pursuit");
  const pn = groups.find((group) => group.variant === variant && group.law === "proportional-navigation");
  if (!pursuit || !pn) return 0;
  return pursuit.closestApproach.mean - pn.closestApproach.mean;
}

function conclusion(
  groups: FidelityGroupSummary[],
  effects: FidelityPairedEffect[],
): FidelityStudyReport["conclusion"] {
  const planarPnAdvantage = guidanceAdvantage(groups, "planar-baseline");
  const sixDofPnAdvantage = guidanceAdvantage(groups, "six-dof-nominal");
  const advantagePersists = planarPnAdvantage >= 0 && sixDofPnAdvantage >= 0;
  const pnEffects = effects.filter((effect) => effect.law === "proportional-navigation");
  const lag = pnEffects.find((effect) => effect.left === "six-dof-high-lag");
  const authority = pnEffects.find((effect) => effect.left === "six-dof-low-authority");
  const couplingPenalty = effects.find(
    (effect) => effect.left === "six-dof-nominal"
      && effect.right === "planar-baseline"
      && effect.law === "proportional-navigation",
  )?.meanClosestApproachDelta ?? 0;
  const lagPenalty = lag?.meanClosestApproachDelta ?? 0;
  const authorityPenalty = authority?.meanClosestApproachDelta ?? 0;
  let likelyLimitingFactor: FidelityStudyReport["conclusion"]["likelyLimitingFactor"] = "none";
  const largest = Math.max(lagPenalty, authorityPenalty, couplingPenalty);
  if (largest > 0.1) {
    if (largest === lagPenalty) likelyLimitingFactor = "actuator-lag";
    else if (largest === authorityPenalty) likelyLimitingFactor = "control-authority";
    else likelyLimitingFactor = "vehicle-coupling";
  }
  return {
    planarPnAdvantage,
    sixDofPnAdvantage,
    advantagePersists,
    likelyLimitingFactor,
    statement: advantagePersists
      ? `PN retained a mean closest-approach advantage in both models; the largest measured 6-DOF penalty was attributed to ${likelyLimitingFactor}.`
      : `PN did not retain its mean closest-approach advantage after the fidelity change; the largest measured penalty was attributed to ${likelyLimitingFactor}.`,
  };
}

export function runFidelityStudy(options: FidelityStudyOptions): FidelityStudyReport {
  if (!Number.isInteger(options.runs) || options.runs <= 0) {
    throw new Error("Fidelity study run count must be a positive integer.");
  }
  const baseConfig = structuredClone(options.baseConfig);
  const pairedSeeds = Array.from({ length: options.runs }, (_, index) => (baseConfig.seed + index) >>> 0);
  const interceptThreshold = baseConfig.interceptRadius;
  const records: FidelityRunRecord[] = [];
  const total = pairedSeeds.length * FIDELITY_VARIANTS.length * LAWS.length;
  let completed = 0;
  for (const variant of FIDELITY_VARIANTS) {
    for (const law of LAWS) {
      for (let pairIndex = 0; pairIndex < pairedSeeds.length; pairIndex += 1) {
        const config = structuredClone(baseConfig);
        config.seed = pairedSeeds[pairIndex];
        config.guidance.mode = "ekf";
        config.guidance.law = law;
        config.dynamics.model = variant.dynamicsModel;
        config.dynamics.sixDof.actuatorLagScale = variant.actuatorLagScale;
        config.dynamics.sixDof.controlAuthorityScale = variant.controlAuthorityScale;
        config.interceptRadius = 0.25;
        const result = runHeadless(config).result;
        records.push({
          pairIndex,
          seed: config.seed,
          variant: variant.id,
          law,
          interceptAchieved: result.closestApproach <= interceptThreshold,
          result,
        });
        completed += 1;
        options.onProgress?.(completed, total);
      }
    }
  }
  const groups = FIDELITY_VARIANTS.flatMap((variant) =>
    LAWS.map((law) => summarizeGroup(
      records.filter((record) => record.variant === variant.id && record.law === law),
      variant,
    )),
  );
  const pairedEffects: FidelityPairedEffect[] = [];
  for (const law of LAWS) {
    pairedEffects.push(pairedEffect(records, "six-dof-nominal", "planar-baseline", law));
    for (const variant of FIDELITY_VARIANTS.slice(2)) {
      pairedEffects.push(pairedEffect(records, variant.id, "six-dof-nominal", law));
    }
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    configHash: hashConfig(baseConfig),
    baseSeed: baseConfig.seed,
    pairedSeeds,
    interceptThreshold,
    variants: FIDELITY_VARIANTS,
    records,
    groups,
    pairedEffects,
    conclusion: conclusion(groups, pairedEffects),
  };
}
