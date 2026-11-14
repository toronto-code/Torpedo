import { createDefaultConfig } from "./config";
import { defaultDoctrine } from "./tewa";
import type { ContactSpec, SimulationConfig, VehicleConfig } from "./types";

/**
 * Shipped multi-contact ambiguity presets. Every preset is deterministic
 * per seed and exercises a specific confusion source in the
 * detect → track → classify → select → authorize chain. All parameters are
 * synthetic and fictional.
 */

export type AmbiguityPreset =
  | "crossing-subs"
  | "cluttered-approach"
  | "decoy-stress"
  | "ambiguous-fluctuator"
  | "silent-approach"
  | "high-ambiguity";

function contactVehicle(
  base: VehicleConfig,
  x: number,
  y: number,
  heading: number,
  speed: number,
  depth: number,
): VehicleConfig {
  const vehicle = structuredClone(base);
  vehicle.initial = {
    position: { x, y, z: depth },
    heading,
    speed,
    depth,
  };
  vehicle.commandedSpeed = speed;
  vehicle.commandedDepth = depth;
  return vehicle;
}

export function createAmbiguityScenarioConfig(
  preset: AmbiguityPreset,
  seed = 20260814,
): SimulationConfig {
  const config = createDefaultConfig();
  config.seed = seed;
  config.runtime.maxTime = 200;
  config.guidance.mode = "ekf";
  config.interceptRadius = 14;
  config.torpedo.commandedSpeed = 30;
  // Speed-dependent self-noise: sprinting degrades the weapon's own
  // receiver. Synthetic values.
  config.sensor.selfNoise = { baseDb: 52, dbPerMs: 0.55 };
  // Depression-angle depth reporting so the weapon can dive with a contact
  // that goes below the layer. Synthetic noise level.
  config.sensor.depthSigmaM = 8;
  // Maneuver adaptation: an evading contact momentarily inflates the
  // process noise instead of failing the innovation gate.
  config.estimator.maneuverNoiseScale = 12;
  // Depth-dependent sound speed with a mid-range shadow band when the
  // weapon and contact straddle the layer. Synthetic values.
  config.environment = config.environment ?? createDefaultConfig().environment!;
  config.environment.soundProfile = {
    layerDepth: 60,
    thermoclineDrop: 20,
    deepGradient: 0.017,
    layerLossDb: 12,
    recoveryRange: 3500,
    fadeWidth: 1500,
  };
  config.doctrine = defaultDoctrine();
  // Picture-development window: no autonomous authorization on a track
  // younger than 20 s, so classification evidence (dive behavior, echo
  // stability) matures before the weapon commits.
  config.doctrine.minTrackAgeS = 20;
  config.weapon = {
    phases: { enableTime: 4, terminalRange: 500, reacquireAfter: 3 },
    speed: { cruiseSpeed: 30, sprintSpeed: 40, searchSpeed: 18 },
    endurance: {
      // Heavyweight-class synthetic battery: ~6 min cruise / ~2.5 min
      // sprint, so a 2 km transit plus terminal sprint fits comfortably.
      battery: { capacityWs: 8.5e6, hotelW: 200, dragKW: 0.8 },
    },
    terminalSensor: { cadenceHz: 20, innovationGate: 9, fovHalfAngle: (80 * Math.PI) / 180 },
    fuze: { detectionRadius: 25, minTargetSpeedMs: 2.5 },
    effectiveness: { lethalRadius: 14, shape: 2 },
  };
  const vehicle = contactVehicle.bind(null, config.target);

  const hostile = (heading: number, speed = 6): ContactSpec => {
    // The hostile needs real depth authority to dive below the layer.
    const hostileVehicle = vehicle(2000, 650, heading, speed, 30);
    hostileVehicle.parameters = {
      ...hostileVehicle.parameters,
      maxDepthRate: 1.5,
      maxDepthAcceleration: 0.5,
      depthResponseTime: 3,
    };
    return {
    id: "hostile",
    kind: "hostile-sub",
    vehicle: hostileVehicle,
    aspectEcho: { bowDb: 8, beamDb: 19 },
    // Quiet nuclear-ish plant: audible on passive at close range, faint
    // once the weapon sprints (self-noise deafens the passive band).
    radiatedNoiseDb: 132,
    behavior: { kind: "scripted-evasive", triggerRange: 700, rate: -0.05 },
    // Truth-side threat perception: hears the weapon's pings, then evades
    // and dives below the layer — shielding itself acoustically both ways.
    perception: {
      detectionThresholdDb: 45,
      detectionTransitionDb: 3,
      reactionDelay: 4,
      reactionGrace: 6,
      evasiveRate: 0.05,
      diveDepth: 130,
      bearingSigmaRad: 0.1,
    },
    };
  };

  switch (preset) {
    case "crossing-subs": {
      // Two sub-like contacts on crossing courses plus a friend: the
      // association layer is the stress target.
      config.contacts = [
        { ...hostile(Math.PI - 0.35), id: "hostile" },
        {
          id: "unknown-sub",
          kind: "ambiguous",
          vehicle: vehicle(-400, 1400, 0.35, 7, 28),
          targetStrengthDb: 13,
          behavior: { kind: "constant-velocity" },
        },
        {
          id: "friendly",
          kind: "friendly-sub",
          vehicle: vehicle(1600, -700, Math.PI, 5, 25),
          aspectEcho: { bowDb: 7, beamDb: 17 },
          radiatedNoiseDb: 135,
          behavior: { kind: "constant-velocity" },
          friendlySignature: 0.9,
        },
      ];
      return config;
    }
    case "cluttered-approach": {
      // Commercial traffic overhead and biologics in the path: the
      // classification layer is the stress target.
      config.contacts = [
        hostile(Math.PI - 0.35),
        {
          id: "freighter",
          kind: "commercial-surface",
          vehicle: vehicle(600, -1500, 1.2, 12, 0.5),
          targetStrengthDb: 22,
          radiatedNoiseDb: 165,
          behavior: { kind: "constant-velocity" },
        },
        {
          id: "whale",
          kind: "biological",
          vehicle: vehicle(900, 900, 2.4, 1.6, 4),
          targetStrengthDb: -8,
          radiatedNoiseDb: 148,
          behavior: { kind: "biologic-wander", amplitude: 0.8, period: 35 },
        },
        {
          id: "whale-2",
          kind: "biological",
          vehicle: vehicle(1400, 1100, -2.2, 1.3, 6),
          targetStrengthDb: -9,
          radiatedNoiseDb: 146,
          behavior: { kind: "biologic-wander", amplitude: 0.6, period: 45 },
        },
      ];
      return config;
    }
    case "decoy-stress": {
      // Decoy deployment on terminal approach: seduction stress.
      config.contacts = [
        hostile(Math.PI - 0.35),
        {
          id: "decoy",
          kind: "decoy",
          vehicle: vehicle(2000, 650, Math.PI - 0.35, 4, 30),
          targetStrengthDb: 21,
          radiatedNoiseDb: 112,
          behavior: { kind: "decoy", triggerRange: 650, deploySpeed: 4, headingOffset: 0.5 },
          deployedBy: "hostile",
        },
        {
          // The classic layered terminal defense: decoy first, then the
          // knuckle — a hard-turn turbulence cloud inside 500 m that
          // presents a loud fresh echo and fades over ~80 s.
          id: "knuckle",
          kind: "knuckle",
          vehicle: vehicle(2000, 650, Math.PI - 0.35, 0, 30),
          targetStrengthDb: 18,
          behavior: { kind: "knuckle", triggerRange: 420, driftSpeed: 1.5, fadeDbPerS: 1.2 },
          deployedBy: "hostile",
        },
      ];
      return config;
    }
    case "ambiguous-fluctuator": {
      // An intermittent, fluctuating echo straddling class boundaries:
      // confidence and hold-fire stress.
      config.contacts = [
        hostile(Math.PI - 0.35),
        {
          id: "fluctuator",
          kind: "ambiguous",
          vehicle: vehicle(1700, 200, Math.PI - 0.2, 4, 20),
          targetStrengthDb: 9,
          echoFluctuation: { amplitudeDb: 9, period: 12 },
          radiatedNoiseDb: 128,
          behavior: { kind: "constant-velocity" },
        },
      ];
      return config;
    }
    case "silent-approach": {
      // Bearings-only TMA: the weapon runs a silent passive midcourse —
      // the target hears nothing until terminal activation — and the
      // doctrine refuses to authorize until the solution has converged.
      // One sub among the noise-makers: this preset isolates the TMA
      // mechanic (crossing-sub ambiguity is the crossing-subs preset).
      config.contacts = [
        hostile(Math.PI - 0.35),
        {
          id: "freighter",
          kind: "commercial-surface",
          vehicle: vehicle(600, -1500, 1.2, 12, 0.5),
          targetStrengthDb: 22,
          radiatedNoiseDb: 165,
          behavior: { kind: "constant-velocity" },
        },
        {
          id: "whale",
          kind: "biological",
          vehicle: vehicle(900, 900, 2.4, 1.6, 4),
          targetStrengthDb: -8,
          radiatedNoiseDb: 148,
          behavior: { kind: "biologic-wander", amplitude: 0.8, period: 35 },
        },
      ];
      // Bearing-only tracking assumes benign motion between own-ship legs;
      // the maneuver adapter covers the late evasion.
      config.estimator.accelerationNoise = 0.3;
      config.weapon!.sensorPolicy = "passive-midcourse";
      // A sprinting heavyweight is audible for kilometres; quiet search
      // speed (18 m/s) stays below the hostile's counter-detection.
      config.weapon!.radiatedNoise = { baseDb: 130, dbPerMs: 0.8 };
      config.doctrine!.maxSolutionSigmaM = 700;
      config.doctrine!.postAuthDesignationAgeS = 5;
      // Passive pictures move slowly: hold the designation through score
      // seesaw (a challenger needs 3x), and age the track faster than the
      // active presets since passive evidence accumulates continuously.
      config.doctrine!.redesignateMargin = 3;
      config.doctrine!.minTrackAgeS = 12;
      // Passive classification is honestly weaker (no echo, no TS feature,
      // no IFF marking): the solution gate carries the safety burden here.
      config.doctrine!.requiredConfidence = 0.45;
      return config;
    }
    case "high-ambiguity":
    default: {
      // Combined preset and the default interactive scenario.
      config.contacts = [
        hostile(Math.PI - 0.35),
        {
          id: "friendly",
          kind: "friendly-sub",
          vehicle: vehicle(1600, -700, Math.PI, 5, 25),
          aspectEcho: { bowDb: 7, beamDb: 17 },
          radiatedNoiseDb: 135,
          behavior: { kind: "constant-velocity" },
          friendlySignature: 0.9,
        },
        {
          id: "whale",
          kind: "biological",
          vehicle: vehicle(900, 900, 2.4, 1.6, 4),
          targetStrengthDb: -8,
          radiatedNoiseDb: 148,
          behavior: { kind: "biologic-wander", amplitude: 0.8, period: 35 },
        },
        {
          id: "freighter",
          kind: "commercial-surface",
          vehicle: vehicle(600, -1500, 1.2, 12, 0.5),
          targetStrengthDb: 22,
          radiatedNoiseDb: 165,
          behavior: { kind: "constant-velocity" },
        },
        {
          id: "fluctuator",
          kind: "ambiguous",
          vehicle: vehicle(1700, 200, Math.PI - 0.2, 4, 20),
          targetStrengthDb: 9,
          echoFluctuation: { amplitudeDb: 9, period: 12 },
          radiatedNoiseDb: 128,
          behavior: { kind: "constant-velocity" },
        },
        {
          id: "decoy",
          kind: "decoy",
          vehicle: vehicle(2000, 650, Math.PI - 0.35, 4, 30),
          targetStrengthDb: 21,
          radiatedNoiseDb: 112,
          behavior: { kind: "decoy", triggerRange: 650, deploySpeed: 4, headingOffset: 0.5 },
          deployedBy: "hostile",
        },
      ];
      return config;
    }
  }
}
