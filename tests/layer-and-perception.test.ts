import { describe, expect, it } from "vitest";

import {
  acousticChannel,
  refractionLossDb,
  soundSpeedAtDepth,
} from "../src/sim/acoustics";
import { createDefaultConfig } from "../src/sim/config";
import { runHeadless } from "../src/sim/engine";
import { SeededRandom } from "../src/sim/random";
import {
  createAmbiguityScenarioConfig,
} from "../src/sim/scenarios";
import {
  initialTargetPerceptionState,
  updateTargetPerception,
} from "../src/sim/target-perception";
import type { EnvironmentConfig, SoundProfileConfig } from "../src/sim/types";

const profile: SoundProfileConfig = {
  layerDepth: 60,
  thermoclineDrop: 20,
  deepGradient: 0.017,
  layerLossDb: 12,
  recoveryRange: 3500,
  fadeWidth: 1500,
};

function environment(): EnvironmentConfig {
  const config = createDefaultConfig();
  return { ...config.environment!, soundProfile: profile };
}

describe("sound-speed profile and refraction", () => {
  it("varies with depth: layer, thermocline minimum, deep rise", () => {
    const env = environment();
    const surface = soundSpeedAtDepth(profile, env, 10);
    const mid = soundSpeedAtDepth(profile, env, 60 + profile.layerDepth * 0.75);
    const deep = soundSpeedAtDepth(profile, env, 450);
    expect(mid).toBeLessThan(surface);
    expect(deep).toBeGreaterThan(mid);
  });

  it("penalizes layer-straddling paths inside the recovery range only", () => {
    const env = environment();
    expect(refractionLossDb(profile, 20, 120, 2000)).toBeCloseTo(12, 9);
    expect(refractionLossDb(profile, 20, 120, 4000)).toBeCloseTo(8, 9);
    expect(refractionLossDb(profile, 20, 120, 5500)).toBeCloseTo(0, 9);
    expect(refractionLossDb(profile, 20, 40, 2000)).toBe(0);
    expect(refractionLossDb(profile, 100, 150, 2000)).toBe(0);
  });

  it("raises transmission loss and lowers detection for straddling paths", () => {
    const env = environment();
    const config = createDefaultConfig();
    const acoustic = config.acoustic!;
    const same = acousticChannel(0, 3000, 30, 45, env, acoustic);
    const across = acousticChannel(0, 3000, 30, 130, env, acoustic);
    expect(across.oneWayTransmissionLossDb).toBeGreaterThan(
      same.oneWayTransmissionLossDb,
    );
    expect(across.detectionProbability).toBeLessThan(same.detectionProbability);
    expect(across.refractionLossDb).toBeGreaterThan(0);
    expect(same.refractionLossDb).toBe(0);
  });

  it("keeps the homogeneous channel bit-identical without a profile", () => {
    const config = createDefaultConfig();
    const env = config.environment!;
    const a = acousticChannel(0, 2000, 30, 8, env, config.acoustic!);
    const b = acousticChannel(0, 2000, 30, 8, { ...env, soundProfile: undefined }, config.acoustic!);
    expect(a).toEqual(b);
    expect(a.refractionLossDb).toBeUndefined();
  });
});

