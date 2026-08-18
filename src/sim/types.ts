/**
 * Simulation coordinates are NED: x = North, y = East, z = Down (positive-down
 * depth). Vec2 is the horizontal (North, East) pair consumed by the planar
 * guidance/estimation/sensing boundary.
 */
export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

export type GuidanceLaw = "pure-pursuit" | "proportional-navigation";
export type ObservationMode = "perfect" | "raw" | "ekf";
export type DynamicsModel = "planar-2.5d" | "six-dof";
export type ScenarioKind =
  | "constant-velocity"
  | "constant-turn"
  | "scripted-evasive";

export type SeekerStatus =
  | "searching"
  | "locked"
  | "dropout"
  | "acoustic-loss"
  | "out-of-fov"
  | "out-of-range";

export interface RuntimeConfig {
  physicsHz: 200;
  autopilotHz: 100;
  guidanceHz: 50;
  snapshotHz: 50;
  telemetryHz: 20;
  maxTime: number;
}

export interface VehicleParameters {
  maxSpeed: number;
  maxAcceleration: number;
  maxDeceleration: number;
  speedResponseTime: number;
  maxTurnRate: number;
  maxTurnAcceleration: number;
  turnResponseTime: number;
  maxDepthRate: number;
  maxDepthAcceleration: number;
  depthResponseTime: number;
}

export interface VehicleInitialState {
  position: Vec3;
  heading: number;
  speed: number;
  depth: number;
}

export interface VehicleConfig {
  initial: VehicleInitialState;
  parameters: VehicleParameters;
  commandedSpeed: number;
  commandedDepth: number;
}

export interface SensorConfig {
  cadenceHz: number;
  fovHalfAngle: number;
  minRange: number;
  maxRange: number;
  bearingSigma: number;
  rangeSigmaBase: number;
  rangeSigmaPerMeter: number;
  dropoutProbability: number;
  latency: number;
}

export interface EnvironmentConfig {
  temperatureC: number;
  salinityPsu: number;
  waterDepth: number;
  spreadingCoefficient: number;
}

export interface AcousticConfig {
  enabled: boolean;
  frequencyKhz: number;
  sourceLevelDb: number;
  targetStrengthDb: number;
  ambientNoiseDb: number;
  receiverDirectivityIndexDb: number;
  detectionThresholdDb: number;
  detectionTransitionDb: number;
}

export interface AcousticChannelState {
  timestamp: number;
  soundSpeed: number;
  absorptionDbPerKm: number;
  oneWayTransmissionLossDb: number;
  receivedEchoLevelDb: number;
  signalToNoiseDb: number;
  detectionProbability: number;
  propagationDelay: number;
}

export interface EstimatorConfig {
  accelerationNoise: number;
  initialVelocityVariance: number;
  innovationGate: number;
  staleAfter: number;
}

export interface GuidanceConfig {
  law: GuidanceLaw;
  mode: ObservationMode;
  navigationConstant: number;
  pursuitGain: number;
  maxLateralAcceleration: number;
  staleTrackCommandScale: number;
}

export interface ScenarioConfig {
  kind: ScenarioKind;
  targetTurnRate: number;
  evasiveTriggerRange: number;
  evasiveTurnRate: number;
}

export interface SixDofParameters {
  actuationModel?: "control-surfaces" | "vectored-thrust";
  mass: number;
  displacedMass: number;
  inertia: Vec3;
  addedMass: Vec3;
  addedInertia: Vec3;
  linearDamping: Vec3;
  quadraticDamping: Vec3;
  angularLinearDamping: Vec3;
  angularQuadraticDamping: Vec3;
  centerOfBuoyancy: Vec3;
  maxControlSurfaceAngle: number;
  controlSurfaceTimeConstant: number;
  propulsionTimeConstant: number;
  maximumThrust: number;
  speedControllerGain: number;
  rudderForceCoefficient: number;
  elevatorForceCoefficient: number;
  controlMomentArm: number;
  yawControllerGain: number;
  depthControllerGain: number;
  maximumVerticalThrust?: number;
  maximumYawMoment?: number;
}

export interface SixDofConfig {
  profile?: "generic-fictional" | "bluerov2-heavy-2024";
  parameters: SixDofParameters;
  currentMean: Vec3;
  currentAmplitude: Vec3;
  currentFrequency: number;
  actuatorLagScale: number;
  controlAuthorityScale: number;
}

