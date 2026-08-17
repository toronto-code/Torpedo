import type {
  ExperimentResult,
  RenderSnapshot,
  SimulationConfig,
  TelemetrySample,
} from "../sim/types";

export const REPLAY_FORMAT = "guidance-estimation-replay" as const;
export const REPLAY_SCHEMA_VERSION = 2 as const;
export const EVENT_SCHEMA_VERSION = 2 as const;
export const TELEMETRY_SCHEMA_VERSION = 2 as const;
export const APPLICATION_VERSION = "1.0.0" as const;

export type ReplayEventKind =
  | "run-started"
  | "run-completed"
  | "pause"
  | "resume"
  | "single-step"
  | "reset"
  | "time-scale"
  | "config-change"
  | "camera-change"
  | "overlay-change"
  | "worker-failure"
  | "worker-recovered"
  | "replay-loaded"
  | "demo-preset";

export type ReplayEventSource = "user" | "runtime" | "worker";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ReplayEvent {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  sequence: number;
  simulationTime: number;
  wallOffsetMs: number;
  kind: ReplayEventKind;
  source: ReplayEventSource;
  data: Record<string, JsonValue>;
}

export interface ReplayFrame {
  index: number;
  snapshot: RenderSnapshot;
}

export interface RuntimeProfileSample {
  timestamp: number;
  wallIntervalMs: number;
  simulationSeconds: number;
  steps: number;
  snapshots: number;
  telemetryBatches: number;
  realTimeFactor: number;
  maximumBacklogSeconds: number;
}

export interface ReplaySchemas {
  replay: typeof REPLAY_SCHEMA_VERSION;
  configuration: SimulationConfig["version"];
  event: typeof EVENT_SCHEMA_VERSION;
  telemetry: typeof TELEMETRY_SCHEMA_VERSION;
}

export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  schemaVersion: typeof REPLAY_SCHEMA_VERSION;
  applicationVersion: string;
  createdAt: string;
  schemas: ReplaySchemas;
  configHash: string;
  seed: number;
  physicsTimestep: number;
  config: SimulationConfig;
  events: ReplayEvent[];
  frames: ReplayFrame[];
  telemetry: TelemetrySample[];
  profiles: RuntimeProfileSample[];
  result: ExperimentResult | null;
  terminalDigest: string | null;
}

export interface ReplaySummary {
  available: boolean;
  frames: number;
  telemetrySamples: number;
  events: number;
  duration: number;
  complete: boolean;
  configHash: string | null;
}

export interface MetricDifference {
  name: keyof ExperimentResult;
  expected: string | number | null;
  actual: string | number | null;
  absoluteDifference: number | null;
  withinTolerance: boolean;
}

export interface ReplayVerification {
  compatible: boolean;
  deterministic: boolean;
  tolerance: number;
  configHashMatches: boolean;
  digestMatches: boolean;
  differences: MetricDifference[];
  rerunResult: ExperimentResult | null;
  elapsedWallMs: number;
}
