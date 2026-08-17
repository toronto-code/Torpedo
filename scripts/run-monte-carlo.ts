import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  distributionsToCsv,
  recordsToCsv,
  summariesToCsv,
} from "../src/analysis/csv";
import { runMonteCarlo } from "../src/analysis/monte-carlo";
import type {
  GuidanceLaw,
  ObservationMode,
  ScenarioKind,
} from "../src/sim/types";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function commaList<T extends string>(value: string): T[] {
  return value.split(",").map((entry) => entry.trim() as T);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runs = Number(valueAfter(args, "--runs") ?? 20);
  const baseSeed = Number(valueAfter(args, "--seed") ?? 20260814);
  const modes = commaList<ObservationMode>(
    valueAfter(args, "--modes") ?? "perfect,raw,ekf",
  );
  const laws = commaList<GuidanceLaw>(
    valueAfter(args, "--laws") ??
      "pure-pursuit,proportional-navigation",
  );
  const scenarios = commaList<ScenarioKind>(
    valueAfter(args, "--scenarios") ?? "constant-turn,scripted-evasive",
  );
  const outputDirectory = resolve(
    valueAfter(args, "--out") ?? "outputs/monte-carlo",
  );
  let lastPercentage = -1;
  const report = runMonteCarlo({
    runs,
    baseSeed,
    modes,
    laws,
    scenarios,
    onProgress(completed, total) {
      const percentage = Math.floor((completed / total) * 10) * 10;
      if (percentage !== lastPercentage) {
        process.stdout.write(`Monte Carlo progress: ${percentage}%\n`);
        lastPercentage = percentage;
      }
    },
  });
  await mkdir(outputDirectory, { recursive: true });
  const distributions = distributionsToCsv(report);
  await Promise.all([
    writeFile(
      resolve(outputDirectory, "report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    ),
    writeFile(
      resolve(outputDirectory, "runs.csv"),
      recordsToCsv(report),
      "utf8",
    ),
    writeFile(
      resolve(outputDirectory, "summary.csv"),
      summariesToCsv(report),
      "utf8",
    ),
    writeFile(
      resolve(outputDirectory, "histogram.csv"),
      distributions.histogram,
      "utf8",
    ),
    writeFile(
      resolve(outputDirectory, "cdf.csv"),
      distributions.cdf,
      "utf8",
    ),
  ]);

  console.table(
    report.groups.map((group) => ({
      group: group.key,
      runs: group.runs,
      success: `${(group.successRate * 100).toFixed(1)}%`,
      cpa_mean_m: group.closestApproach.mean.toFixed(2),
      cpa_p95_m: group.closestApproach.p95.toFixed(2),
      NIS: group.consistency.nis.mean?.toFixed(2) ?? "n/a",
      NIS_consistent: group.consistency.nis.withinAggregate95 ?? "n/a",
      NIS_coverage:
        group.consistency.nis.ensemble95Coverage?.toFixed(2) ?? "n/a",
      NEES: group.consistency.nees.mean?.toFixed(2) ?? "n/a",
      NEES_consistent: group.consistency.nees.withinAggregate95 ?? "n/a",
      NEES_coverage:
        group.consistency.nees.ensemble95Coverage?.toFixed(2) ?? "n/a",
    })),
  );
  console.table(
    report.comparisons.map((comparison) => ({
      comparison: comparison.key,
      pairs: comparison.pairs,
      left_win_rate: `${(comparison.leftWinRate * 100).toFixed(1)}%`,
      mean_cpa_delta_m: comparison.meanClosestApproachDelta.toFixed(2),
    })),
  );
  console.log(`Report written to ${outputDirectory}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