export interface DynamicsConfig {
  model: DynamicsModel;
  sixDof: SixDofConfig;
}

export interface SimulationConfig {
  version: 2;
  seed: number;
  runtime: RuntimeConfig;
  torpedo: VehicleConfig;
  target: VehicleConfig;
  sensor: SensorConfig;
  estimator: EstimatorConfig;
  guidance: GuidanceConfig;
  scenario: ScenarioConfig;
  dynamics: DynamicsConfig;
  environment?: EnvironmentConfig;
  acoustic?: AcousticConfig;
  interceptRadius: number;
}

export interface ActuatorState {
  yawRateCommand: number;
  depthRateCommand: number;
  speedCommand: number;
  saturated: boolean;
  rudderAngle: number;
  elevatorAngle: number;
  propulsionForce: number;
  controlEffort: number;
  trackingError: number;
}

export interface VehicleState {
  timestamp: number;
  position: Vec3;
  velocity: Vec3;
  heading: number;
  speed: number;
  depth: number;
  depthRate: number;
  yawRate: number;
  dynamicsModel: DynamicsModel;
  orientation: Quaternion;
  bodyVelocity: Vec3;
  angularVelocity: Vec3;
  actuator: ActuatorState;
}

export interface SensorObservation {
  id: number;
  observedAt: number;
  deliveredAt: number;
  bearing: number;
  range: number;
  bearingVariance: number;
  rangeVariance: number;
  sensorPosition: Vec2;
  sensorHeading: number;
  acoustic?: AcousticChannelState;
}

export interface TrackEstimate {
  timestamp: number;
  position: Vec2;
  velocity: Vec2;
  covariance: number[][];
  age: number;
  valid: boolean;
  source: ObservationMode;
  innovation?: [number, number];
  nis?: number;
  observationAccepted?: boolean;
}

export interface NavigationInput {
  timestamp: number;
  ownPosition: Vec2;
  ownVelocity: Vec2;
  ownHeading: number;
  track: TrackEstimate;
}

export interface GuidanceCommand {
  timestamp: number;
  law: GuidanceLaw;
  lateralAcceleration: number;
  desiredHeading: number;
  losRate: number;
  closingVelocity: number;
  trackAge: number;
  saturated: boolean;
}

export interface EngagementMetrics {
  range: number;
  horizontalRange: number;
  verticalSeparation: number;
  relativeBearing: number;
  closingVelocity: number;
  losRate: number;
  predictedMissDistance: number;
  predictedTimeToCpa: number;
}

export interface TelemetrySample {
  timestamp: number;
  torpedo: VehicleState;
  target: VehicleState;
  estimate: TrackEstimate | null;
  guidance: GuidanceCommand;
  metrics: EngagementMetrics;
  seekerStatus: SeekerStatus;
  estimationPositionError: number | null;
  covarianceTrace: number | null;
  nees: number | null;
  acoustic?: AcousticChannelState | null;
}

export interface TelemetryBatch {
  sequence: number;
  samples: TelemetrySample[];
}

export interface RenderSnapshot {
  sequence: number;
  timestamp: number;
  torpedo: VehicleState;
  target: VehicleState;
  estimate: TrackEstimate | null;
  observation: SensorObservation | null;
  guidance: GuidanceCommand;
  metrics: EngagementMetrics;
  seekerStatus: SeekerStatus;
  acoustic?: AcousticChannelState | null;
}

export type TerminationReason = "intercept" | "timeout" | "invalid-state";

export interface ExperimentResult {
  seed: number;
  configHash: string;
  mode: ObservationMode;
  law: GuidanceLaw;
  scenario: ScenarioKind;
  dynamicsModel: DynamicsModel;
  terminationReason: TerminationReason;
  elapsedTime: number;
  closestApproach: number;
  finalRange: number;
  finalEstimationError: number | null;
  meanNis: number | null;
  meanNees: number | null;
  observationsAccepted: number;
  observationsRejected: number;
  saturationFraction: number;
  meanControlEffort: number;
  meanActuatorTrackingError: number;
  maximumRoll: number;
  maximumPitch: number;
}

export interface EngineStep {
  snapshot?: RenderSnapshot;
  telemetry?: TelemetryBatch;
  result?: ExperimentResult;
}

export interface ConsistencySample {
  timestamp: number;
  value: number;
}
