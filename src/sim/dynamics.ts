import { clamp, headingVector, wrapAngle } from "./math";
import { quaternionFromHeading } from "./quaternion";
import { rk4Step } from "./rk4";
import type {
  ActuatorState,
  VehicleConfig,
  VehicleParameters,
  VehicleState,
} from "./types";

export interface VehicleControl {
  yawRateCommand: number;
  depthRateCommand: number;
  speedCommand: number;
}

export function initialVehicleState(config: VehicleConfig): VehicleState {
  const direction = headingVector(config.initial.heading);
  return {
    timestamp: 0,
    position: { ...config.initial.position },
    velocity: {
      x: direction.x * config.initial.speed,
      y: 0,
      z: direction.z * config.initial.speed,
    },
    heading: wrapAngle(config.initial.heading),
    speed: config.initial.speed,
    depth: config.initial.depth,
    depthRate: 0,
    yawRate: 0,
    dynamicsModel: "planar-2.5d",
    orientation: quaternionFromHeading(config.initial.heading),
    bodyVelocity: { x: config.initial.speed, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    actuator: {
      yawRateCommand: 0,
      depthRateCommand: 0,
      speedCommand: config.commandedSpeed,
      saturated: false,
      rudderAngle: 0,
      elevatorAngle: 0,
      propulsionForce: 0,
      controlEffort: 0,
      trackingError: 0,
    },
  };
}

function derivative(
  state: readonly number[],
  control: VehicleControl,
  parameters: VehicleParameters,
): number[] {
  const [, , heading, speed, , depthRate, yawRate] = state;
  const requestedSpeedAcceleration =
    (control.speedCommand - speed) / parameters.speedResponseTime;
  const speedAcceleration = clamp(
    requestedSpeedAcceleration,
    -parameters.maxDeceleration,
    parameters.maxAcceleration,
  );
  const depthAcceleration =
    parameters.maxDepthAcceleration === 0
      ? 0
      : clamp(
          (control.depthRateCommand - depthRate) /
            parameters.depthResponseTime,
          -parameters.maxDepthAcceleration,
          parameters.maxDepthAcceleration,
        );
  const turnAcceleration = clamp(
    (control.yawRateCommand - yawRate) / parameters.turnResponseTime,
    -parameters.maxTurnAcceleration,
    parameters.maxTurnAcceleration,
  );

  return [
    speed * Math.cos(heading),
    speed * Math.sin(heading),
    yawRate,
    speedAcceleration,
    depthRate,
    depthAcceleration,
    turnAcceleration,
  ];
}

export function integrateVehicle(
  vehicle: VehicleState,
  control: VehicleControl,
  parameters: VehicleParameters,
  dt: number,
): VehicleState {
  const limited: VehicleControl = {
    yawRateCommand: clamp(
      control.yawRateCommand,
      -parameters.maxTurnRate,
      parameters.maxTurnRate,
    ),
    depthRateCommand: clamp(
      control.depthRateCommand,
      -parameters.maxDepthRate,
      parameters.maxDepthRate,
    ),
    speedCommand: clamp(control.speedCommand, 0, parameters.maxSpeed),
  };
  const saturated =
    limited.yawRateCommand !== control.yawRateCommand ||
    limited.depthRateCommand !== control.depthRateCommand ||
    limited.speedCommand !== control.speedCommand;

  const state = [
    vehicle.position.x,
    vehicle.position.z,
    vehicle.heading,
    vehicle.speed,
    vehicle.depth,
    vehicle.depthRate,
    vehicle.yawRate,
  ];
  const next = rk4Step(state, dt, (sample) =>
    derivative(sample, limited, parameters),
  );
  const heading = wrapAngle(next[2]);
  const speed = clamp(next[3], 0, parameters.maxSpeed);
  const depth = Math.max(0, next[4]);
  const depthRate = clamp(
    next[5],
    -parameters.maxDepthRate,
    parameters.maxDepthRate,
  );
  const yawRate = clamp(
    next[6],
    -parameters.maxTurnRate,
    parameters.maxTurnRate,
  );
  const direction = headingVector(heading);

  const yawScale = Math.max(parameters.maxTurnRate, 1e-9);
  const depthScale = Math.max(parameters.maxDepthRate, 1e-9);
  const actuator: ActuatorState = {
    ...limited,
    saturated,
    rudderAngle: 0,
    elevatorAngle: 0,
    propulsionForce: 0,
    controlEffort: Math.hypot(
      limited.yawRateCommand / yawScale,
      parameters.maxDepthRate === 0 ? 0 : limited.depthRateCommand / depthScale,
      limited.speedCommand / parameters.maxSpeed,
    ) / Math.sqrt(3),
    trackingError: Math.hypot(
      (limited.yawRateCommand - yawRate) / yawScale,
      parameters.maxDepthRate === 0 ? 0 : (limited.depthRateCommand - depthRate) / depthScale,
      (limited.speedCommand - speed) / parameters.maxSpeed,
    ) / Math.sqrt(3),
  };
  return {
    timestamp: vehicle.timestamp + dt,
    position: { x: next[0], y: -depth, z: next[1] },
    velocity: {
      x: direction.x * speed,
      y: depthRate === 0 ? 0 : -depthRate,
      z: direction.z * speed,
    },
    heading,
    speed,
    depth,
    depthRate,
    yawRate,
    dynamicsModel: "planar-2.5d",
    orientation: quaternionFromHeading(heading),
    bodyVelocity: { x: speed, y: -depthRate, z: 0 },
    angularVelocity: { x: 0, y: -yawRate, z: 0 },
    actuator,
  };
}

export function depthRateAutopilot(
  desiredDepth: number,
  state: VehicleState,
  parameters: VehicleParameters,
): number {
  return clamp(
    (desiredDepth - state.depth) * 0.45,
    -parameters.maxDepthRate,
    parameters.maxDepthRate,
  );
}
