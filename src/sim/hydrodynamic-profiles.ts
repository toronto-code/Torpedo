import type { SimulationConfig, SixDofParameters } from "./types";

export type HydrodynamicProfileId = "generic-fictional" | "bluerov2-heavy-2024";

export interface HydrodynamicProfile {
  id: HydrodynamicProfileId;
  label: string;
  basis: string;
  parameters: SixDofParameters;
}

const degrees = (value: number) => (value * Math.PI) / 180;

const genericFictional: SixDofParameters = {
  actuationModel: "control-surfaces",
  mass: 1_550,
  displacedMass: 1_550,
  inertia: { x: 1_100, y: 9_200, z: 9_200 },
  addedMass: { x: 180, y: 1_250, z: 1_250 },
  addedInertia: { x: 420, y: 2_800, z: 2_800 },
  linearDamping: { x: 55, y: 900, z: 900 },
  quadraticDamping: { x: 13.5, y: 310, z: 310 },
  angularLinearDamping: { x: 2_400, y: 5_800, z: 25_000 },
  angularQuadraticDamping: { x: 1_100, y: 8_500, z: 8_500 },
  centerOfBuoyancy: { x: 0, y: 0.12, z: 0 },
  maxControlSurfaceAngle: degrees(24),
  controlSurfaceTimeConstant: 0.18,
  propulsionTimeConstant: 1.1,
  maximumThrust: 40_000,
  speedControllerGain: 2_400,
  rudderForceCoefficient: 2.4,
  elevatorForceCoefficient: 5,
  controlMomentArm: 1,
  yawControllerGain: 2.8,
  depthControllerGain: 0.02,
};

// Civilian BlueROV2 Heavy reference set. Mass, inertia, added-mass, and damping
// values are transcribed from Patrick Ng's 2024 public MS thesis, Table 4.1.
// Axes are mapped into this simulator's x=surge, y=heave, z=sway convention.
const blueRov2Heavy2024: SixDofParameters = {
  actuationModel: "vectored-thrust",
  mass: 11.5,
  displacedMass: 11.5 + 6.675 / 9.80665,
  inertia: { x: 0.8571, y: 1, z: 1 },
  addedMass: { x: 10.77, y: (34.6 + 22.45) / 2, z: 24.86 },
  addedInertia: { x: 0.103, y: 0.12, z: 0.12 },
  linearDamping: { x: 38.95, y: (49.5 + 50.62) / 2, z: 60.11 },
  quadraticDamping: { x: 31.01, y: (113.86 + 76.69) / 2, z: 36.95 },
  angularLinearDamping: { x: 0, y: 0, z: 0 },
  angularQuadraticDamping: { x: 2.08, y: 2.42, z: 2.42 },
  centerOfBuoyancy: { x: 0, y: 0.028, z: 0 },
  maxControlSurfaceAngle: 1,
  controlSurfaceTimeConstant: 0.12,
  propulsionTimeConstant: 0.2,
  maximumThrust: 9 * 9.80665,
  maximumVerticalThrust: 14 * 9.80665,
  maximumYawMoment: 17.65,
  speedControllerGain: 60,
  rudderForceCoefficient: 0,
  elevatorForceCoefficient: 0,
  controlMomentArm: 0.2,
  yawControllerGain: 1.6,
  depthControllerGain: 1.2,
};

export const HYDRODYNAMIC_PROFILES: Record<HydrodynamicProfileId, HydrodynamicProfile> = {
  "generic-fictional": {
    id: "generic-fictional",
    label: "Generic high-speed model",
    basis: "Synthetic diagonal coefficients",
    parameters: genericFictional,
  },
  "bluerov2-heavy-2024": {
    id: "bluerov2-heavy-2024",
    label: "BlueROV2 Heavy · 2024 civilian reference",
    basis: "Ng 2024 Table 4.1 plus published Blue Robotics thrust limits",
    parameters: blueRov2Heavy2024,
  },
};

