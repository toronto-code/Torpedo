import { useEffect, useMemo, useState } from "react";

import { SimulationRuntime, type RuntimeView } from "./runtime";

export function useSimulation(): [SimulationRuntime, RuntimeView] {
  const runtime = useMemo(() => new SimulationRuntime(), []);
  const [view, setView] = useState<RuntimeView>({
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
    replay: {
      available: false,
      frames: 0,
      telemetrySamples: 0,
      events: 0,
      duration: 0,
      complete: false,
      configHash: null,
    },
  });

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setView);
    return () => {
      unsubscribe();
      runtime.dispose();
    };
  }, [runtime]);

  return [runtime, view];
}
