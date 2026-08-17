import type { FidelityStudyReport } from "../analysis/types";
import type { SimulationConfig } from "../sim/types";
import type { AnalysisProgress } from "./monteCarlo";

type Response =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; report: FidelityStudyReport }
  | { type: "error"; message: string };

export function runFidelityAnalysis(
  runs: number,
  config: SimulationConfig,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<FidelityStudyReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fidelity.worker.ts", import.meta.url), {
      type: "module",
      name: "fidelity-study",
    });
    worker.onmessage = (event: MessageEvent<Response>) => {
      const message = event.data;
      if (message.type === "progress") onProgress(message);
      else if (message.type === "result") {
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

