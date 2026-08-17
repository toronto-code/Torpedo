import { describe, expect, it } from "vitest";

import { SimulationRuntime, type RuntimeView, type WorkerLike } from "../src/desktop/runtime";
import { createDefaultConfig } from "../src/sim/config";
import { SIMULATION_WORKER_PROTOCOL_VERSION, type SimulationWorkerRequest, type SimulationWorkerResponse } from "../src/sim/worker-protocol";

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<SimulationWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: SimulationWorkerRequest[] = [];
  terminated = false;

  postMessage(message: SimulationWorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: SimulationWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<SimulationWorkerResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

describe("Worker supervision", () => {
  it("restarts a failed Worker from the frozen configuration", () => {
    const workers: FakeWorker[] = [];
    const runtime = new SimulationRuntime(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    let view: RuntimeView | null = null;
    const unsubscribe = runtime.subscribe((next) => { view = next; });

    workers[0].emit({ type: "ready", protocolVersion: SIMULATION_WORKER_PROTOCOL_VERSION });
    const config = createDefaultConfig();
    runtime.start(config, 2);
    expect(workers[0].messages.at(-1)?.type).toBe("start");

    workers[0].fail("synthetic interruption");
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect((view as RuntimeView | null)?.status).toBe("recovering");

    workers[1].emit({ type: "ready", protocolVersion: SIMULATION_WORKER_PROTOCOL_VERSION });
    expect((view as RuntimeView | null)?.status).toBe("running");
    expect((view as RuntimeView | null)?.workerRecoveries).toBe(1);
    expect((view as RuntimeView | null)?.workerGeneration).toBe(2);
    expect(workers[1].messages[0]).toMatchObject({ type: "start", timeScale: 2 });
    expect(runtime.getReplay()?.events.map((event) => event.kind)).toContain("worker-recovered");

    unsubscribe();
    runtime.dispose();
  });

  it("rejects an incompatible Worker protocol", () => {
    const worker = new FakeWorker();
    const runtime = new SimulationRuntime(() => worker);
    let view: RuntimeView | null = null;
    const unsubscribe = runtime.subscribe((next) => { view = next; });
    worker.emit({ type: "ready", protocolVersion: 999 });
    expect((view as RuntimeView | null)?.status).toBe("error");
    expect((view as RuntimeView | null)?.error).toMatch(/incompatible/i);
    expect(worker.terminated).toBe(true);
    unsubscribe();
    runtime.dispose();
  });
});
