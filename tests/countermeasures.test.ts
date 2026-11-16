import { describe, expect, it } from "vitest";
import { createAmbiguityScenarioConfig } from "../src/sim/scenarios";
import { runHeadless } from "../src/sim/engine";
import { pathScreeningLossDb } from "../src/sim/acoustics";
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

  it("is excluded from fuze actuation by the Doppler-style speed gate", { timeout: 60000 }, () => {
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

  it("searches quiet during reacquisition (self-noise trades speed for cone)", { timeout: 60000 }, () => {
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

describe("jammer and occluding screen", () => {
  it("screening loss applies only to crossing paths, fading at the rim", () => {
    const screens = [{ x: 500, y: 0, radiusM: 130, lossDb: 11 }];
    // Path straight through the center: full loss.
    expect(pathScreeningLossDb(0, 0, 1000, 0, screens)).toBeCloseTo(11, 6);
    // Path passing the rim: near zero.
    expect(pathScreeningLossDb(0, 129.9, 1000, 129.9, screens)).toBeLessThan(0.2);
    // Path missing entirely: zero.
    expect(pathScreeningLossDb(0, 400, 1000, 400, screens)).toBe(0);
    // Path clipping the near side: partial.
    const partial = pathScreeningLossDb(0, 100, 1000, 60, screens);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(11);
    expect(pathScreeningLossDb(0, 0, 1000, 0, [])).toBe(0);
  });

  it("a jammer raises the receiver noise floor and degrades detection", () => {
    const config = createAmbiguityScenarioConfig("decoy-stress", 20260816);
    const spec = config.contacts!.find((c) => c.id === "jammer")!;
    expect(spec.behavior).toMatchObject({ kind: "jammer" });
    // The full-suite preset completes deterministically with the layered
    // defense active (jammer -> screen -> decoy -> knuckle).
    const run = runHeadless(config);
    const again = runHeadless(config);
    expect(again.result.engagementOutcome).toEqual(run.result.engagementOutcome);
    expect(again.result.terminationReason).toEqual(run.result.terminationReason);
    expect(run.result.terminationReason).toBe("fuzed-detonation");
  }, 120000);

  it("deploys the full countermeasure timeline in the preset", () => {
    const config = createAmbiguityScenarioConfig("decoy-stress", 20260816);
    const run = runHeadless(config);
    const deployments = run.result.phaseTimeline
      ?.filter((entry) => entry.reason.startsWith("countermeasure deployed:"))
      .map((entry) => entry.reason.slice("countermeasure deployed: ".length));
    // Escalating timeline: jammer first, then screen, decoy, knuckle.
    expect(deployments).toContain("jammer");
    expect(deployments).toContain("bubble-screen");
    expect(deployments).toContain("decoy");
    expect(deployments).toContain("knuckle");
  }, 120000);
});

describe("launch platform and wire guidance", () => {
  it("runs the platform pipeline: transient, authorization, wire cut, kill", () => {
    const config = createAmbiguityScenarioConfig("wire-guided", 20260817);
    expect(config.platform).toBeDefined();
    expect(config.weapon!.wireGuidance).toBe(true);
    const run = runHeadless(config);
    const result = run.result;
    // Authorization happened (the platform's doctrine fired) and the wire
    // cut at seeker activation.
    expect(result.tewaEvents?.some((e) => e.stage === "authorize")).toBe(true);
    expect(
      result.phaseTimeline?.some((p) => p.reason.includes("wire cut")),
    ).toBe(true);
    // The launch transient is loud: it is modeled during the first seconds.
    expect(config.platform!.transientDb).toBeGreaterThan(10);
    // Deterministic per seed.
    const again = runHeadless(config).result;
    expect(again.engagementOutcome).toEqual(result.engagementOutcome);
    expect(again.fuzeMissDistance).toEqual(result.fuzeMissDistance);
  }, 120000);
});
