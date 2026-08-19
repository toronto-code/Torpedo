import { runHeadless } from "../sim/engine";
import { createAmbiguityScenarioConfig, type AmbiguityPreset } from "../sim/scenarios";
import { defaultDoctrine } from "../sim/tewa";
import type { EngagementOutcome, SimulationConfig } from "../sim/types";

/**
 * Paired-seed study of the autonomous engagement chain across ambiguity
 * presets and doctrine variants. Reports outcome mix, time-to-authorize,
 * and designation churn. All synthetic.
 */

export interface EngagementVariantSummary {
  id: string;
  runs: number;
  outcomes: Record<EngagementOutcome, number>;
  meanTimeToAuthorize: number | null;
  meanElapsed: number;
  meanClosestApproach: number;
}

export interface EngagementStudyReport {
  baseSeed: number;
  runsPerVariant: number;
  variants: EngagementVariantSummary[];
}

export interface EngagementStudyOptions {
  runs: number;
  baseSeed: number;
  presets?: AmbiguityPreset[];
  createConfig?: (preset: AmbiguityPreset, seed: number) => SimulationConfig;
  onProgress?: (completed: number, total: number) => void;
}

export function runEngagementStudy(
  options: EngagementStudyOptions,
): EngagementStudyReport {
  const presets = options.presets ?? [
    "crossing-subs",
    "cluttered-approach",
    "decoy-stress",
    "ambiguous-fluctuator",
    "high-ambiguity",
  ];
  const createConfig =
    options.createConfig ??
    ((preset: AmbiguityPreset, seed: number) =>
      createAmbiguityScenarioConfig(preset, seed));
  const total = presets.length * options.runs;
  let completed = 0;
  const variants: EngagementVariantSummary[] = [];

  for (const preset of presets) {
    const outcomes: Record<EngagementOutcome, number> = {
      "correct-hostile": 0,
      "decoy-seduction": 0,
      "wrong-contact": 0,
      miss: 0,
    };
    let authorizeSum = 0;
    let authorizeCount = 0;
    let elapsedSum = 0;
    let closestSum = 0;
    for (let run = 0; run < options.runs; run += 1) {
      const config = createConfig(preset, options.baseSeed + run);
      config.doctrine = config.doctrine ?? defaultDoctrine();
      const result = runHeadless(config).result;
      if (result.engagementOutcome) outcomes[result.engagementOutcome] += 1;
      const authorizedAt = result.tewaEvents?.find(
        (event) => event.stage === "authorize" || event.stage === "manual-override",
      );
      if (authorizedAt) {
        authorizeSum += authorizedAt.at;
        authorizeCount += 1;
      }
      elapsedSum += result.elapsedTime;
      closestSum += result.closestApproach;
      completed += 1;
      options.onProgress?.(completed, total);
    }
    variants.push({
      id: preset,
      runs: options.runs,
      outcomes,
      meanTimeToAuthorize: authorizeCount > 0 ? authorizeSum / authorizeCount : null,
      meanElapsed: elapsedSum / options.runs,
      meanClosestApproach: closestSum / options.runs,
    });
  }
  return { baseSeed: options.baseSeed, runsPerVariant: options.runs, variants };
}