function applyCivilianScenario(config: SimulationConfig): void {
  config.dynamics.model = "six-dof";
  config.runtime.maxTime = 120;
  config.torpedo.initial = {
    position: { x: 0, y: -20, z: 0 },
    heading: degrees(12),
    speed: 0.7,
    depth: 20,
  };
  config.torpedo.parameters = {
    maxSpeed: 1.55,
    maxAcceleration: 0.8,
    maxDeceleration: 1,
    speedResponseTime: 1.2,
    maxTurnRate: degrees(45),
    maxTurnAcceleration: degrees(90),
    turnResponseTime: 0.35,
    maxDepthRate: 0.7,
    maxDepthAcceleration: 0.7,
    depthResponseTime: 0.7,
  };
  config.torpedo.commandedSpeed = 1.2;
  config.torpedo.commandedDepth = 15;
  config.target.initial = {
    position: { x: 75, y: -15, z: 24 },
    heading: degrees(155),
    speed: 0.35,
    depth: 15,
  };
  config.target.parameters = {
    maxSpeed: 0.7,
    maxAcceleration: 0.15,
    maxDeceleration: 0.2,
    speedResponseTime: 5,
    maxTurnRate: degrees(8),
    maxTurnAcceleration: degrees(3),
    turnResponseTime: 2,
    maxDepthRate: 0,
    maxDepthAcceleration: 0,
    depthResponseTime: 1,
  };
  config.target.commandedSpeed = 0.35;
  config.target.commandedDepth = 15;
  config.sensor.maxRange = 500;
  config.sensor.bearingSigma = degrees(1);
  config.sensor.rangeSigmaBase = 1.5;
  config.sensor.rangeSigmaPerMeter = 0.003;
  config.guidance.maxLateralAcceleration = 1.5;
  config.scenario.targetTurnRate = degrees(1.2);
  config.scenario.evasiveTriggerRange = 25;
  config.scenario.evasiveTurnRate = degrees(-5);
  config.interceptRadius = 2;
}

function applyGenericScenario(config: SimulationConfig): void {
  config.runtime.maxTime = 120;
  config.torpedo.initial = {
    position: { x: 0, y: -35, z: 0 },
    heading: degrees(18),
    speed: 32,
    depth: 35,
  };
  config.torpedo.parameters = {
    maxSpeed: 46,
    maxAcceleration: 4,
    maxDeceleration: 6,
    speedResponseTime: 2.5,
    maxTurnRate: degrees(15),
    maxTurnAcceleration: degrees(24),
    turnResponseTime: 0.55,
    maxDepthRate: 4,
    maxDepthAcceleration: 2,
    depthResponseTime: 0.8,
  };
  config.torpedo.commandedSpeed = 40;
  config.torpedo.commandedDepth = 8;
  config.target.initial = {
    position: { x: 2000, y: -8, z: 650 },
    heading: degrees(160),
    speed: 13,
    depth: 8,
  };
  config.target.parameters = {
    maxSpeed: 18,
    maxAcceleration: 0.7,
    maxDeceleration: 1,
    speedResponseTime: 8,
    maxTurnRate: degrees(4),
    maxTurnAcceleration: degrees(1.5),
    turnResponseTime: 5,
    maxDepthRate: 0,
    maxDepthAcceleration: 0,
    depthResponseTime: 1,
  };
  config.target.commandedSpeed = 13;
  config.target.commandedDepth = 8;
  config.sensor.maxRange = 3_200;
  config.sensor.bearingSigma = degrees(1.6);
  config.sensor.rangeSigmaBase = 8;
  config.sensor.rangeSigmaPerMeter = 0.006;
  config.guidance.maxLateralAcceleration = 9;
  config.scenario.targetTurnRate = degrees(1.15);
  config.scenario.evasiveTriggerRange = 850;
  config.scenario.evasiveTurnRate = degrees(-3.2);
  config.interceptRadius = 14;
}

export function applyHydrodynamicProfile(
  config: SimulationConfig,
  profileId: HydrodynamicProfileId,
): void {
  const profile = HYDRODYNAMIC_PROFILES[profileId];
  config.dynamics.sixDof.profile = profileId;
  config.dynamics.sixDof.parameters = structuredClone(profile.parameters);
  if (profileId === "bluerov2-heavy-2024") applyCivilianScenario(config);
  else applyGenericScenario(config);
}
