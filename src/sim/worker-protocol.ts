import type {
  ExperimentResult,
  RenderSnapshot,
  SimulationConfig,
  TelemetryBatch,
} from "./types";
import type { RuntimeProfileSample } from "../replay/types";

export const SIMULATION_WORKER_PROTOCOL_VERSION = 3 as const;

export type SimulationWorkerRequest =
  | { type: "start"; config: SimulationConfig; timeScale?: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "step" }
  | { type: "reset" }
  | { type: "set-time-scale"; timeScale: number }
  | { type: "ping"; nonce: number };

export type SimulationWorkerResponse =
  | { type: "ready"; protocolVersion: number }
  | { type: "pong"; nonce: number }
  | { type: "snapshot"; snapshot: RenderSnapshot }
  | { type: "telemetry"; batch: TelemetryBatch }
  | { type: "profile"; sample: RuntimeProfileSample }
  | { type: "result"; result: ExperimentResult }
  | { type: "error"; message: string };
