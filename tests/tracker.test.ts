import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/sim/config";
import { runHeadless } from "../src/sim/engine";
import { defaultDoctrine } from "../src/sim/tewa";
import { MultiTargetTracker } from "../src/sim/tracker";
import type { SensorObservation } from "../src/sim/types";
import { wrapAngle } from "../src/sim/math";

function observation(overrides: Partial<SensorObservation>): SensorObservation {
  return {
    id: 0,
    observedAt: 0,
    deliveredAt: 0.1,
    bearing: 0,
    range: 1000,
    bearingVariance: 0.001,
    rangeVariance: 64,
    sensorPosition: { x: 0, y: 0 },
    sensorHeading: 0,
    ...overrides,
  };
}

function trackerOptions() {
  const config = createDefaultConfig();
  return {
    estimator: config.estimator,
    confirmationCount: 3,
    tentativeTimeout: 4,
    deletionTimeout: 10,
  };
}

describe("multi-target tracker", () => {
  it("associates well-separated contacts to distinct stable tracks", { timeout: 60000 }, () => {
    const tracker = new MultiTargetTracker(trackerOptions(), "ekf");
    // Contact A: north, 1000 m, slowly opening. Contact B: 90 deg, 1500 m.
    for (let index = 0; index < 10; index += 1) {
      const t = index * 0.125;
      const a = observation({
        observedAt: t,
        deliveredAt: t + 0.1,
        bearing: 0,
        range: 1000 + 6 * t,
      });
      const b = observation({
        observedAt: t,
        deliveredAt: t + 0.12,
        bearing: Math.PI / 2,
        range: 1500 - 4 * t,
      });
      const ra = tracker.process(t + 0.12, a);
      const rb = tracker.process(t + 0.12, b);
      if (index > 0) {
        expect(ra.trackId).not.toBe(rb.trackId);
      }
    }
    tracker.prune(1.25);
    const tracks = tracker.liveTracks(1.25);
    expect(tracks).toHaveLength(2);
    expect(tracks.every((track) => track.meta.quality === "confirmed")).toBe(true);
    // Estimates localize near truth.
    const north = tracks.find((track) =>
      Math.abs(wrapAngle(track.estimate.position.x > 0 ? 0 : Math.PI)) < 1.9,
    );
    expect(Math.abs((north?.estimate.position.x ?? 0) - 1006)).toBeLessThan(60);
  });

  it("initiates a new track for a return far from every gate", { timeout: 60000 }, () => {
    const tracker = new MultiTargetTracker(trackerOptions(), "ekf");
    for (let index = 0; index < 6; index += 1) {
      tracker.process(
        index * 0.125 + 0.1,
        observation({
          observedAt: index * 0.125,
          deliveredAt: index * 0.125 + 0.1,
          bearing: 0.3,
          range: 900,
        }),
      );
    }
    const stray = tracker.process(
      0.85,
      observation({
        observedAt: 0.75,
        deliveredAt: 0.85,
        bearing: -1.2,
        range: 200,
      }),
    );
    expect(stray.distance).toBeNull();
    expect(tracker.liveTracks(0.85)).toHaveLength(2);
  });

  it("ages tracks: tentative deletion, coasting, and full deletion", { timeout: 60000 }, () => {
    const tracker = new MultiTargetTracker(
      { ...trackerOptions(), tentativeTimeout: 2, deletionTimeout: 8 },
      "ekf",
    );
    // One tentative-only track (single observation).
    tracker.process(0.1, observation({ observedAt: 0, deliveredAt: 0.1 }));
    // One confirmed track.
    for (let index = 0; index < 4; index += 1) {
      tracker.process(
        index * 0.125 + 0.1,
        observation({
          observedAt: index * 0.125,
          deliveredAt: index * 0.125 + 0.1,
          bearing: -0.6,
          range: 1200,
        }),
      );
    }
    tracker.prune(1);
    const at1 = tracker.liveTracks(1);
    expect(at1).toHaveLength(2);
    expect(
      at1.find((track) => track.meta.acceptedCount >= 4)?.meta.quality,
    ).toBe("confirmed");
    tracker.prune(3);
    const at3 = tracker.liveTracks(3);
    expect(at3).toHaveLength(1);
    // No updates for ~2.5 s exceeds staleness + delivery delay: coasting.
    expect(at3[0].meta.quality).toBe("coasting");
    tracker.prune(10);
    expect(tracker.liveTracks(10).every((t) => t.meta.quality !== "deleted")).toBe(true);
    tracker.prune(12);
    expect(tracker.liveTracks(12)).toHaveLength(0);
  });

  it("is deterministic for identical observation streams", { timeout: 60000 }, () => {
    const run = () => {
      const tracker = new MultiTargetTracker(trackerOptions(), "ekf");
      for (let index = 0; index < 8; index += 1) {
        const t = index * 0.125;
        tracker.process(
          t + 0.1,
          observation({ observedAt: t, deliveredAt: t + 0.1, bearing: 0.1 * index, range: 1000 }),
        );
      }
      return JSON.stringify(tracker.liveTracks(1));
    };
    expect(run()).toBe(run());
  });
});

describe("multi-contact engine integration with tracking", () => {
  function multiConfig(mode: "ekf" | "raw") {
    const config = createDefaultConfig();
    config.runtime.maxTime = 90;
    // Authorization-free doctrine: this suite tests tracking, not TEWA timing.
    config.doctrine = { ...defaultDoctrine(), requiredConfidence: 0.01, autoAuthorizeSustain: 0 };
    config.guidance.mode = mode;
    config.interceptRadius = 14;
    const vehicle = (x: number, y: number, heading: number, speed: number, depth: number) => {
      const base = structuredClone(config.target);
      base.initial = {
        position: { x, y, z: depth },
        heading,
        speed,
        depth,
      };
      base.commandedSpeed = speed;
      return base;
    };
    config.contacts = [
      {
        id: "hostile",
        kind: "hostile-sub",
        vehicle: vehicle(2000, 650, Math.PI - 0.35, 6, 30),
        targetStrengthDb: 15,
        behavior: { kind: "constant-velocity" },
      },
      {
        id: "friendly",
        kind: "friendly-sub",
        vehicle: vehicle(1200, -400, Math.PI, 6, 12),
        targetStrengthDb: 12,
        behavior: { kind: "constant-velocity" },
      },
    ];
    return config;
  }

  it("runs to completion in ekf and raw modes without OOSM or invalid state", { timeout: 60000 }, () => {
    for (const mode of ["ekf", "raw"] as const) {
      const run = runHeadless(multiConfig(mode));
      expect(run.result.terminationReason).not.toBe("invalid-state");
      expect(run.result.observationsAccepted).toBeGreaterThan(10);
      // Guidance homes on the tracked picture and closes the range.
      expect(run.result.closestApproach).toBeLessThan(500);
    }
  });

  it("produces identical results for identical seeds", { timeout: 60000 }, () => {
    const a = runHeadless(multiConfig("ekf"));
    const b = runHeadless(multiConfig("ekf"));
    expect(a.result).toEqual(b.result);
  });
});
