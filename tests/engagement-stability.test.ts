import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/sim/config";
import { runHeadless } from "../src/sim/engine";
import { defaultDoctrine } from "../src/sim/tewa";
import type { SimulationConfig } from "../src/sim/types";

function config(mode: "manual" | "autonomous"): SimulationConfig {
  const base = createDefaultConfig();
  base.runtime.maxTime = 115;
  base.guidance.mode = "ekf";
  base.interceptRadius = 14;
  base.torpedo.commandedSpeed = 30;
  base.doctrine = { ...defaultDoctrine(), mode };
  base.weapon = {
    phases: { enableTime: 4, terminalRange: 500, reacquireAfter: 3 },
    speed: { cruiseSpeed: 30, sprintSpeed: 40 },
    endurance: { runTime: 110 },
    terminalSensor: { cadenceHz: 20, innovationGate: 9, fovHalfAngle: (80 * Math.PI) / 180 },
    fuze: { detectionRadius: 25 },
    effectiveness: { lethalRadius: 14, shape: 2 },
  };
  const vehicle = (x: number, y: number, heading: number, speed: number, depth: number) => {
    const v = structuredClone(base.target);
    v.initial = { position: { x, y, z: depth }, heading, speed, depth };
    v.commandedSpeed = speed;
    return v;
  };
  // Two sub-like contacts that pass near each other: pairing must not flap.
  base.contacts = [
    {
      id: "hostile",
      kind: "hostile-sub",
      vehicle: vehicle(2000, 650, Math.PI - 0.35, 6, 30),
      targetStrengthDb: 15,
      behavior: { kind: "scripted-evasive", triggerRange: 700, rate: -0.05 },
    },
    {
      id: "nearby",
      kind: "ambiguous",
      vehicle: vehicle(2100, 550, Math.PI - 0.2, 6, 28),
      targetStrengthDb: 13,
      echoFluctuation: { amplitudeDb: 9, period: 12 },
      behavior: { kind: "constant-velocity" },
    },
  ];
  return base;
}

describe("engagement stability", () => {
  it("keeps the paired truth target continuous — no frame-to-frame flapping", { timeout: 60000 }, () => {
    const run = runHeadless(config("autonomous"));
    let flaps = 0;
    let jumps = 0;
    for (let index = 1; index < run.telemetry.length; index += 1) {
      const a = run.telemetry[index - 1].target.position;
      const b = run.telemetry[index].target.position;
      const jump = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (jump > 10) {
        jumps += 1;
        // A pairing change at a redesignation is a single-step event; two
        // consecutive large jumps would be frame-to-frame flapping.
        const c = run.telemetry[index + 1]?.target.position;
        if (c) {
          const next = Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z);
          if (next > 10) flaps += 1;
        }
      }
    }
    expect(flaps).toBe(0);
    expect(jumps).toBeLessThan(6);
  });

  it("holds an orbit standoff under hold-fire instead of running through", { timeout: 60000 }, () => {
    const run = runHeadless(config("manual"));
    expect(run.result.terminationReason).toBe("endurance-exhausted");
    expect(run.result.engagementOutcome).toBe("miss");
    // Bounded patrol: never runs off, and the heading excursions of the
    // orbit (not a straight line) are visible over the run.
    const positions = run.telemetry.map((sample) =>
      Math.hypot(sample.torpedo.position.x, sample.torpedo.position.y),
    );
    expect(Math.max(...positions)).toBeLessThan(3200);
    let excursion = 0;
    for (let index = 1; index < run.telemetry.length; index += 1) {
      excursion += Math.abs(
        run.telemetry[index].torpedo.heading -
          run.telemetry[index - 1].torpedo.heading,
      );
    }
    expect(excursion).toBeGreaterThan(0.5);
    // The orbit keeps the contact group in view: the range eventually
    // comes inside the standoff envelope.
    const ranges = run.telemetry.map((sample) => sample.metrics.range);
    expect(Math.min(...ranges)).toBeLessThan(1800);
  });

  it("still completes the autonomous engagement on the hostile", { timeout: 60000 }, () => {
    const run = runHeadless(config("autonomous"));
    expect(run.result.engagementOutcome).toBe("correct-hostile");
  });
});
