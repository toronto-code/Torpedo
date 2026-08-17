import type { MonteCarloReport } from "../analysis/types";
import type { SimulationConfig } from "../sim/types";

type AnalysisResponse =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; report: MonteCarloReport }
  | { type: "error"; message: string };

export interface AnalysisProgress {
  completed: number;
  total: number;
}

export function runAnalysis(
  runs: number,
  config: SimulationConfig,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<MonteCarloReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), {
      type: "module",
      name: "monte-carlo-analysis",
    });
    worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress(message);
      } else if (message.type === "result") {
        worker.terminate();
        resolve(message.report);
      } else {
        worker.terminate();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ runs, config });
  });
}
