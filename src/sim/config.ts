import type { SimulationConfig } from "./types";
import { applyHydrodynamicProfile } from "./hydrodynamic-profiles";

const degrees = (value: number) => (value * Math.PI) / 180;

export function createDefaultConfig(): SimulationConfig {
  const config: SimulationConfig = {
    version: 2,
    seed: 20260814,
    runtime: {
      physicsHz: 200,
      autopilotHz: 100,
      guidanceHz: 50,
      snapshotHz: 50,
      telemetryHz: 20,
      maxTime: 120,
    },
    torpedo: {
      initial: {
        position: { x: 0, y: 0, z: 35 },
        heading: degrees(18),
        speed: 32,
        depth: 35,
      },
      parameters: {
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
      },
      commandedSpeed: 40,
      commandedDepth: 8,
    },
    target: {
      initial: {
        position: { x: 2000, y: 650, z: 8 },
        heading: degrees(160),
        speed: 13,
        depth: 8,
      },
      parameters: {
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
      },
      commandedSpeed: 13,
      commandedDepth: 8,
    },
    sensor: {
      cadenceHz: 8,
      fovHalfAngle: degrees(50),
      minRange: 20,
      maxRange: 3200,
      bearingSigma: degrees(1.6),
      rangeSigmaBase: 8,
      rangeSigmaPerMeter: 0.006,
      dropoutProbability: 0.08,
      latency: 0.08,
    },
    estimator: {
      accelerationNoise: 1.4,
      initialVelocityVariance: 225,
      innovationGate: 9.21,
      staleAfter: 1.5,
    },
    guidance: {
      law: "proportional-navigation",
      mode: "ekf",
      navigationConstant: 3.5,
      pursuitGain: 1.8,
      maxLateralAcceleration: 9,
      staleTrackCommandScale: 0.35,
    },
    scenario: {
      kind: "constant-turn",
      targetTurnRate: degrees(1.15),
      evasiveTriggerRange: 850,
      evasiveTurnRate: degrees(-3.2),
    },
    dynamics: {
      model: "planar-2.5d",
      sixDof: {
        parameters: {
          mass: 1_550,
          displacedMass: 1_550,
          inertia: { x: 1_100, y: 9_200, z: 9_200 },
          addedMass: { x: 180, y: 1_250, z: 1_250 },
          addedInertia: { x: 420, y: 2_800, z: 2_800 },
          linearDamping: { x: 55, y: 900, z: 900 },
          quadraticDamping: { x: 13.5, y: 310, z: 310 },
          angularLinearDamping: { x: 2_400, y: 25_000, z: 5_800 },
          angularQuadraticDamping: { x: 1_100, y: 8_500, z: 8_500 },
          centerOfBuoyancy: { x: 0, y: 0, z: -0.12 },
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
        },
        currentMean: { x: 0.35, y: -0.2, z: 0 },
        currentAmplitude: { x: 0.12, y: 0.16, z: -0.03 },
        currentFrequency: 0.035,
        actuatorLagScale: 1,
        controlAuthorityScale: 1,
      },
    },
    environment: {
      temperatureC: 10,
      salinityPsu: 35,
      waterDepth: 500,
      spreadingCoefficient: 20,
    },
    acoustic: {
      enabled: true,
      frequencyKhz: 12,
      sourceLevelDb: 210,
      targetStrengthDb: -5,
      ambientNoiseDb: 70,
      receiverDirectivityIndexDb: 15,
      detectionThresholdDb: 6,
      detectionTransitionDb: 2.5,
    },
    interceptRadius: 14,
  };
  applyHydrodynamicProfile(config, "generic-fictional");
  return config;
}

export function createPortfolioDemoConfig(seed = 20260814): SimulationConfig {
  const config = createDefaultConfig();
  applyHydrodynamicProfile(config, "generic-fictional");
  config.seed = seed;
  config.dynamics.model = "six-dof";
  config.scenario.kind = "scripted-evasive";
  config.guidance.mode = "ekf";
  config.guidance.law = "proportional-navigation";
  config.runtime.maxTime = 70;
  return config;
}

