import { describe, expect, it } from "vitest";
import { createAmbiguityScenarioConfig } from "../src/sim/scenarios";
import { runHeadless } from "../src/sim/engine";
import {
  activateKnuckle,
  createContactRuntime,
  effectiveTargetStrength,
} from "../src/sim/contacts";

const vehicleFor = (config: ReturnType<typeof createAmbiguityScenarioConfig>) =>
  config.contacts!.find((spec) => spec.id === "knuckle")!;

describe("knuckle countermeasure", () => {
  it("stays dormant until deployed, then fades from the spawner's position", () => {
    const config = createAmbiguityScenarioConfig("decoy-stress", 4242);
    const spec = vehicleFor(config);
    const runtime = createContactRuntime(spec, config);
    expect(runtime.active).toBe(false);
    expect(runtime.deployedAt).toBeNull();

    const hostileSpec = config.contacts!.find((s) => s.id === "hostile")!;
    const spawner = createContactRuntime(hostileSpec, config);
    spawner.state.position = { x: 900, y: 400, z: 60 };
    spawner.state.depth = 60;

    activateKnuckle(runtime, spawner, 42);
    expect(runtime.active).toBe(true);
    expect(runtime.deployedAt).toBe(42);
    expect(runtime.state.position.x).toBeCloseTo(900, 6);
    expect(runtime.state.position.y).toBeCloseTo(400, 6);
    expect(runtime.state.depth).toBeCloseTo(60, 6);

    // Echo decays linearly from deployment, floored at a whisper.
    const at = (t: number) =>
      effectiveTargetStrength(runtime, { x: 0, y: 0 }, 0, t);
    const base = spec.targetStrengthDb!;
    expect(at(42)).toBeCloseTo(base, 6);
    expect(at(52)).toBeCloseTo(base - 12, 6);
    expect(at(500)).toBe(-30);
  });

  it("is excluded from fuze actuation by the Doppler-style speed gate", () => {
    const config = createAmbiguityScenarioConfig("decoy-stress", 20260816);
    expect(config.weapon!.fuze!.minTargetSpeedMs).toBeGreaterThan(0);
    const run = runHeadless(config);
    const result = run.result;
    expect(result.terminationReason).toBe("fuzed-detonation");
    // A knuckle or decoy kill scores as countermeasure seduction, never as
    // wrong-contact; the knuckle itself (1.5 m/s drift) cannot actuate.
    expect(["correct-hostile", "decoy-seduction"]).toContain(
      result.engagementOutcome,
    );
    // Deterministic per seed.
    const again = runHeadless(config).result;
    expect(again.engagedContact).toEqual(result.engagedContact);
    expect(again.fuzeMissDistance).toEqual(result.fuzeMissDistance);
  });

  it("searches quiet during reacquisition (self-noise trades speed for cone)", () => {
    const config = createAmbiguityScenarioConfig("decoy-stress", 20260816);
    expect(config.weapon!.speed!.searchSpeed).toBeDefined();
    const run = runHeadless(config);
    const reacquire = run.telemetry.filter(
      (sample) =>
        sample.weapon?.phase === "reacquisition" &&
        sample.weapon?.commandedSpeed === config.weapon!.speed!.searchSpeed,
    );
    // The decoy engagement reliably passes through at least one lost-track
    // search; the quiet speed must be commanded there.
    expect(reacquire.length).toBeGreaterThan(0);
  });
});
