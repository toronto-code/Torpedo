/// <reference lib="webworker" />

import { runMonteCarlo } from "../analysis/monte-carlo";
import type { GuidanceLaw, ObservationMode, ScenarioKind, SimulationConfig } from "../sim/types";

interface Request {
  runs: number;
  config: SimulationConfig;
}

type Response =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; report: ReturnType<typeof runMonteCarlo> }
  | { type: "error"; message: string };

const context = self as DedicatedWorkerGlobalScope;

context.onmessage = (event: MessageEvent<Request>) => {
  try {
    const { runs, config } = event.data;
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
      onProgress: (completed, total) => {
        const message: Response = { type: "progress", completed, total };
        context.postMessage(message);
      },
    });
    const message: Response = { type: "result", report };
    context.postMessage(message);
  } catch (error) {
    const message: Response = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    context.postMessage(message);
  }
};