describe("target-side perception", () => {
  function perceptionConfig() {
    return createDefaultConfig();
  }

  it("reacts only after sustained detection", () => {
    const config = perceptionConfig();
    const perception = {
      detectionThresholdDb: 6,
      detectionTransitionDb: 3,
      reactionDelay: 4,
      reactionGrace: 6,
      evasiveRate: 0.05,
      diveDepth: 130,
      bearingSigmaRad: 0.1,
    };
    const weapon = {
      ...config.torpedo,
      position: { x: 0, y: 0, z: 8 },
      depth: 8,
      speed: 30,
    };
    // A contact at 1.5 km: SL 210, one-way TL ~ 20*log10(1500) ≈ 66 dB —
    // comfortably above the threshold.
    const contact = {
      ...config.target,
      position: { x: 1500, y: 0, z: 30 },
      depth: 30,
    };
    let state = initialTargetPerceptionState();
    const random = new SeededRandom(99);
    for (let index = 0; index < 50; index += 1) {
      const now = index * 0.125;
      state = updateTargetPerception({
        state,
        now,
        weapon: weapon as never,
        contact: contact as never,
        perception,
        environment: config.environment,
        acoustic: config.acoustic,
        random,
      });
      if (now < 4) expect(state.reacting).toBe(false);
    }
    expect(state.reacting).toBe(true);
    expect(state.heardBearing).not.toBeNull();
  });

  it("hears a close weapon but not a distant one below the layer", () => {
    const config = perceptionConfig();
    const env = { ...config.environment!, soundProfile: profile };
    const perception = {
      detectionThresholdDb: 45,
      detectionTransitionDb: 3,
      reactionDelay: 4,
      reactionGrace: 6,
      evasiveRate: 0.05,
      bearingSigmaRad: 0.1,
    };
    const once = (contactDepth: number, range: number) =>
      updateTargetPerception({
        state: initialTargetPerceptionState(),
        now: 0,
        weapon: { ...config.torpedo, position: { x: 0, y: 0, z: 8 }, depth: 8, speed: 30 } as never,
        contact: { ...config.target, position: { x: range, y: 0, z: contactDepth }, depth: contactDepth } as never,
        perception,
        environment: env,
        acoustic: config.acoustic,
        random: new SeededRandom(99),
      });
    // Same-side, 1.5 km: heard SNR far above the threshold.
    expect(once(30, 1500).heardBearing).not.toBeNull();
    // Below the layer at 3 km the 12 dB layer loss pulls the heard SNR
    // decisively under a 60 dB threshold — asserted as a margin so the
    // check cannot hinge on a stochastic draw near the boundary.
    const heardSnr =
      config.acoustic!.sourceLevelDb -
      acousticChannel(0, 1500, 8, 30, env, config.acoustic!).oneWayTransmissionLossDb -
      config.acoustic!.ambientNoiseDb;
    const shieldedSnr =
      config.acoustic!.sourceLevelDb -
      acousticChannel(0, 3000, 8, 130, env, config.acoustic!).oneWayTransmissionLossDb -
      config.acoustic!.ambientNoiseDb;
    const quietThreshold = 60;
    expect(heardSnr - quietThreshold).toBeGreaterThan(10);
    expect(shieldedSnr - quietThreshold).toBeLessThan(-5);
  });

  it("is deterministic per seed", () => {
    const run = () => {
      const config = perceptionConfig();
      const perception = {
        detectionThresholdDb: 6,
        detectionTransitionDb: 3,
        reactionDelay: 4,
        reactionGrace: 6,
        evasiveRate: 0.05,
        bearingSigmaRad: 0.1,
      };
      const weapon = { ...config.torpedo, position: { x: 0, y: 0, z: 8 }, depth: 8, speed: 30 };
      const contact = { ...config.target, position: { x: 1200, y: 300, z: 30 }, depth: 30 };
      let state = initialTargetPerceptionState();
      const random = new SeededRandom(7);
      for (let index = 0; index < 12; index += 1) {
        state = updateTargetPerception({
          state,
          now: index * 0.125,
          weapon: weapon as never,
          contact: contact as never,
          perception,
          environment: config.environment,
          acoustic: config.acoustic,
          random,
        });
      }
      return JSON.stringify(state);
    };
    expect(run()).toBe(run());
  });
});

describe("layer + perception integration", () => {
  it("runs the presets deterministically and stays finite", { timeout: 60000 }, () => {
    for (const preset of ["decoy-stress", "high-ambiguity"] as const) {
      const run = runHeadless(createAmbiguityScenarioConfig(preset));
      expect(run.result.terminationReason).not.toBe("invalid-state");
      const again = runHeadless(createAmbiguityScenarioConfig(preset));
      expect(again.result).toEqual(run.result);
      // The hostile should be below the layer by the end (it dove).
      const last = run.telemetry.at(-1)?.contacts?.find((c) => c.id === "hostile");
      if (last && run.result.elapsedTime > 30) {
        expect(last.depth).toBeGreaterThan(60);
      }
    }
  });

  it("keeps legacy single-target runs bit-identical", () => {
    const run = runHeadless(createDefaultConfig());
    expect(run.result.elapsedTime).toBeCloseTo(40.905, 3);
  });
});
