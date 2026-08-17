import { hashConfig } from "../sim/config";
import type {
  ExperimentResult,
  RenderSnapshot,
  SimulationConfig,
  TelemetryBatch,
} from "../sim/types";
import { replayDigest } from "./hash";
import {
  APPLICATION_VERSION,
  EVENT_SCHEMA_VERSION,
  REPLAY_FORMAT,
  REPLAY_SCHEMA_VERSION,
  TELEMETRY_SCHEMA_VERSION,
  type JsonValue,
  type ReplayEvent,
  type ReplayEventKind,
  type ReplayEventSource,
  type ReplayFile,
  type ReplaySummary,
  type RuntimeProfileSample,
} from "./types";

interface PendingEvent {
  kind: ReplayEventKind;
  source: ReplayEventSource;
  data?: Record<string, JsonValue>;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class ReplayRecorder {
  private readonly startedAt = performance.now();
  private readonly replay: ReplayFile;
  private eventSequence = 0;

  constructor(config: SimulationConfig, pendingEvents: PendingEvent[] = []) {
    const frozenConfig = structuredClone(config);
    this.replay = {
      format: REPLAY_FORMAT,
      schemaVersion: REPLAY_SCHEMA_VERSION,
      applicationVersion: APPLICATION_VERSION,
      createdAt: new Date().toISOString(),
      schemas: {
        replay: REPLAY_SCHEMA_VERSION,
        configuration: frozenConfig.version,
        event: EVENT_SCHEMA_VERSION,
        telemetry: TELEMETRY_SCHEMA_VERSION,
      },
      configHash: hashConfig(frozenConfig),
      seed: frozenConfig.seed,
      physicsTimestep: 1 / frozenConfig.runtime.physicsHz,
      config: frozenConfig,
      events: [],
      frames: [],
      telemetry: [],
      profiles: [],
      result: null,
      terminalDigest: null,
    };
    this.event("run-started", "runtime", {
      seed: frozenConfig.seed,
      configHash: this.replay.configHash,
    }, 0);
    for (const pending of pendingEvents) {
      this.event(pending.kind, pending.source, pending.data ?? {}, 0);
    }
  }

  event(
    kind: ReplayEventKind,
    source: ReplayEventSource,
    data: Record<string, JsonValue> = {},
    simulationTime = this.duration,
  ): void {
    const entry: ReplayEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      sequence: this.eventSequence++,
      simulationTime,
      wallOffsetMs: performance.now() - this.startedAt,
      kind,
      source,
      data,
    };
    this.replay.events.push(entry);
  }

  snapshot(snapshot: RenderSnapshot): void {
    this.replay.frames.push({
      index: this.replay.frames.length,
      snapshot: jsonClone(snapshot),
    });
  }

  telemetry(batch: TelemetryBatch): void {
    this.replay.telemetry.push(...jsonClone(batch.samples));
  }

  profile(sample: RuntimeProfileSample): void {
    this.replay.profiles.push(jsonClone(sample));
  }

  complete(result: ExperimentResult): void {
    this.replay.result = jsonClone(result);
    this.event("run-completed", "worker", {
      terminationReason: result.terminationReason,
      closestApproach: result.closestApproach,
      elapsedTime: result.elapsedTime,
    }, result.elapsedTime);
    this.replay.terminalDigest = replayDigest({
      configHash: this.replay.configHash,
      result: this.replay.result,
      finalTelemetry: this.replay.telemetry.at(-1) ?? null,
    });
  }

  build(): ReplayFile {
    return jsonClone(this.replay);
  }

  get duration(): number {
    return this.replay.frames.at(-1)?.snapshot.timestamp
      ?? this.replay.telemetry.at(-1)?.timestamp
      ?? 0;
  }

  summary(): ReplaySummary {
    return {
      available: this.replay.frames.length > 0,
      frames: this.replay.frames.length,
      telemetrySamples: this.replay.telemetry.length,
      events: this.replay.events.length,
      duration: this.duration,
      complete: this.replay.result !== null,
      configHash: this.replay.configHash,
    };
  }
}

export type { PendingEvent };
