import { hashConfig } from "../sim/config";
import { runHeadless } from "../sim/engine";
import type { SimulationConfig, WeaponSystemConfig } from "../sim/types";

/**
 * Paired Monte Carlo weaponeering study over weapon-design parameters.
 *
 * Each variant mutates a clone of the configured weapon block; every variant
 * runs the same paired seeds so differences are attributable to the variant,
 * not the seed. The effectiveness metric is the synthetic scoring function
 * documented in src/sim/fuze.ts — fictional constants, benchmarking only.
 */

export interface WeaponeeringVariantSpec {
  id: string;
  label: string;
  description: string;
  apply: (weapon: WeaponSystemConfig) => void;
}

export interface WeaponeeringVariantSummary {
  id: string;
  label: string;
  description: string;
  runs: number;
  detonationRate: number;
  interceptRate: number;
  exhaustionRate: number;
  meanClosestApproach: number;
  meanFuzeMiss: number | null;
  meanEffectiveness: number | null;
  meanElapsed: number;
}

export interface WeaponeeringPairedDelta {
  id: string;
  label: string;
  detonationRateDelta: number;
  meanEffectivenessDelta: number | null;
  meanClosestApproachDelta: number;
}

export interface WeaponeeringReport {
  baseSeed: number;
  configHash: string;
  runsPerVariant: number;
  variants: WeaponeeringVariantSummary[];
  pairedDeltas: WeaponeeringPairedDelta[];
}

export interface WeaponeeringOptions {
  runs: number;
  baseSeed: number;
  createConfig: () => SimulationConfig;
  variants?: WeaponeeringVariantSpec[];
  onProgress?: (completed: number, total: number) => void;
}

/** Default sweep derived from the configured weapon block. */
export function defaultVariants(base: WeaponSystemConfig): WeaponeeringVariantSpec[] {
  const endurance = base.endurance?.runTime ?? 90;
  const enableTime = base.phases?.enableTime ?? 4;
  const cruise = base.speed?.cruiseSpeed ?? 30;
  const terminalRange = base.phases?.terminalRange ?? 400;
  return [
    {
      id: "baseline",
      label: "Baseline preset",
      description: "Configured weapon block unchanged",
      apply: () => {},
    },
    {
      id: "endurance-long",
      label: "+50% endurance",
      description: `Endurance ${endurance} s to ${(endurance * 1.5).toFixed(0)} s`,
      apply: (weapon) => {
        weapon.endurance = { runTime: endurance * 1.5 };
      },
    },
    {
      id: "enable-early",
      label: "Early enable",
      description: `Enable at ${(enableTime * 0.5).toFixed(1)} s instead of ${enableTime} s`,
      apply: (weapon) => {
        weapon.phases = { ...weapon.phases, enableTime: enableTime * 0.5 };
      },
    },
    {
      id: "enable-late",
      label: "Late enable",
      description: `Enable at ${(enableTime * 2).toFixed(1)} s instead of ${enableTime} s`,
      apply: (weapon) => {
        weapon.phases = { ...weapon.phases, enableTime: enableTime * 2 };
      },
    },
    {
      id: "cruise-high",
      label: "+25% cruise speed",
      description: `Cruise ${cruise} m/s to ${(cruise * 1.25).toFixed(1)} m/s`,
      apply: (weapon) => {
        weapon.speed = { ...weapon.speed, cruiseSpeed: cruise * 1.25 };
      },
    },
    {
      id: "terminal-wide",
      label: "Wide terminal gate",
      description: `Terminal gate ${terminalRange} m to ${(terminalRange * 2).toFixed(0)} m`,
      apply: (weapon) => {
        weapon.phases = { ...weapon.phases, terminalRange: terminalRange * 2 };
      },
    },
  ];
}

export function runWeaponeeringStudy(options: WeaponeeringOptions): WeaponeeringReport {
  const baseConfig = options.createConfig();
  if (!baseConfig.weapon) {
    throw new Error("Weaponeering requires a weapon block in the configuration.");
  }
  const variants = options.variants ?? defaultVariants(baseConfig.weapon);
  const total = variants.length * options.runs;
  let completed = 0;

  const summaries: WeaponeeringVariantSummary[] = [];
  for (const variant of variants) {
    let detonations = 0;
    let intercepts = 0;
    let exhaustions = 0;
    let closestApproachSum = 0;
    let fuzeMissSum = 0;
    let fuzeCount = 0;
    let effectivenessSum = 0;
    let effectivenessCount = 0;
    let elapsedSum = 0;
    for (let run = 0; run < options.runs; run += 1) {
      const config = options.createConfig();
      config.seed = options.baseSeed + run;
      const weapon = structuredClone(config.weapon);
      if (!weapon) continue;
      variant.apply(weapon);
      config.weapon = weapon;
      const result = runHeadless(config).result;
      if (result.terminationReason === "fuzed-detonation") {
        detonations += 1;
        if (result.fuzeMissDistance !== undefined) {
          fuzeMissSum += result.fuzeMissDistance;
          fuzeCount += 1;
        }
        if (result.effectivenessScore !== undefined) {
          effectivenessSum += result.effectivenessScore;
          effectivenessCount += 1;
        }
      } else if (result.terminationReason === "intercept") {
        intercepts += 1;
      } else if (result.terminationReason === "endurance-exhausted") {
        exhaustions += 1;
      }
      closestApproachSum += result.closestApproach;
      elapsedSum += result.elapsedTime;
      completed += 1;
      options.onProgress?.(completed, total);
    }
    summaries.push({
      id: variant.id,
      label: variant.label,
      description: variant.description,
      runs: options.runs,
      detonationRate: detonations / options.runs,
      interceptRate: intercepts / options.runs,
      exhaustionRate: exhaustions / options.runs,
      meanClosestApproach: closestApproachSum / options.runs,
      meanFuzeMiss: fuzeCount > 0 ? fuzeMissSum / fuzeCount : null,
      meanEffectiveness: effectivenessCount > 0
        ? effectivenessSum / effectivenessCount
        : null,
      meanElapsed: elapsedSum / options.runs,
    });
  }

  const baseline = summaries[0];
  const pairedDeltas: WeaponeeringPairedDelta[] = summaries.slice(1).map((summary) => ({
    id: summary.id,
    label: summary.label,
    detonationRateDelta: summary.detonationRate - baseline.detonationRate,
    meanEffectivenessDelta: summary.meanEffectiveness !== null && baseline.meanEffectiveness !== null
      ? summary.meanEffectiveness - baseline.meanEffectiveness
      : null,
    meanClosestApproachDelta: summary.meanClosestApproach - baseline.meanClosestApproach,
  }));

  return {
    baseSeed: options.baseSeed,
    configHash: hashConfig(baseConfig),
    runsPerVariant: options.runs,
    variants: summaries,
    pairedDeltas,
  };
}
