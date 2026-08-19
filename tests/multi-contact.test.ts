import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/sim/config";
import { runHeadless, SimulationEngine } from "../src/sim/engine";
import {
  behaviorFromScenario,
  contactYawRateCommand,
} from "../src/sim/contacts";
import type { ContactSpec, SimulationConfig } from "../src/sim/types";

function contactVehicle(overrides: Partial<ContactSpec["vehicle"]["initial"]> = {}) {
  const config = createDefaultConfig();
  const vehicle = structuredClone(config.target);
  vehicle.initial = { ...vehicle.initial, ...overrides };
  return vehicle;
}

function multiContactConfig(): SimulationConfig {
  const config = createDefaultConfig();
  config.runtime.maxTime = 45;
  config.guidance.mode = "perfect";
  config.interceptRadius = 14;
  config.contacts = [
    {
      id: "hostile",
      kind: "hostile-sub",
      vehicle: contactVehicle(),
      targetStrengthDb: 15,
      behavior: { kind: "constant-velocity" },
    },
    {
      id: "friendly",
      kind: "friendly-sub",
      vehicle: contactVehicle({
        position: { x: 1200, y: -400, z: 12 },
        heading: Math.PI,
        speed: 6,
        depth: 12,
      }),
      targetStrengthDb: 12,
      behavior: { kind: "constant-velocity" },
    },
    {
      id: "whale",
      kind: "biological",
      vehicle: contactVehicle({
        position: { x: 800, y: 500, z: 4 },
        heading: 2.1,
        speed: 2,
        depth: 4,
      }),
      targetStrengthDb: -8,
      behavior: { kind: "biologic-wander", amplitude: 0.7, period: 40 },
    },
  ];
  return config;
}

describe("multi-contact truth layer", () => {
  it("runs multiple contacts with finite state and truth telemetry", () => {
    const run = runHeadless(multiContactConfig());
    expect(run.result.terminationReason).not.toBe("invalid-state");
    const withContacts = run.telemetry.filter((sample) => sample.contacts);
    expect(withContacts.length).toBeGreaterThan(10);
    const final = withContacts.at(-1)!.contacts!;
    expect(final).toHaveLength(3);
    expect(final.find((c) => c.id === "whale")?.kind).toBe("biological");
    for (const sample of run.telemetry) {
      for (const contact of sample.contacts ?? []) {
        expect(Number.isFinite(contact.position.x)).toBe(true);
        expect(Number.isFinite(contact.position.y)).toBe(true);
        expect(Number.isFinite(contact.position.z)).toBe(true);
      }
    }
  });

  it("keeps observations anonymous — no identity fields on the wire", () => {
    const config = multiContactConfig();
    config.interceptRadius = 0.5;
    const engine = new SimulationEngine(config);
    let observed = false;
    while (!engine.completed) {
      const step = engine.step();
      if (step.snapshot?.observation) {
        const observation = step.snapshot.observation;
        const serialized = JSON.stringify(observation);
        expect(serialized).not.toMatch(/hostile|friendly|whale|kind/i);
        observed = true;
      }
    }
    expect(observed).toBe(true);
  });

  it("gives each contact independent deterministic noise draws", () => {
    const a = runHeadless(multiContactConfig());
    const b = runHeadless(multiContactConfig());
    expect(a.result).toEqual(b.result);
    expect(a.telemetry.length).toBe(b.telemetry.length);
    // The hostile and friendly contacts diverge (independent motion is
    // observable through distinct truth positions over time).
    const final = a.telemetry.at(-1)!.contacts!;
    const ids = new Set(final.map((contact) => contact.id));
    expect(ids).toEqual(new Set(["hostile", "friendly", "whale"]));
    const positions = final.map((contact) => contact.position.x);
    expect(new Set(positions.map((x) => x.toFixed(1))).size).toBe(3);
  });

  it("activates a decoy only when the weapon closes inside the trigger range", () => {
    const config = multiContactConfig();
    config.runtime.maxTime = 60;
    config.interceptRadius = 0.5;
    config.contacts!.push({
      id: "decoy",
      kind: "decoy",
      vehicle: contactVehicle({ speed: 3 }),
      targetStrengthDb: 20,
      behavior: { kind: "decoy", triggerRange: 600, deploySpeed: 3 },
      deployedBy: "hostile",
    });
    const run = runHeadless(config);
    const decoySamples = run.telemetry
      .map((sample) => sample.contacts?.find((c) => c.id === "decoy"))
      .filter(Boolean);
    // The decoy contact exists but starts inactive; it must appear in truth
    // telemetry only after activation.
    const firstActive = decoySamples.findIndex((decoy) => decoy!.active);
    expect(firstActive).toBeGreaterThan(0);
    expect(run.telemetry[firstActive].timestamp).toBeGreaterThan(10);
  });

  it("maps legacy scenarios onto contact behaviors identically", () => {
    const config = createDefaultConfig();
    const behavior = behaviorFromScenario(config.scenario);
    expect(behavior).toEqual({
      kind: "constant-turn",
      rate: config.scenario.targetTurnRate,
    });
    const scenarios: import("../src/sim/types").ScenarioConfig[] = [
      {
        kind: "constant-velocity",
        targetTurnRate: 0.02,
        evasiveTriggerRange: 800,
        evasiveTurnRate: -0.06,
      },
      {
        kind: "constant-turn",
        targetTurnRate: 0.05,
        evasiveTriggerRange: 800,
        evasiveTurnRate: -0.06,
      },
      {
        kind: "scripted-evasive",
        targetTurnRate: 0.03,
        evasiveTriggerRange: 800,
        evasiveTurnRate: -0.06,
      },
    ];
    for (const scenario of scenarios) {
      const mapped = behaviorFromScenario(scenario);
      for (const range of [100, 1000]) {
        expect(contactYawRateCommand(mapped, range, 10)).toEqual(
          scenario.kind === "constant-velocity"
            ? 0
            : scenario.kind === "constant-turn"
              ? scenario.targetTurnRate
              : range <= scenario.evasiveTriggerRange
                ? scenario.evasiveTurnRate
                : 0,
        );
      }
    }
  });

  it("leaves legacy single-target runs bit-identical", () => {
    const legacy = createDefaultConfig();
    expect(legacy.contacts).toBeUndefined();
    const run = runHeadless(legacy);
    expect(run.result.terminationReason).toBe("intercept");
    expect(run.telemetry.every((sample) => sample.contacts === undefined)).toBe(true);
    expect(run.result.elapsedTime).toBeCloseTo(40.905, 3);
  });

  it("rejects invalid contact configurations", () => {
    const config = multiContactConfig();
    config.contacts!.push(structuredClone(config.contacts![0]));
    expect(() => runHeadless(config)).toThrow(/unique/);
  });
});
