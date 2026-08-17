/// <reference lib="webworker" />

import { runFidelityStudy } from "../analysis/fidelity";
import type { FidelityStudyReport } from "../analysis/types";
import type { SimulationConfig } from "../sim/types";

interface Request {
  runs: number;
  config: SimulationConfig;
}

type Response =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; report: FidelityStudyReport }
  | { type: "error"; message: string };

const context = self as DedicatedWorkerGlobalScope;

context.onmessage = (event: MessageEvent<Request>) => {
  try {
    const report = runFidelityStudy({
      runs: event.data.runs,
      baseConfig: event.data.config,
      onProgress(completed, total) {
        const response: Response = { type: "progress", completed, total };
        context.postMessage(response);
      },
    });
    const response: Response = { type: "result", report };
    context.postMessage(response);
  } catch (error) {
    const response: Response = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    context.postMessage(response);
  }
};

