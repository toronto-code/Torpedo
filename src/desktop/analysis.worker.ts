/// <reference lib="webworker" />

import { runMonteCarlo } from "../analysis/monte-carlo";
import { runWeaponeeringStudy } from "../analysis/weaponeering";
import type { GuidanceLaw, ObservationMode, ScenarioKind, SimulationConfig } from "../sim/types";

interface Request {
  kind: "monte-carlo" | "weaponeering";
  runs: number;
  config: SimulationConfig;
}

type Response =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; kind: "monte-carlo"; report: ReturnType<typeof runMonteCarlo> }
  | { type: "result"; kind: "weaponeering"; report: ReturnType<typeof runWeaponeeringStudy> }
  | { type: "error"; message: string };

const context = self as DedicatedWorkerGlobalScope;

context.onmessage = (event: MessageEvent<Request>) => {
  try {
    const { kind, runs, config } = event.data;
    const onProgress = (completed: number, total: number) => {
      const message: Response = { type: "progress", completed, total };
      context.postMessage(message);
    };
    if (kind === "weaponeering") {
      const report = runWeaponeeringStudy({
        runs,
        baseSeed: config.seed,
        createConfig: () => structuredClone(config),
        onProgress,
      });
      const message: Response = { type: "result", kind: "weaponeering", report };
      context.postMessage(message);
      return;
    }
    const modes: ObservationMode[] = ["perfect", "raw", "ekf"];
    const laws: GuidanceLaw[] = ["pure-pursuit", "proportional-navigation"];
    const scenarios: ScenarioKind[] = [config.scenario.kind];
    const report = runMonteCarlo({
      runs,
      baseSeed: config.seed,
      modes,
      laws,
      scenarios,
      createConfig: () => structuredClone(config),
      onProgress,
    });
    const message: Response = { type: "result", kind: "monte-carlo", report };
    context.postMessage(message);
  } catch (error) {
    const message: Response = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    context.postMessage(message);
  }
};
