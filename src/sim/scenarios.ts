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
  config.runtime.maxTime = 120;
  config.guidance.mode = "ekf";
  config.interceptRadius = 14;
  config.torpedo.commandedSpeed = 30;
  // Speed-dependent self-noise: sprinting degrades the weapon's own
  // receiver. Synthetic values.
  config.sensor.selfNoise = { baseDb: 52, dbPerMs: 0.55 };
  config.doctrine = defaultDoctrine();
  config.weapon = {
    phases: { enableTime: 4, terminalRange: 500, reacquireAfter: 3 },
    speed: { cruiseSpeed: 30, sprintSpeed: 40 },
    endurance: {
      battery: { capacityWs: 3.2e6, hotelW: 200, dragKW: 0.8 },
    },
    terminalSensor: { cadenceHz: 20, innovationGate: 9, fovHalfAngle: (80 * Math.PI) / 180 },
    fuze: { detectionRadius: 25 },
    effectiveness: { lethalRadius: 14, shape: 2 },
  };
  const vehicle = contactVehicle.bind(null, config.target);

  const hostile = (heading: number, speed = 6): ContactSpec => ({
    id: "hostile",
    kind: "hostile-sub",
    vehicle: vehicle(2000, 650, heading, speed, 30),
    aspectEcho: { bowDb: 8, beamDb: 19 },
    behavior: { kind: "scripted-evasive", triggerRange: 700, rate: -0.05 },
  });

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
          behavior: { kind: "constant-velocity" },
        },
        {
          id: "whale",
          kind: "biological",
          vehicle: vehicle(900, 900, 2.4, 1.6, 4),
          targetStrengthDb: -8,
          behavior: { kind: "biologic-wander", amplitude: 0.8, period: 35 },
        },
        {
          id: "whale-2",
          kind: "biological",
          vehicle: vehicle(1400, 1100, -2.2, 1.3, 6),
          targetStrengthDb: -9,
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
          behavior: { kind: "decoy", triggerRange: 650, deploySpeed: 4, headingOffset: 0.5 },
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
          behavior: { kind: "constant-velocity" },
        },
      ];
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
          behavior: { kind: "constant-velocity" },
          friendlySignature: 0.9,
        },
        {
          id: "whale",
          kind: "biological",
          vehicle: vehicle(900, 900, 2.4, 1.6, 4),
          targetStrengthDb: -8,
          behavior: { kind: "biologic-wander", amplitude: 0.8, period: 35 },
        },
        {
          id: "freighter",
          kind: "commercial-surface",
          vehicle: vehicle(600, -1500, 1.2, 12, 0.5),
          targetStrengthDb: 22,
          behavior: { kind: "constant-velocity" },
        },
        {
          id: "fluctuator",
          kind: "ambiguous",
          vehicle: vehicle(1700, 200, Math.PI - 0.2, 4, 20),
          targetStrengthDb: 9,
          echoFluctuation: { amplitudeDb: 9, period: 12 },
          behavior: { kind: "constant-velocity" },
        },
        {
          id: "decoy",
          kind: "decoy",
          vehicle: vehicle(2000, 650, Math.PI - 0.35, 4, 30),
          targetStrengthDb: 21,
          behavior: { kind: "decoy", triggerRange: 650, deploySpeed: 4, headingOffset: 0.5 },
          deployedBy: "hostile",
        },
      ];
      return config;
    }
  }
}
