import { clamp, wrapAngle } from "./math";
import {
  inverseRotateVector,
  normalizeQuaternion,
  orientationAngles,
  quaternionDerivative,
  quaternionFromHeading,
  rotateVector,
} from "./quaternion";
import { rk4Step } from "./rk4";
import type {
  ActuatorState,
  Quaternion,
  SixDofConfig,
  SixDofParameters,
  Vec3,
  VehicleConfig,
  VehicleState,
} from "./types";
import type { VehicleControl } from "./dynamics";

const GRAVITY = 9.80665;
const TWO_PI = Math.PI * 2;

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function magnitude(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function currentAt(config: SixDofConfig, timestamp: number): Vec3 {
  const phase = TWO_PI * config.currentFrequency * timestamp;
  // The per-axis phase offsets follow the physical axis, so under the NED
  // convention East (y) carries the former z-axis phase and Down (z) carries
  // the former y-axis phase with an inverted amplitude sign.
  return {
    x: config.currentMean.x + config.currentAmplitude.x * Math.sin(phase),
    y: config.currentMean.y + config.currentAmplitude.y * Math.sin(phase * 1.17 + 3.1),
    z: config.currentMean.z + config.currentAmplitude.z * Math.sin(phase * 0.73 + 1.7),
  };
}

function damping(velocity: number, linear: number, quadratic: number): number {
  return -linear * velocity - quadratic * Math.abs(velocity) * velocity;
}

function trimDrag(parameters: SixDofParameters, relativeSpeed: number): number {
  return parameters.linearDamping.x * relativeSpeed
    + parameters.quadraticDamping.x * Math.abs(relativeSpeed) * relativeSpeed;
}

export interface SixDofTrimResult {
  converged: boolean;
  iterations: number;
  propulsionForce: number;
  throttle: number;
  heaveCommand: number;
  residualForce: Vec3;
  residualMoment: Vec3;
}

export function solveSixDofTrim(
  vehicle: VehicleConfig,
  config: SixDofConfig,
): SixDofTrimResult {
  const parameters = config.parameters;
  const orientation = quaternionFromHeading(vehicle.initial.heading);
  const currentBody = inverseRotateVector(orientation, currentAt(config, 0));
  const relativeSpeed = vehicle.initial.speed - currentBody.x;
  const required = Math.max(0, trimDrag(parameters, relativeSpeed));
  let lower = 0;
  let upper = parameters.maximumThrust;
  let propulsionForce = upper;
  let iterations = 0;
  for (; iterations < 64; iterations += 1) {
    propulsionForce = (lower + upper) * 0.5;
    const residual = propulsionForce - required;
    if (Math.abs(residual) < 1e-9) break;
    if (residual < 0) lower = propulsionForce;
    else upper = propulsionForce;
  }
  propulsionForce = clamp(required, 0, parameters.maximumThrust);
  const buoyancyExcess = (parameters.displacedMass - parameters.mass) * GRAVITY;
  const maximumVerticalThrust = parameters.maximumVerticalThrust ?? 0;
  const heaveCommand = parameters.actuationModel === "vectored-thrust"
    ? clamp(buoyancyExcess / Math.max(maximumVerticalThrust, 1e-9), -1, 1)
    : 0;
  const verticalResidual = buoyancyExcess - heaveCommand * maximumVerticalThrust;
  const buoyancyBody = inverseRotateVector(orientation, {
    x: 0,
    y: 0,
    z: -parameters.displacedMass * GRAVITY,
  });
  return {
    converged: required <= parameters.maximumThrust && Math.abs(verticalResidual) < 1e-8,
    iterations,
    propulsionForce,
    throttle: propulsionForce / parameters.maximumThrust,
    heaveCommand,
    residualForce: {
      x: propulsionForce - required,
      y: 0,
      z: verticalResidual,
    },
    residualMoment: cross(parameters.centerOfBuoyancy, buoyancyBody),
  };
}

interface DecodedState {
  position: Vec3;
  orientation: Quaternion;
  bodyVelocity: Vec3;
  angularVelocity: Vec3;
  rudder: number;
  elevator: number;
  propulsion: number;
  timestamp: number;
}

function decode(state: readonly number[]): DecodedState {
  return {
    position: { x: state[0], y: state[1], z: state[2] },
    orientation: normalizeQuaternion({ w: state[3], x: state[4], y: state[5], z: state[6] }),
    bodyVelocity: { x: state[7], y: state[8], z: state[9] },
    angularVelocity: { x: state[10], y: state[11], z: state[12] },
    rudder: state[13],
    elevator: state[14],
    propulsion: state[15],
    timestamp: state[16],
  };
}

function encode(vehicle: VehicleState): number[] {
  return [
    vehicle.position.x,
    vehicle.position.y,
    vehicle.position.z,
    vehicle.orientation.w,
    vehicle.orientation.x,
    vehicle.orientation.y,
    vehicle.orientation.z,
    vehicle.bodyVelocity.x,
    vehicle.bodyVelocity.y,
    vehicle.bodyVelocity.z,
    vehicle.angularVelocity.x,
    vehicle.angularVelocity.y,
    vehicle.angularVelocity.z,
    vehicle.actuator.rudderAngle,
    vehicle.actuator.elevatorAngle,
    vehicle.actuator.propulsionForce,
    vehicle.timestamp,
  ];
}

interface ControlTargets {
  rudder: number;
  elevator: number;
  propulsion: number;
  saturated: boolean;
}

function controlTargets(
  state: DecodedState,
  control: VehicleControl,
  vehicle: VehicleConfig,
  config: SixDofConfig,
): ControlTargets {
  const parameters = config.parameters;
  const worldVelocity = rotateVector(state.orientation, state.bodyVelocity);
  const worldAngularVelocity = rotateVector(state.orientation, state.angularVelocity);
  const yawRate = worldAngularVelocity.z;
  const depthRate = worldVelocity.z;
  const rawRudder = parameters.yawControllerGain * (control.yawRateCommand - yawRate);
  const buoyancyFeedForward = parameters.actuationModel === "vectored-thrust"
    ? (parameters.displacedMass - parameters.mass) * GRAVITY
      / Math.max(parameters.maximumVerticalThrust ?? 0, 1e-9)
    : 0;
  const rawElevator = buoyancyFeedForward
    + parameters.depthControllerGain * (control.depthRateCommand - depthRate);
  const maximumSurface = parameters.maxControlSurfaceAngle;
  const rudder = clamp(rawRudder, -maximumSurface, maximumSurface);
  const elevator = clamp(rawElevator, -maximumSurface, maximumSurface);
  const currentBody = inverseRotateVector(state.orientation, currentAt(config, state.timestamp));
  const commandedRelativeSpeed = Math.max(0, control.speedCommand - currentBody.x);
  const feedForward = Math.max(0, trimDrag(parameters, commandedRelativeSpeed));
  const rawPropulsion = feedForward
    + parameters.speedControllerGain * (control.speedCommand - state.bodyVelocity.x);
  const propulsion = clamp(rawPropulsion, 0, parameters.maximumThrust);
  return {
    rudder,
    elevator,
    propulsion,
    saturated: rudder !== rawRudder || elevator !== rawElevator || propulsion !== rawPropulsion
      || control.speedCommand > vehicle.parameters.maxSpeed,
  };
}

function derivative(
  stateVector: readonly number[],
  control: VehicleControl,
  vehicle: VehicleConfig,
  config: SixDofConfig,
): number[] {
  const state = decode(stateVector);
  const p = config.parameters;
  const targets = controlTargets(state, control, vehicle, config);
  const currentBody = inverseRotateVector(state.orientation, currentAt(config, state.timestamp));
  const relativeVelocity = subtract(state.bodyVelocity, currentBody);
  const q = Math.max(0, relativeVelocity.x * relativeVelocity.x);
  const vectoredThrust = p.actuationModel === "vectored-thrust";
  // Body frame is NED-style x = surge, y = starboard sway, z = down heave.
  // The rudder produces a starboard-facing side force; the elevator produces
  // a vertical (heave) force, nose-down positive for control surfaces.
  const rudderForce = vectoredThrust
    ? 0
    : -p.rudderForceCoefficient * q * state.rudder * config.controlAuthorityScale;
  const elevatorForce = vectoredThrust
    ? (p.maximumVerticalThrust ?? 0) * state.elevator * config.controlAuthorityScale
    : -p.elevatorForceCoefficient * q * state.elevator * config.controlAuthorityScale;
  const force = {
    x: state.propulsion + damping(relativeVelocity.x, p.linearDamping.x, p.quadraticDamping.x),
    y: rudderForce + damping(relativeVelocity.y, p.linearDamping.y, p.quadraticDamping.y),
    z: elevatorForce + damping(relativeVelocity.z, p.linearDamping.z, p.quadraticDamping.z),
  };
  const weightBody = inverseRotateVector(state.orientation, { x: 0, y: 0, z: p.mass * GRAVITY });
  const buoyancyBody = inverseRotateVector(state.orientation, { x: 0, y: 0, z: -p.displacedMass * GRAVITY });
  const totalForce = add(force, add(weightBody, buoyancyBody));
  const tailMoment = vectoredThrust
    ? { x: 0, y: 0, z: (p.maximumYawMoment ?? 0) * state.rudder * config.controlAuthorityScale }
    : cross(
      { x: -p.controlMomentArm, y: 0, z: 0 },
      { x: 0, y: rudderForce, z: elevatorForce },
    );
  const restoringMoment = cross(p.centerOfBuoyancy, buoyancyBody);
  const dampingMoment = {
    x: damping(state.angularVelocity.x, p.angularLinearDamping.x, p.angularQuadraticDamping.x),
    y: damping(state.angularVelocity.y, p.angularLinearDamping.y, p.angularQuadraticDamping.y),
    z: damping(state.angularVelocity.z, p.angularLinearDamping.z, p.angularQuadraticDamping.z),
  };
  const totalMoment = add(tailMoment, add(restoringMoment, dampingMoment));
  const effectiveMass = add(
    { x: p.mass, y: p.mass, z: p.mass },
    p.addedMass,
  );
  const momentum = {
    x: effectiveMass.x * state.bodyVelocity.x,
    y: effectiveMass.y * state.bodyVelocity.y,
    z: effectiveMass.z * state.bodyVelocity.z,
  };
  const translationalCoriolis = cross(state.angularVelocity, momentum);
  const bodyAcceleration = {
    x: (totalForce.x - translationalCoriolis.x) / effectiveMass.x,
    y: (totalForce.y - translationalCoriolis.y) / effectiveMass.y,
    z: (totalForce.z - translationalCoriolis.z) / effectiveMass.z,
  };
  const effectiveInertia = add(p.inertia, p.addedInertia);
  const angularMomentum = {
    x: effectiveInertia.x * state.angularVelocity.x,
    y: effectiveInertia.y * state.angularVelocity.y,
    z: effectiveInertia.z * state.angularVelocity.z,
  };
  const rotationalCoriolis = cross(state.angularVelocity, angularMomentum);
  const angularAcceleration = {
    x: (totalMoment.x - rotationalCoriolis.x) / effectiveInertia.x,
    y: (totalMoment.y - rotationalCoriolis.y) / effectiveInertia.y,
    z: (totalMoment.z - rotationalCoriolis.z) / effectiveInertia.z,
  };
  const worldVelocity = rotateVector(state.orientation, state.bodyVelocity);
  const orientationRate = quaternionDerivative(state.orientation, state.angularVelocity);
  const surfaceTime = p.controlSurfaceTimeConstant * config.actuatorLagScale;
  const propulsionTime = p.propulsionTimeConstant * config.actuatorLagScale;
  return [
    worldVelocity.x,
    worldVelocity.y,
    worldVelocity.z,
    orientationRate.w,
    orientationRate.x,
    orientationRate.y,
    orientationRate.z,
    bodyAcceleration.x,
    bodyAcceleration.y,
    bodyAcceleration.z,
    angularAcceleration.x,
    angularAcceleration.y,
    angularAcceleration.z,
    (targets.rudder - state.rudder) / surfaceTime,
    (targets.elevator - state.elevator) / surfaceTime,
    (targets.propulsion - state.propulsion) / propulsionTime,
    1,
  ];
}

export function initialSixDofState(
  vehicle: VehicleConfig,
  config: SixDofConfig,
): VehicleState {
  const orientation = quaternionFromHeading(vehicle.initial.heading);
  const trim = solveSixDofTrim(vehicle, config);
  return {
    timestamp: 0,
    position: { ...vehicle.initial.position },
    velocity: rotateVector(orientation, { x: vehicle.initial.speed, y: 0, z: 0 }),
    heading: wrapAngle(vehicle.initial.heading),
    speed: vehicle.initial.speed,
    depth: vehicle.initial.depth,
    depthRate: 0,
    yawRate: 0,
    dynamicsModel: "six-dof",
    orientation,
    bodyVelocity: { x: vehicle.initial.speed, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    actuator: {
      yawRateCommand: 0,
      depthRateCommand: 0,
      speedCommand: vehicle.commandedSpeed,
      saturated: !trim.converged,
      rudderAngle: 0,
      elevatorAngle: trim.heaveCommand,
      propulsionForce: trim.propulsionForce,
      controlEffort: trim.throttle,
      trackingError: 0,
    },
  };
}

export function integrateSixDofVehicle(
  vehicleState: VehicleState,
  control: VehicleControl,
  vehicle: VehicleConfig,
  config: SixDofConfig,
  dt: number,
): VehicleState {
  const state = encode(vehicleState);
  const next = rk4Step(state, dt, (sample) => derivative(sample, control, vehicle, config));
  const decoded = decode(next);
  const orientation = normalizeQuaternion(decoded.orientation);
  const worldVelocity = rotateVector(orientation, decoded.bodyVelocity);
  const worldAngularVelocity = rotateVector(orientation, decoded.angularVelocity);
  const angles = orientationAngles(orientation);
  const targets = controlTargets(decoded, control, vehicle, config);
  const maxSurface = config.parameters.maxControlSurfaceAngle;
  const maximumThrust = config.parameters.maximumThrust;
  const rudder = clamp(decoded.rudder, -maxSurface, maxSurface);
  const elevator = clamp(decoded.elevator, -maxSurface, maxSurface);
  const propulsion = clamp(decoded.propulsion, 0, maximumThrust);
  const depth = Math.max(0, decoded.position.z);
  const depthRate = worldVelocity.z;
  const yawRate = worldAngularVelocity.z;
  const actuator: ActuatorState = {
    yawRateCommand: control.yawRateCommand,
    depthRateCommand: control.depthRateCommand,
    speedCommand: control.speedCommand,
    saturated: targets.saturated || rudder !== decoded.rudder || elevator !== decoded.elevator
      || propulsion !== decoded.propulsion,
    rudderAngle: rudder,
    elevatorAngle: elevator,
    propulsionForce: propulsion,
    controlEffort: Math.hypot(
      rudder / maxSurface,
      elevator / maxSurface,
      propulsion / maximumThrust,
    ) / Math.sqrt(3),
    trackingError: Math.hypot(
      (control.yawRateCommand - yawRate) / Math.max(vehicle.parameters.maxTurnRate, 1e-9),
      (control.depthRateCommand - depthRate) / Math.max(vehicle.parameters.maxDepthRate, 1e-9),
      (control.speedCommand - decoded.bodyVelocity.x) / Math.max(vehicle.parameters.maxSpeed, 1e-9),
    ) / Math.sqrt(3),
  };
  return {
    timestamp: vehicleState.timestamp + dt,
    position: { x: decoded.position.x, y: decoded.position.y, z: depth },
    velocity: worldVelocity,
    heading: wrapAngle(angles.heading),
    speed: magnitude(decoded.bodyVelocity),
    depth,
    depthRate,
    yawRate,
    dynamicsModel: "six-dof",
    orientation,
    bodyVelocity: decoded.bodyVelocity,
    angularVelocity: decoded.angularVelocity,
    actuator,
  };
}

export function sixDofAttitude(vehicle: VehicleState): { roll: number; pitch: number } {
  const { roll, pitch } = orientationAngles(vehicle.orientation);
  return { roll, pitch };
}
