import { hashConfig, validateConfig } from "../sim/config";
import { replayDigest } from "./hash";
import {
  EVENT_SCHEMA_VERSION,
  REPLAY_FORMAT,
  REPLAY_SCHEMA_VERSION,
  TELEMETRY_SCHEMA_VERSION,
  type ReplayFile,
} from "./types";

export class ReplayCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayCompatibilityError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReplayCompatibilityError(`${name} must be a finite number.`);
  }
}

export function validateReplay(value: unknown): asserts value is ReplayFile {
  if (!record(value)) throw new ReplayCompatibilityError("Replay root must be an object.");
  if (value.format !== REPLAY_FORMAT) {
    throw new ReplayCompatibilityError(`Unsupported replay format: ${String(value.format)}.`);
  }
  if (value.schemaVersion !== REPLAY_SCHEMA_VERSION) {
    throw new ReplayCompatibilityError(
      `Replay schema ${String(value.schemaVersion)} is incompatible; this build supports ${REPLAY_SCHEMA_VERSION}.`,
    );
  }
  if (!record(value.schemas)) throw new ReplayCompatibilityError("Replay schema manifest is missing.");
  if (value.schemas.replay !== REPLAY_SCHEMA_VERSION) {
    throw new ReplayCompatibilityError("Replay schema manifest does not match the file version.");
  }
  if (value.schemas.configuration !== 2) {
    throw new ReplayCompatibilityError(`Configuration schema ${String(value.schemas.configuration)} is unsupported.`);
  }
  if (value.schemas.event !== EVENT_SCHEMA_VERSION) {
    throw new ReplayCompatibilityError(`Event schema ${String(value.schemas.event)} is unsupported.`);
  }
  if (value.schemas.telemetry !== TELEMETRY_SCHEMA_VERSION) {
    throw new ReplayCompatibilityError(`Telemetry schema ${String(value.schemas.telemetry)} is unsupported.`);
  }
  if (!record(value.config)) throw new ReplayCompatibilityError("Replay configuration is missing.");
  try {
    validateConfig(value.config as unknown as ReplayFile["config"]);
  } catch (error) {
    throw new ReplayCompatibilityError(
      `Replay configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(value.events) || !Array.isArray(value.frames) || !Array.isArray(value.telemetry)) {
    throw new ReplayCompatibilityError("Replay event, frame, or telemetry stream is missing.");
  }
  if (!Array.isArray(value.profiles)) throw new ReplayCompatibilityError("Replay profiling stream is missing.");
  finite("physicsTimestep", value.physicsTimestep);
  if (Math.abs(value.physicsTimestep - 0.005) > 1e-12) {
    throw new ReplayCompatibilityError(`Replay timestep ${value.physicsTimestep} is unsupported.`);
  }
  if (typeof value.configHash !== "string" || !/^[0-9a-f]{8}$/.test(value.configHash)) {
    throw new ReplayCompatibilityError("Replay configuration hash is malformed.");
  }
  if (!Number.isInteger(value.seed) || (value.seed as number) < 0) {
    throw new ReplayCompatibilityError("Replay seed is invalid.");
  }
  const config = value.config as unknown as ReplayFile["config"];
  if (hashConfig(config) !== value.configHash) {
    throw new ReplayCompatibilityError("Replay configuration hash does not match its embedded configuration.");
  }
  if (config.seed !== value.seed) {
    throw new ReplayCompatibilityError("Replay seed does not match its embedded configuration.");
  }
  if (typeof value.applicationVersion !== "string" || value.applicationVersion.length === 0) {
    throw new ReplayCompatibilityError("Replay application version is missing.");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new ReplayCompatibilityError("Replay creation timestamp is invalid.");
  }
  let previousTime = -Infinity;
  for (let index = 0; index < value.events.length; index += 1) {
    const event = value.events[index];
    if (
      !record(event) ||
      event.schemaVersion !== EVENT_SCHEMA_VERSION ||
      event.sequence !== index ||
      typeof event.kind !== "string" ||
      typeof event.source !== "string" ||
      !record(event.data)
    ) {
      throw new ReplayCompatibilityError(`Replay event ${index} is malformed or incompatible.`);
    }
    finite(`event ${index} simulationTime`, event.simulationTime);
    finite(`event ${index} wallOffsetMs`, event.wallOffsetMs);
    if (event.simulationTime + 1e-12 < previousTime) {
      throw new ReplayCompatibilityError("Replay event timestamps are not ordered.");
    }
    previousTime = event.simulationTime;
  }
  previousTime = -Infinity;
  for (let index = 0; index < value.frames.length; index += 1) {
    const frame = value.frames[index];
    if (!record(frame) || frame.index !== index || !record(frame.snapshot)) {
      throw new ReplayCompatibilityError(`Replay frame ${index} is malformed.`);
    }
    finite(`frame ${index} timestamp`, frame.snapshot.timestamp);
    if (frame.snapshot.timestamp + 1e-12 < previousTime) {
      throw new ReplayCompatibilityError("Replay frame timestamps are not ordered.");
    }
    previousTime = frame.snapshot.timestamp;
  }
  previousTime = -Infinity;
  for (const sample of value.telemetry) {
    if (!record(sample)) throw new ReplayCompatibilityError("Replay telemetry contains a malformed sample.");
    finite("telemetry timestamp", sample.timestamp);
    if (sample.timestamp + 1e-12 < previousTime) {
      throw new ReplayCompatibilityError("Replay telemetry timestamps are not ordered.");
    }
    previousTime = sample.timestamp;
  }
  previousTime = -Infinity;
  for (const profile of value.profiles) {
    if (!record(profile)) throw new ReplayCompatibilityError("Replay profiling stream contains a malformed sample.");
    finite("profile timestamp", profile.timestamp);
    finite("profile wall interval", profile.wallIntervalMs);
    finite("profile simulation interval", profile.simulationSeconds);
    finite("profile real-time factor", profile.realTimeFactor);
    finite("profile maximum backlog", profile.maximumBacklogSeconds);
    if (profile.timestamp + 1e-12 < previousTime) {
      throw new ReplayCompatibilityError("Replay profiling timestamps are not ordered.");
    }
    previousTime = profile.timestamp;
  }
  if (value.result === null) {
    if (value.terminalDigest !== null) {
      throw new ReplayCompatibilityError("An incomplete replay cannot have a terminal digest.");
    }
  } else {
    if (!record(value.result) || typeof value.terminalDigest !== "string") {
      throw new ReplayCompatibilityError("Completed replay terminal evidence is malformed.");
    }
    const expectedDigest = replayDigest({
      configHash: value.configHash,
      result: value.result as unknown as ReplayFile["result"],
      finalTelemetry: (value.telemetry.at(-1) ?? null) as ReplayFile["telemetry"][number] | null,
    });
    if (value.terminalDigest !== expectedDigest) {
      throw new ReplayCompatibilityError("Replay terminal digest does not match the recorded result.");
    }
  }
}

export function parseReplay(text: string): ReplayFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ReplayCompatibilityError(
      `Replay is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateReplay(parsed);
  return parsed;
}

export function serializeReplay(replay: ReplayFile): string {
  validateReplay(replay);
  return JSON.stringify(replay, null, 2);
}
