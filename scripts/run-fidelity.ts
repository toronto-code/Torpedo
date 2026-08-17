import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runFidelityStudy } from "../src/analysis/fidelity";
import { createDefaultConfig } from "../src/sim/config";
import type { ScenarioKind } from "../src/sim/types";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(valueAfter(args, "--runs") ?? 12);
  const seed = Number(valueAfter(args, "--seed") ?? 20260814);
  const scenario = (valueAfter(args, "--scenario") ?? "scripted-evasive") as ScenarioKind;
  const outputDirectory = resolve(valueAfter(args, "--out") ?? "outputs/fidelity-study");
  const config = createDefaultConfig();
  config.seed = seed;
  config.scenario.kind = scenario;
  let lastPercent = -1;
  const report = runFidelityStudy({
    runs,
    baseConfig: config,
    onProgress(completed, total) {
      const percent = Math.floor((completed / total) * 10) * 10;
      if (percent !== lastPercent) {
        process.stdout.write(`Fidelity study progress: ${percent}%\n`);
        lastPercent = percent;
      }
    },
  });
  await mkdir(outputDirectory, { recursive: true });
  const runRows = report.records.map((record) => [
    record.pairIndex,
    record.seed,
    record.variant,
    record.law,
    record.interceptAchieved,
    record.result.closestApproach,
    record.result.meanControlEffort,
    record.result.saturationFraction,
    record.result.meanActuatorTrackingError,
    record.result.maximumRoll,
    record.result.maximumPitch,
    record.result.finalEstimationError ?? "",
    record.result.configHash,
  ]);
  const effectRows = report.pairedEffects.map((effect) => [
    effect.key,
    effect.pairs,
    effect.meanClosestApproachDelta,
    effect.meanControlEffortDelta,
    effect.meanSaturationDelta,
    effect.meanActuatorTrackingErrorDelta,
  ]);
  await Promise.all([
    writeFile(resolve(outputDirectory, "report.json"), JSON.stringify(report, null, 2), "utf8"),
    writeFile(resolve(outputDirectory, "runs.csv"), [
      "pair_index,seed,variant,law,intercept,cpa_m,control_effort,saturation,tracking_error,max_roll_rad,max_pitch_rad,estimation_error_m,config_hash",
      ...runRows.map((row) => row.join(",")),
    ].join("\n"), "utf8"),
    writeFile(resolve(outputDirectory, "effects.csv"), [
      "comparison,pairs,cpa_delta_m,control_effort_delta,saturation_delta,tracking_error_delta",
      ...effectRows.map((row) => row.join(",")),
    ].join("\n"), "utf8"),
  ]);
  console.table(report.groups.map((group) => ({
    group: group.key,
    intercept: `${(group.interceptRate * 100).toFixed(1)}%`,
    cpa_mean_m: group.closestApproach.mean.toFixed(2),
    effort: group.controlEffort.mean.toFixed(3),
    saturation: `${(group.saturationFraction.mean * 100).toFixed(1)}%`,
    pitch_max_deg: (group.maximumPitch.maximum * 180 / Math.PI).toFixed(1),
  })));
  console.log(report.conclusion.statement);
  console.log(`Report written to ${outputDirectory}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
