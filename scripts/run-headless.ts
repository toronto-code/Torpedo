import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createDefaultConfig } from "../src/sim/config";
import { telemetryToCsv } from "../src/sim/csv";
import { runHeadless } from "../src/sim/engine";
import type {
  GuidanceLaw,
  ObservationMode,
  ScenarioKind,
  DynamicsModel,
  SimulationConfig,
} from "../src/sim/types";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function configuredRun(
  mode: ObservationMode,
  law: GuidanceLaw,
  scenario: ScenarioKind,
  seed: number,
): SimulationConfig {
  const config = createDefaultConfig();
  config.seed = seed;
  config.guidance.mode = mode;
  config.guidance.law = law;
  config.scenario.kind = scenario;
  return config;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seed = Number(valueAfter(args, "--seed") ?? 20260814);
  const law = (valueAfter(args, "--law") ??
    "proportional-navigation") as GuidanceLaw;
  const scenario = (valueAfter(args, "--scenario") ??
    "constant-turn") as ScenarioKind;
  const requestedMode = (valueAfter(args, "--mode") ??
    "ekf") as ObservationMode;
  const compare = args.includes("--compare");
  const dynamics = (valueAfter(args, "--dynamics") ?? "planar-2.5d") as DynamicsModel;
  const csvPath = valueAfter(args, "--csv");
  const modes: ObservationMode[] = compare
    ? ["perfect", "raw", "ekf"]
    : [requestedMode];

  const runs = modes.map((mode) => {
    const config = configuredRun(mode, law, scenario, seed);
    config.dynamics.model = dynamics;
    return { mode, ...runHeadless(config) };
  });
  console.table(
    runs.map(({ result }) => ({
      mode: result.mode,
      law: result.law,
      dynamics: result.dynamicsModel,
      outcome: result.terminationReason,
      time_s: result.elapsedTime.toFixed(2),
      cpa_m: result.closestApproach.toFixed(2),
      final_error_m: result.finalEstimationError?.toFixed(2) ?? "n/a",
      mean_nis: result.meanNis?.toFixed(2) ?? "n/a",
      mean_nees: result.meanNees?.toFixed(2) ?? "n/a",
      accepted: result.observationsAccepted,
      rejected: result.observationsRejected,
      effort: result.meanControlEffort.toFixed(3),
      saturation: `${(result.saturationFraction * 100).toFixed(1)}%`,
      hash: result.configHash,
    })),
  );

  if (csvPath) {
    for (const run of runs) {
      const target = resolve(
        compare
          ? csvPath.replace(/\.csv$/i, `-${run.mode}.csv`)
          : csvPath,
      );
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, telemetryToCsv(run.telemetry), "utf8");
      console.log(`Telemetry written to ${target}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
