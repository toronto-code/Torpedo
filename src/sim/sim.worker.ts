/// <reference lib="webworker" />

import { SimulationEngine } from "./engine";
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from "./worker-protocol";
import { SIMULATION_WORKER_PROTOCOL_VERSION } from "./worker-protocol";

const context = self as DedicatedWorkerGlobalScope;
let engine: SimulationEngine | null = null;
let paused = true;
let timeScale = 1;
let timer: ReturnType<typeof setInterval> | null = null;
let lastWallTime = performance.now();
let accumulated = 0;
let profileStartedAt = performance.now();
let profileSimulationStartedAt = 0;
let profileSteps = 0;
let profileSnapshots = 0;
let profileTelemetry = 0;
let maximumBacklog = 0;

function post(message: SimulationWorkerResponse): void {
  context.postMessage(message);
}

function emitStep(forceSnapshot = false): void {
  if (!engine) return;
  const output = engine.step(forceSnapshot);
  if (output.snapshot) {
    profileSnapshots += 1;
    post({ type: "snapshot", snapshot: output.snapshot });
  }
  if (output.telemetry) {
    profileTelemetry += 1;
    post({ type: "telemetry", batch: output.telemetry });
  }
  if (output.result) {
    post({ type: "result", result: output.result });
    paused = true;
  }
  profileSteps += 1;
}

function resetProfile(now: number): void {
  profileStartedAt = now;
  profileSimulationStartedAt = engine?.timestamp ?? 0;
  profileSteps = 0;
  profileSnapshots = 0;
  profileTelemetry = 0;
  maximumBacklog = 0;
}

function emitProfile(now: number): void {
  if (!engine || now - profileStartedAt < 1000) return;
  const wallIntervalMs = now - profileStartedAt;
  const simulationSeconds = engine.timestamp - profileSimulationStartedAt;
  post({
    type: "profile",
    sample: {
      timestamp: engine.timestamp,
      wallIntervalMs,
      simulationSeconds,
      steps: profileSteps,
      snapshots: profileSnapshots,
      telemetryBatches: profileTelemetry,
      realTimeFactor: simulationSeconds / Math.max(1e-9, wallIntervalMs / 1000),
      maximumBacklogSeconds: maximumBacklog,
    },
  });
  resetProfile(now);
}

function loop(): void {
  const now = performance.now();
  const wallDt = Math.min(0.1, (now - lastWallTime) / 1000);
  lastWallTime = now;
  if (!engine || paused) {
    emitProfile(now);
    return;
  }
  accumulated += wallDt * timeScale;
  maximumBacklog = Math.max(maximumBacklog, accumulated);
  const dt = 1 / engine.config.runtime.physicsHz;
  let steps = 0;
  while (accumulated >= dt && steps < 2000 && !engine.completed) {
    emitStep();
    accumulated -= dt;
    steps += 1;
  }
  emitProfile(now);
}

context.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
  try {
    const message = event.data;
    switch (message.type) {
      case "start":
        engine = new SimulationEngine(message.config);
        timeScale = message.timeScale ?? 1;
        paused = false;
        accumulated = 0;
        lastWallTime = performance.now();
        resetProfile(lastWallTime);
        break;
      case "pause":
        paused = true;
        if (engine) post({ type: "snapshot", snapshot: engine.currentSnapshot() });
        break;
      case "resume":
        paused = false;
        lastWallTime = performance.now();
        break;
      case "step":
        paused = true;
        emitStep(true);
        break;
      case "reset":
        engine = null;
        paused = true;
        accumulated = 0;
        break;
      case "set-time-scale":
        timeScale = Math.max(0.1, message.timeScale);
        break;
      case "authorize":
        engine?.authorize();
        break;
      case "ping":
        post({ type: "pong", nonce: message.nonce });
        break;
    }
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    paused = true;
  }
};

timer = setInterval(loop, 5);
post({ type: "ready", protocolVersion: SIMULATION_WORKER_PROTOCOL_VERSION });

context.addEventListener("close", () => {
  if (timer) clearInterval(timer);
});
