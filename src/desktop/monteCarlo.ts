import type { MonteCarloReport } from "../analysis/types";
import type { WeaponeeringReport } from "../analysis/weaponeering";
import type { SimulationConfig } from "../sim/types";

type AnalysisResponse =
  | { type: "progress"; completed: number; total: number }
  | { type: "result"; kind: "monte-carlo"; report: MonteCarloReport }
  | { type: "result"; kind: "weaponeering"; report: WeaponeeringReport }
  | { type: "error"; message: string };

export interface AnalysisProgress {
  completed: number;
  total: number;
}

function startWorker(
  request: { kind: "monte-carlo" | "weaponeering"; runs: number; config: SimulationConfig },
  onProgress: (progress: AnalysisProgress) => void,
): Promise<AnalysisResponse & { type: "result" }> {
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
        resolve(message);
      } else {
        worker.terminate();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(request);
  });
}

export function runAnalysis(
  runs: number,
  config: SimulationConfig,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<MonteCarloReport> {
  return startWorker({ kind: "monte-carlo", runs, config }, onProgress)
    .then((message) => message.report as MonteCarloReport);
}

export function runWeaponeeringAnalysis(
  runs: number,
  config: SimulationConfig,
  onProgress: (progress: AnalysisProgress) => void,
): Promise<WeaponeeringReport> {
  return startWorker({ kind: "weaponeering", runs, config }, onProgress)
    .then((message) => message.report as WeaponeeringReport);
}