export function validateConfig(config: SimulationConfig): void {
  const { runtime } = config;
  const finite = (name: string, value: number) => {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  };
  const nonnegative = (name: string, value: number) => {
    finite(name, value);
    if (value < 0) throw new Error(`${name} must be nonnegative.`);
  };
  const positive = (name: string, value: number) => {
    finite(name, value);
    if (value <= 0) throw new Error(`${name} must be positive.`);
  };

  if (!Number.isInteger(config.seed) || config.seed < 0) {
    throw new Error("Seed must be a nonnegative integer.");
  }
  if (config.version !== 2) {
    throw new Error("Configuration schema 2 is required.");
  }
  if (runtime.physicsHz !== 200) {
    throw new Error("Phase 1 requires a 200 Hz authoritative physics rate.");
  }
  for (const [name, rate] of Object.entries({
    autopilotHz: runtime.autopilotHz,
    guidanceHz: runtime.guidanceHz,
    snapshotHz: runtime.snapshotHz,
    telemetryHz: runtime.telemetryHz,
  })) {
    positive(name, rate);
    if (runtime.physicsHz % rate !== 0) {
      throw new Error(`${name} must divide physicsHz exactly.`);
    }
  }
  positive("runtime.maxTime", runtime.maxTime);
  for (const [vehicleName, vehicle] of [
    ["torpedo", config.torpedo],
    ["target", config.target],
  ] as const) {
    const prefix = `${vehicleName}.parameters`;
    positive(`${prefix}.maxSpeed`, vehicle.parameters.maxSpeed);
    nonnegative(`${prefix}.maxAcceleration`, vehicle.parameters.maxAcceleration);
    nonnegative(`${prefix}.maxDeceleration`, vehicle.parameters.maxDeceleration);
    positive(`${prefix}.speedResponseTime`, vehicle.parameters.speedResponseTime);
    nonnegative(`${prefix}.maxTurnRate`, vehicle.parameters.maxTurnRate);
    nonnegative(
      `${prefix}.maxTurnAcceleration`,
      vehicle.parameters.maxTurnAcceleration,
    );
    positive(`${prefix}.turnResponseTime`, vehicle.parameters.turnResponseTime);
    nonnegative(`${prefix}.maxDepthRate`, vehicle.parameters.maxDepthRate);
    nonnegative(
      `${prefix}.maxDepthAcceleration`,
      vehicle.parameters.maxDepthAcceleration,
    );
    positive(`${prefix}.depthResponseTime`, vehicle.parameters.depthResponseTime);
    for (const [axis, value] of Object.entries(vehicle.initial.position)) {
      finite(`${vehicleName}.initial.position.${axis}`, value);
    }
    finite(`${vehicleName}.initial.heading`, vehicle.initial.heading);
    if (vehicle.initial.pitch !== undefined) {
      finite(`${vehicleName}.initial.pitch`, vehicle.initial.pitch);
    }
    if (vehicle.initial.roll !== undefined) {
      finite(`${vehicleName}.initial.roll`, vehicle.initial.roll);
    }
    if (vehicle.initial.verticalSpeed !== undefined) {
      finite(`${vehicleName}.initial.verticalSpeed`, vehicle.initial.verticalSpeed);
    }
    if (vehicle.dynamicsModel !== undefined) {
      if (!["planar-2.5d", "six-dof"].includes(vehicle.dynamicsModel)) {
        throw new Error(`Unknown ${vehicleName}.dynamicsModel.`);
      }
    }
    nonnegative(`${vehicleName}.initial.speed`, vehicle.initial.speed);
    nonnegative(`${vehicleName}.initial.depth`, vehicle.initial.depth);
    if (vehicle.initial.speed > vehicle.parameters.maxSpeed) {
      throw new Error(`${vehicleName}.initial.speed exceeds maxSpeed.`);
    }
    if (Math.abs(vehicle.initial.position.z - vehicle.initial.depth) > 1e-9) {
      throw new Error(
        `${vehicleName}.initial.position.z must equal initial.depth (NED down).`,
      );
    }
    nonnegative(`${vehicleName}.commandedSpeed`, vehicle.commandedSpeed);
    nonnegative(`${vehicleName}.commandedDepth`, vehicle.commandedDepth);
    if (vehicle.commandedSpeed > vehicle.parameters.maxSpeed) {
      throw new Error(`${vehicleName}.commandedSpeed exceeds maxSpeed.`);
    }
  }
  positive("sensor.cadenceHz", config.sensor.cadenceHz);
  if (config.sensor.cadenceHz > 50) {
    throw new Error("Sensor cadence must be within (0, 50] Hz.");
  }
  finite("sensor.dropoutProbability", config.sensor.dropoutProbability);
  if (
    config.sensor.dropoutProbability < 0 ||
    config.sensor.dropoutProbability > 1
  ) {
    throw new Error("Dropout probability must be within [0, 1].");
  }
  nonnegative("sensor.minRange", config.sensor.minRange);
  positive("sensor.maxRange", config.sensor.maxRange);
  if (config.sensor.maxRange <= config.sensor.minRange) {
    throw new Error("sensor.maxRange must exceed sensor.minRange.");
  }
  positive("sensor.fovHalfAngle", config.sensor.fovHalfAngle);
  if (config.sensor.fovHalfAngle > Math.PI) {
    throw new Error("sensor.fovHalfAngle cannot exceed pi radians.");
  }
  nonnegative("sensor.bearingSigma", config.sensor.bearingSigma);
  nonnegative("sensor.rangeSigmaBase", config.sensor.rangeSigmaBase);
  nonnegative("sensor.rangeSigmaPerMeter", config.sensor.rangeSigmaPerMeter);
  nonnegative("sensor.latency", config.sensor.latency);
  if (config.environment) {
    const profile = config.environment.soundProfile;
    if (profile) {
      nonnegative("environment.soundProfile.layerDepth", profile.layerDepth);
      finite("environment.soundProfile.thermoclineDrop", profile.thermoclineDrop);
      finite("environment.soundProfile.deepGradient", profile.deepGradient);
      nonnegative("environment.soundProfile.layerLossDb", profile.layerLossDb);
      nonnegative("environment.soundProfile.recoveryRange", profile.recoveryRange);
      nonnegative("environment.soundProfile.fadeWidth", profile.fadeWidth);
    }
    finite("environment.temperatureC", config.environment.temperatureC);
    nonnegative("environment.salinityPsu", config.environment.salinityPsu);
    positive("environment.waterDepth", config.environment.waterDepth);
    positive("environment.spreadingCoefficient", config.environment.spreadingCoefficient);
    if (config.environment.spreadingCoefficient < 10 || config.environment.spreadingCoefficient > 20) {
      throw new Error("environment.spreadingCoefficient must be within [10, 20].");
    }
  }
  if (config.acoustic) {
    positive("acoustic.frequencyKhz", config.acoustic.frequencyKhz);
    finite("acoustic.sourceLevelDb", config.acoustic.sourceLevelDb);
    finite("acoustic.targetStrengthDb", config.acoustic.targetStrengthDb);
    finite("acoustic.ambientNoiseDb", config.acoustic.ambientNoiseDb);
    nonnegative("acoustic.receiverDirectivityIndexDb", config.acoustic.receiverDirectivityIndexDb);
    finite("acoustic.detectionThresholdDb", config.acoustic.detectionThresholdDb);
    positive("acoustic.detectionTransitionDb", config.acoustic.detectionTransitionDb);
    if (config.acoustic.enabled && !config.environment) {
      throw new Error("Enabled acoustic channel requires an environment configuration.");
    }
  }
  nonnegative(
    "estimator.accelerationNoise",
    config.estimator.accelerationNoise,
  );
  positive(
    "estimator.initialVelocityVariance",
    config.estimator.initialVelocityVariance,
  );
  positive("estimator.innovationGate", config.estimator.innovationGate);
  positive("estimator.staleAfter", config.estimator.staleAfter);
  if (
    !["pure-pursuit", "proportional-navigation"].includes(
      config.guidance.law,
    )
  ) {
    throw new Error("Unknown guidance law.");
  }
  if (!["perfect", "raw", "ekf"].includes(config.guidance.mode)) {
    throw new Error("Unknown observation mode.");
  }
  nonnegative("guidance.navigationConstant", config.guidance.navigationConstant);
  nonnegative("guidance.pursuitGain", config.guidance.pursuitGain);
  positive(
    "guidance.maxLateralAcceleration",
    config.guidance.maxLateralAcceleration,
  );
  finite(
    "guidance.staleTrackCommandScale",
    config.guidance.staleTrackCommandScale,
  );
  if (
    config.guidance.staleTrackCommandScale < 0 ||
    config.guidance.staleTrackCommandScale > 1
  ) {
    throw new Error("guidance.staleTrackCommandScale must be within [0, 1].");
  }
  if (
    !["constant-velocity", "constant-turn", "scripted-evasive"].includes(
      config.scenario.kind,
    )
  ) {
    throw new Error("Unknown scenario kind.");
  }
  finite("scenario.targetTurnRate", config.scenario.targetTurnRate);
  nonnegative(
    "scenario.evasiveTriggerRange",
    config.scenario.evasiveTriggerRange,
  );
  finite("scenario.evasiveTurnRate", config.scenario.evasiveTurnRate);
  if (!["planar-2.5d", "six-dof"].includes(config.dynamics.model)) {
    throw new Error("Unknown dynamics model.");
  }
  if (config.contacts) {
    const ids = new Set<string>();
    for (const contact of config.contacts) {
      if (!contact.id || ids.has(contact.id)) {
        throw new Error("contacts require unique non-empty ids.");
      }
      ids.add(contact.id);
      if (contact.targetStrengthDb !== undefined) {
        finite(`contacts.${contact.id}.targetStrengthDb`, contact.targetStrengthDb);
      }
      const behavior = contact.behavior;
      if (behavior) {
        if (behavior.kind === "constant-turn" || behavior.kind === "scripted-evasive") {
          finite(`contacts.${contact.id}.rate`, behavior.rate);
        }
        if (behavior.kind === "scripted-evasive" || behavior.kind === "decoy") {
          nonnegative(`contacts.${contact.id}.triggerRange`, behavior.triggerRange);
        }
        if (behavior.kind === "biologic-wander") {
          positive(`contacts.${contact.id}.amplitude`, behavior.amplitude);
          positive(`contacts.${contact.id}.period`, behavior.period);
        }
        if (behavior.kind === "decoy") {
          positive(`contacts.${contact.id}.deploySpeed`, behavior.deploySpeed);
        }
      }
      if (contact.echoFluctuation) {
        finite(`contacts.${contact.id}.echoFluctuation.amplitudeDb`, contact.echoFluctuation.amplitudeDb);
        positive(`contacts.${contact.id}.echoFluctuation.period`, contact.echoFluctuation.period);
      }
      if (
        contact.deployedBy !== undefined &&
        !config.contacts.some((other) => other.id === contact.deployedBy)
      ) {
        throw new Error(`contacts.${contact.id}.deployedBy references an unknown contact.`);
      }
    }
  }
  if (config.weapon) {
    const weapon = config.weapon;
    const phases = weapon.phases;
    if (phases) {
      if (phases.enableTime !== undefined && phases.enableDistance !== undefined) {
        throw new Error("weapon.phases: specify enableTime or enableDistance, not both.");
      }
      nonnegative("weapon.phases.enableTime", phases.enableTime ?? 0);
      nonnegative("weapon.phases.enableDistance", phases.enableDistance ?? 0);
      nonnegative("weapon.phases.terminalRange", phases.terminalRange ?? 0);
      nonnegative("weapon.phases.reacquireAfter", phases.reacquireAfter ?? 0);
      finite("weapon.phases.searchTurnRate", phases.searchTurnRate ?? 0);
    }
    for (const [name, value] of [
      ["cruiseSpeed", weapon.speed?.cruiseSpeed],
      ["sprintSpeed", weapon.speed?.sprintSpeed],
    ] as const) {
      if (value !== undefined) {
        positive(`weapon.speed.${name}`, value);
        if (value > config.torpedo.parameters.maxSpeed) {
          throw new Error(`weapon.speed.${name} exceeds torpedo maxSpeed.`);
        }
      }
    }
    if (weapon.endurance?.runTime !== undefined) {
      positive("weapon.endurance.runTime", weapon.endurance.runTime);
    }
    const battery = weapon.endurance?.battery;
    if (battery) {
      positive("weapon.endurance.battery.capacityWs", battery.capacityWs);
      nonnegative("weapon.endurance.battery.hotelW", battery.hotelW);
      positive("weapon.endurance.battery.dragKW", battery.dragKW);
    }
    if (config.sensor.selfNoise) {
      finite("sensor.selfNoise.baseDb", config.sensor.selfNoise.baseDb);
      nonnegative("sensor.selfNoise.dbPerMs", config.sensor.selfNoise.dbPerMs);
    }
    for (const contact of config.contacts ?? []) {
      const perception = contact.perception;
      if (perception) {
        finite("contacts.perception.detectionThresholdDb", perception.detectionThresholdDb);
        positive("contacts.perception.detectionTransitionDb", perception.detectionTransitionDb);
        nonnegative("contacts.perception.reactionDelay", perception.reactionDelay);
        nonnegative("contacts.perception.reactionGrace", perception.reactionGrace);
        nonnegative("contacts.perception.evasiveRate", perception.evasiveRate);
        nonnegative("contacts.perception.bearingSigmaRad", perception.bearingSigmaRad);
        if (perception.diveDepth !== undefined) {
          nonnegative("contacts.perception.diveDepth", perception.diveDepth);
        }
        if (perception.quietFactor !== undefined) {
          positive("contacts.perception.quietFactor", perception.quietFactor);
        }
      }
      if (contact.aspectEcho) {
        finite(`contacts.${contact.id}.aspectEcho.bowDb`, contact.aspectEcho.bowDb);
        finite(`contacts.${contact.id}.aspectEcho.beamDb`, contact.aspectEcho.beamDb);
      }
    }
    if (weapon.terminalSensor?.cadenceHz !== undefined) {
      positive("weapon.terminalSensor.cadenceHz", weapon.terminalSensor.cadenceHz);
      if (weapon.terminalSensor.cadenceHz > 50) {
        throw new Error("weapon.terminalSensor.cadenceHz must be within (0, 50].");
      }
    }
    if (weapon.terminalSensor?.fovHalfAngle !== undefined) {
      positive("weapon.terminalSensor.fovHalfAngle", weapon.terminalSensor.fovHalfAngle);
      if (weapon.terminalSensor.fovHalfAngle > Math.PI) {
        throw new Error("weapon.terminalSensor.fovHalfAngle cannot exceed pi radians.");
      }
    }
    if (weapon.terminalSensor?.innovationGate !== undefined) {
      positive("weapon.terminalSensor.innovationGate", weapon.terminalSensor.innovationGate);
    }
    nonnegative("weapon.fuze.detectionRadius", weapon.fuze?.detectionRadius ?? 0);
    nonnegative("weapon.fuze.jitter", weapon.fuze?.jitter ?? 0);
    nonnegative("weapon.fuze.armDelay", weapon.fuze?.armDelay ?? 0);
    if (weapon.effectiveness?.lethalRadius !== undefined) {
      positive("weapon.effectiveness.lethalRadius", weapon.effectiveness.lethalRadius);
    }
    if (weapon.effectiveness?.shape !== undefined) {
      positive("weapon.effectiveness.shape", weapon.effectiveness.shape);
    }
  }
  const sixDof = config.dynamics.sixDof;
  const six = sixDof.parameters;
  if (sixDof.profile && !["generic-fictional", "bluerov2-heavy-2024"].includes(sixDof.profile)) {
    throw new Error("Unknown 6-DOF hydrodynamic profile.");
  }
  if (six.actuationModel && !["control-surfaces", "vectored-thrust"].includes(six.actuationModel)) {
    throw new Error("Unknown 6-DOF actuation model.");
  }
  positive("dynamics.sixDof.parameters.mass", six.mass);
  positive("dynamics.sixDof.parameters.displacedMass", six.displacedMass);
  for (const [groupName, group, requirePositive] of [
    ["inertia", six.inertia, true],
    ["addedMass", six.addedMass, false],
    ["addedInertia", six.addedInertia, false],
    ["linearDamping", six.linearDamping, false],
    ["quadraticDamping", six.quadraticDamping, false],
    ["angularLinearDamping", six.angularLinearDamping, false],
    ["angularQuadraticDamping", six.angularQuadraticDamping, false],
  ] as const) {
    for (const [axis, value] of Object.entries(group)) {
      if (requirePositive) positive(`dynamics.sixDof.parameters.${groupName}.${axis}`, value);
      else nonnegative(`dynamics.sixDof.parameters.${groupName}.${axis}`, value);
    }
  }
  for (const [axis, value] of Object.entries(six.centerOfBuoyancy)) {
    finite(`dynamics.sixDof.parameters.centerOfBuoyancy.${axis}`, value);
  }
  positive("dynamics.sixDof.parameters.maxControlSurfaceAngle", six.maxControlSurfaceAngle);
  positive("dynamics.sixDof.parameters.controlSurfaceTimeConstant", six.controlSurfaceTimeConstant);
  positive("dynamics.sixDof.parameters.propulsionTimeConstant", six.propulsionTimeConstant);
  positive("dynamics.sixDof.parameters.maximumThrust", six.maximumThrust);
  nonnegative("dynamics.sixDof.parameters.speedControllerGain", six.speedControllerGain);
  nonnegative("dynamics.sixDof.parameters.rudderForceCoefficient", six.rudderForceCoefficient);
  nonnegative("dynamics.sixDof.parameters.elevatorForceCoefficient", six.elevatorForceCoefficient);
  positive("dynamics.sixDof.parameters.controlMomentArm", six.controlMomentArm);
  nonnegative("dynamics.sixDof.parameters.yawControllerGain", six.yawControllerGain);
  nonnegative("dynamics.sixDof.parameters.depthControllerGain", six.depthControllerGain);
  if (six.actuationModel === "vectored-thrust") {
    positive("dynamics.sixDof.parameters.maximumVerticalThrust", six.maximumVerticalThrust ?? 0);
    positive("dynamics.sixDof.parameters.maximumYawMoment", six.maximumYawMoment ?? 0);
  }
  for (const [name, vector] of [
    ["currentMean", sixDof.currentMean],
    ["currentAmplitude", sixDof.currentAmplitude],
  ] as const) {
    for (const [axis, value] of Object.entries(vector)) {
      finite(`dynamics.sixDof.${name}.${axis}`, value);
    }
  }
  nonnegative("dynamics.sixDof.currentFrequency", sixDof.currentFrequency);
  positive("dynamics.sixDof.actuatorLagScale", sixDof.actuatorLagScale);
  positive("dynamics.sixDof.controlAuthorityScale", sixDof.controlAuthorityScale);
  positive("interceptRadius", config.interceptRadius);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

export function hashConfig(config: SimulationConfig): string {
  const encoded = JSON.stringify(stable(config));
  let hash = 2166136261;
  for (let i = 0; i < encoded.length; i += 1) {
    hash ^= encoded.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
