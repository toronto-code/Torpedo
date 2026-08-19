import { hashConfig } from "../sim/config";
import type {
  ExperimentResult,
  RenderSnapshot,
  SimulationConfig,
  TelemetrySample,
} from "../sim/types";
import {
  SIMULATION_WORKER_PROTOCOL_VERSION,
  type SimulationWorkerRequest,
  type SimulationWorkerResponse,
} from "../sim/worker-protocol";
import { ReplayRecorder, type PendingEvent } from "../replay/recorder";
import type {
  JsonValue,
  ReplayEventKind,
  ReplayFile,
  ReplaySummary,
  RuntimeProfileSample,
} from "../replay/types";

export type RuntimeStatus =
  | "starting"
  | "running"
  | "paused"
  | "complete"
  | "recovering"
  | "error";

export interface RuntimeView {
  ready: boolean;
  status: RuntimeStatus;
  snapshot: RenderSnapshot | null;
  telemetry: TelemetrySample[];
  result: ExperimentResult | null;
  error: string | null;
  activeConfigHash: string | null;
  workerGeneration: number;
  workerRecoveries: number;
  workerProtocolVersion: number | null;
  profile: RuntimeProfileSample | null;
  replay: ReplaySummary;
}

export interface WorkerLike {
  onmessage: ((event: MessageEvent<SimulationWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SimulationWorkerRequest): void;
  terminate(): void;
}

type Listener = (view: RuntimeView) => void;
type WorkerFactory = () => WorkerLike;

const HISTORY_LIMIT = 2_400;
const MAX_RECOVERY_ATTEMPTS = 3;
const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

const EMPTY_REPLAY: ReplaySummary = {
  available: false,
  frames: 0,
  telemetrySamples: 0,
  events: 0,
  duration: 0,
  complete: false,
  configHash: null,
};

function defaultWorkerFactory(): WorkerLike {
  return new Worker(
    new URL("../sim/sim.worker.ts", import.meta.url),
    { type: "module", name: "authoritative-simulation" },
  );
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

interface ConfigDifference {
  path: string;
  before: JsonValue;
  after: JsonValue;
}

function configDifferences(
  before: unknown,
  after: unknown,
  path = "config",
): ConfigDifference[] {
  if (Object.is(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ]);
    return [...keys].flatMap((key) =>
      configDifferences(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        `${path}.${key}`,
      ),
    );
  }
  return [{ path, before: jsonValue(before), after: jsonValue(after) }];
}

export class SimulationRuntime {
  private worker: WorkerLike | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly pendingEvents: PendingEvent[] = [];
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private recorder: ReplayRecorder | null = null;
  private activeConfig: SimulationConfig | null = null;
  private activeTimeScale = 1;
  private lastWorkerContact = performance.now();
  private heartbeatNonce = 0;
  private disposed = false;
  private resumeAfterRecovery = true;
  private view: RuntimeView = {
    ready: false,
    status: "starting",
    snapshot: null,
    telemetry: [],
    result: null,
    error: null,
    activeConfigHash: null,
    workerGeneration: 0,
    workerRecoveries: 0,
    workerProtocolVersion: null,
    profile: null,
    replay: EMPTY_REPLAY,
  };

  constructor(private readonly workerFactory: WorkerFactory = defaultWorkerFactory) {
    this.spawnWorker();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  start(config: SimulationConfig, timeScale = 1): void {
    this.activeConfig = structuredClone(config);
    this.activeTimeScale = timeScale;
    this.recorder = new ReplayRecorder(this.activeConfig, this.pendingEvents.splice(0));
    this.view = {
      ...this.view,
      status: "running",
      snapshot: null,
      telemetry: [],
      result: null,
      error: null,
      activeConfigHash: hashConfig(this.activeConfig),
      profile: null,
      replay: this.recorder.summary(),
    };
    this.publish();
    this.send({ type: "start", config: this.activeConfig, timeScale });
  }

  pause(): void {
    this.event("pause", "user");
    this.send({ type: "pause" });
    this.patch({ status: "paused" });
  }

  resume(): void {
    this.event("resume", "user");
    this.send({ type: "resume" });
    this.patch({ status: "running" });
  }

  step(): void {
    this.event("single-step", "user", { timestep: 0.005 });
    this.send({ type: "step" });
    this.patch({ status: "paused" });
  }

  reset(): void {
    this.event("reset", "user");
    this.send({ type: "reset" });
    this.activeConfig = null;
    this.patch({
      status: "paused",
      snapshot: null,
      telemetry: [],
      result: null,
      error: null,
      activeConfigHash: null,
      profile: null,
      replay: this.recorder?.summary() ?? EMPTY_REPLAY,
    });
  }

  setTimeScale(timeScale: number): void {
    this.activeTimeScale = timeScale;
    this.event("time-scale", "user", { value: timeScale });
    this.send({ type: "set-time-scale", timeScale });
  }

  /** Forwards an operator engagement authorization to the engine. */
  authorize(): void {
    this.recordUserEvent("authorize", {});
    this.send({ type: "authorize" });
  }

  recordConfigChange(before: SimulationConfig, after: SimulationConfig): void {
    for (const entry of configDifferences(before, after)) {
      this.recordUserEvent("config-change", {
        path: entry.path,
        before: entry.before,
        after: entry.after,
        appliesOnRestart: true,
      });
    }
  }

  recordUserEvent(kind: ReplayEventKind, data: Record<string, JsonValue>): void {
    if (this.recorder) this.recorder.event(kind, "user", data, this.simulationTime);
    else this.pendingEvents.push({ kind, source: "user", data });
    this.patch({ replay: this.recorder?.summary() ?? this.view.replay });
  }

  getReplay(): ReplayFile | null {
    return this.recorder?.build() ?? null;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.heartbeatTimer);
    this.worker?.terminate();
    this.worker = null;
    this.listeners.clear();
  }

  private get simulationTime(): number {
    return this.view.snapshot?.timestamp ?? 0;
  }

  private event(
    kind: ReplayEventKind,
    source: "user" | "runtime" | "worker",
    data: Record<string, JsonValue> = {},
  ): void {
    if (this.recorder) this.recorder.event(kind, source, data, this.simulationTime);
  }

  private spawnWorker(): void {
    const worker = this.workerFactory();
    this.worker = worker;
    const generation = this.view.workerGeneration + 1;
    this.lastWorkerContact = performance.now();
    this.view = { ...this.view, workerGeneration: generation };
    worker.onmessage = (event) => {
      if (this.worker !== worker || this.disposed) return;
      this.lastWorkerContact = performance.now();
      this.receive(event.data);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker || this.disposed) return;
      event.preventDefault?.();
      this.recoverWorker(event.message || "Unknown Worker failure.");
    };
  }

  private send(message: SimulationWorkerRequest): void {
    this.worker?.postMessage(message);
  }

  private heartbeat(): void {
    if (this.disposed || !this.worker || !this.view.ready) return;
    const now = performance.now();
    if (now - this.lastWorkerContact > HEARTBEAT_TIMEOUT_MS) {
      this.recoverWorker("Worker heartbeat timed out.");
      return;
    }
    this.send({ type: "ping", nonce: this.heartbeatNonce++ });
  }

  private recoverWorker(message: string): void {
    const previousTime = this.simulationTime;
    this.event("worker-failure", "worker", { message, previousTime });
    if (this.view.workerRecoveries >= MAX_RECOVERY_ATTEMPTS) {
      this.patch({
        ready: false,
        status: "error",
        error: `${message} Automatic recovery limit reached.`,
      });
      return;
    }
    this.resumeAfterRecovery = this.view.status === "running";
    const recovery = this.view.workerRecoveries + 1;
    this.worker?.terminate();
    this.worker = null;
    const recoveryEvents: PendingEvent[] = [
      {
        kind: "worker-failure",
        source: "worker",
        data: { message, previousTime },
      },
      {
        kind: "worker-recovered",
        source: "runtime",
        data: { attempt: recovery, restartedFromTime: 0 },
      },
    ];
    if (this.activeConfig) {
      this.recorder = new ReplayRecorder(this.activeConfig, recoveryEvents);
    }
    this.patch({
      ready: false,
      status: "recovering",
      snapshot: null,
      telemetry: [],
      result: null,
      error: null,
      profile: null,
      workerRecoveries: recovery,
      workerProtocolVersion: null,
      replay: this.recorder?.summary() ?? EMPTY_REPLAY,
    });
    this.spawnWorker();
  }

  private receive(message: SimulationWorkerResponse): void {
    switch (message.type) {
      case "ready": {
        if (message.protocolVersion !== SIMULATION_WORKER_PROTOCOL_VERSION) {
          this.worker?.terminate();
          this.patch({
            ready: false,
            status: "error",
            error: `Worker protocol ${message.protocolVersion} is incompatible; expected ${SIMULATION_WORKER_PROTOCOL_VERSION}.`,
            workerProtocolVersion: message.protocolVersion,
          });
          break;
        }
        const recovering = this.view.status === "recovering";
        this.patch({
          ready: true,
          status: recovering
            ? (this.resumeAfterRecovery ? "running" : "paused")
            : "paused",
          workerProtocolVersion: message.protocolVersion,
        });
        if (recovering && this.activeConfig) {
          this.send({ type: "start", config: this.activeConfig, timeScale: this.activeTimeScale });
          if (!this.resumeAfterRecovery) this.send({ type: "pause" });
        }
        break;
      }
      case "pong":
        break;
      case "snapshot":
        this.recorder?.snapshot(message.snapshot);
        this.patch({
          snapshot: message.snapshot,
          replay: this.recorder?.summary() ?? EMPTY_REPLAY,
        });
        break;
      case "telemetry": {
        this.recorder?.telemetry(message.batch);
        const telemetry = [...this.view.telemetry, ...message.batch.samples];
        this.patch({
          telemetry: telemetry.slice(-HISTORY_LIMIT),
          replay: this.recorder?.summary() ?? EMPTY_REPLAY,
        });
        break;
      }
      case "profile":
        this.recorder?.profile(message.sample);
        this.patch({ profile: message.sample });
        break;
      case "result":
        this.recorder?.complete(message.result);
        this.patch({
          status: "complete",
          result: message.result,
          replay: this.recorder?.summary() ?? EMPTY_REPLAY,
        });
        break;
      case "error":
        this.patch({ status: "error", error: message.message });
        break;
    }
  }

  private patch(patch: Partial<RuntimeView>): void {
    this.view = { ...this.view, ...patch };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.view);
  }
}
