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

export type HomingPhase = "run-out" | "homing" | "terminal" | "reacquisition";

/** Ground-truth contact category. Truth-only: never exposed to the
 *  observation/classification/selection pipeline. */
export type ContactKind =
  | "hostile-sub"
  | "friendly-sub"
  | "commercial-surface"
  | "biological"
  | "decoy"
  | "knuckle"
  | "ambiguous";

export type ContactBehavior =
  | { kind: "constant-velocity" }
  | { kind: "constant-turn"; rate: number }
  | { kind: "scripted-evasive"; triggerRange: number; rate: number }
  | { kind: "biologic-wander"; amplitude: number; period: number }
  | { kind: "decoy"; triggerRange: number; deploySpeed: number; headingOffset?: number }
  /** Stationary turbulence echo ejected by a hard turn (the classic
   *  last-dish countermeasure): drifts slowly, echo strength decays. */
  | { kind: "knuckle"; triggerRange: number; driftSpeed: number; fadeDbPerS: number };

export interface ContactSpec {
  id: string;
  kind: ContactKind;
  vehicle: VehicleConfig;
  /** Per-contact acoustic target strength (dB) for the link budget. */
  targetStrengthDb?: number;
  /** Synthetic broadband radiated-noise level (dB re 1 µPa @ 1 m) heard by
   *  a passive listener. Absent keeps the contact passive-silent (no
   *  passive feature is measured). */
  radiatedNoiseDb?: number;
  /** Deterministic echo-strength fluctuation (dB) for ambiguous contacts. */
  echoFluctuation?: { amplitudeDb: number; period: number };
  /** Aspect-dependent echo: TS = bow + (beam - bow) * sin^2(aspect), where
   *  aspect is the angle between the contact's heading and the line to the
   *  weapon. Decoys without this stay aspect-invariant — a discrimination
   *  cue. Overrides targetStrengthDb when present. */
  aspectEcho?: { bowDb: number; beamDb: number };
  behavior?: ContactBehavior;
  /** Contact that launches this decoy once the weapon closes (decoys only). */
  deployedBy?: string;
  /** Synthetic friendly-marking correlation the seeker receiver reports
   *  (0..1): a fictional IFF analog carried as a measurement feature. */
  friendlySignature?: number;
  /** Truth-side threat perception (hearing the weapon's pings). */
  perception?: TargetPerceptionConfig;
}

/** Truth contact state in telemetry/snapshots; consumed by rendering and
 *  scoring only, never by estimation or control. */
export interface ContactTruth {
  id: string;
  kind: ContactKind;
  position: Vec3;
  velocity: Vec3;
  heading: number;
  speed: number;
  depth: number;
  active: boolean;
}

/** Engagement doctrine (fictional). Drives legitimacy, selection, and the
 *  authorization gate; consumes classification state only, never truth. */
export interface DoctrineConfig {
  mode: "manual" | "autonomous";
  /** Minimum classification confidence required to authorize. */
  requiredConfidence: number;
  /** Classes that may never be designated or engaged. */
  excludedClasses: string[];
  /** Optional maximum designation range (m). */
  engagementMaxRange?: number;
  /** Seconds the doctrine must hold before autonomous authorization. */
  autoAuthorizeSustain: number;
  /** Optional minimum track age (s) before autonomous authorization: the
   *  picture-development window during which classification evidence
   *  matures. Absent authorizes on confidence alone. */
  minTrackAgeS?: number;
  /** Optional maximum designated-track 2-sigma position uncertainty (m)
   *  for autonomous authorization: the fire-control solution must have
   *  converged before the weapon commits. */
  maxSolutionSigmaM?: number;
  /** Minimum seconds a designation is held before switching. */
  redesignateAfter: number;
  /** Score margin a challenger needs to take the designation. */
  redesignateMargin: number;
}

export interface WeaponPhasesConfig {
  /** Run-out duration before homing enables (s). */
  enableTime?: number;
  /** Alternative to enableTime: along-track run-out distance (m). */
  enableDistance?: number;
  /** Estimated range gate (m) that starts the terminal phase. */
  terminalRange?: number;
  /** Seconds of lost track before the reacquisition search begins. */
  reacquireAfter?: number;
  /** Deterministic loiter turn rate during reacquisition (rad/s). */
  searchTurnRate?: number;
}

export interface WeaponSpeedConfig {
  /** Commanded speed during run-out and midcourse homing (m/s). */
  cruiseSpeed?: number;
  /** Commanded sprint speed in the terminal phase (m/s). */
  sprintSpeed?: number;
  /** Quiet search speed during reacquisition (m/s): slowing cuts flow
   *  self-noise and widens the effective detection cone, like a real
   *  heavyweight weapon that searches slow and sprints to kill. */
  searchSpeed?: number;
}

export interface WeaponEnduranceConfig {
  /** Total powered run time from launch (s). Legacy time budget. */
  runTime?: number;
  /** Optional energy-budget endurance: drains with speed-cubed drag power
   *  plus a hotel load. When present it replaces the time budget. */
  battery?: {
    /** Fictional usable energy (watt-seconds). */
    capacityWs: number;
    /** Constant electronics load (W). */
    hotelW: number;
    /** Drag power coefficient: P = dragKW * speed^3 (W). */
    dragKW: number;
  };
}

export interface WeaponTerminalSensorConfig {
  /** Seeker cadence during the terminal phase (Hz, <= 50). */
  cadenceHz?: number;
  /** Stricter association gate applied to estimate NIS in terminal. */
  innovationGate?: number;
  /** Wider seeker half-angle during the terminal phase (rad). */
  fovHalfAngle?: number;
}

export interface FuzeConfig {
  /** True 3D proximity trigger radius (m). */
  detectionRadius?: number;
  /** Doppler-style discrimination: contacts moving slower than this
   *  (m/s) cannot actuate the fuze. Absent keeps the plain radius test. */
  minTargetSpeedMs?: number;
  /** Seeded actuation jitter on the trigger radius (m, default 0). */
  jitter?: number;
  /** Seconds after launch before the fuze arms (defaults to enable time). */
  armDelay?: number;
}

export interface EffectivenessConfig {
  /** Fictional 50%-effectiveness miss distance scale (m). */
  lethalRadius?: number;
  /** Shape exponent of the synthetic effectiveness function. */
  shape?: number;
}

/**
 * Optional phased-weapon engagement configuration. Absent block keeps the
 * legacy continuous-guidance behavior bit-identical: termination stays the
 * plain intercept radius and no fuze or effectiveness scoring exists.
 */
export interface WeaponSystemConfig {
  phases?: WeaponPhasesConfig;
  speed?: WeaponSpeedConfig;
  endurance?: WeaponEnduranceConfig;
  terminalSensor?: WeaponTerminalSensorConfig;
  fuze?: FuzeConfig;
  effectiveness?: EffectivenessConfig;
  /** Seeker employment: active from launch (default), or a silent passive
   *  midcourse that goes active only when the terminal phase begins. */
  sensorPolicy?: "active" | "passive-midcourse";
  /** Radiated noise of the weapon itself (truth side): a target with
   *  perception hears this instead of pings while the seeker is passive.
   *  Sprinting loudly advertises; quiet search speed stays stealthy. */
  radiatedNoise?: SelfNoiseConfig;
}

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
  /** Optional initial pitch (rad, nose-up positive). */
  pitch?: number;
  /** Optional initial roll (rad, starboard-down positive). */
  roll?: number;
  /** Optional initial vertical speed (m/s, positive down). */
  verticalSpeed?: number;
  speed: number;
  depth: number;
}

export interface VehicleConfig {
  initial: VehicleInitialState;
  parameters: VehicleParameters;
  commandedSpeed: number;
  commandedDepth: number;
  /**
   * Optional per-vehicle dynamics selection. When absent the vehicle follows
   * `dynamics.model`. Setting `six-dof` on the tracked target is the opt-in
   * for full 3D target motion; default scenarios keep the target planar so
   * paired fidelity studies continue to isolate guided-vehicle fidelity.
   */
  dynamicsModel?: DynamicsModel;
}

export interface SelfNoiseConfig {
  /** Receiver self-noise floor at zero speed (dB). */
  baseDb: number;
  /** Self-noise increase per m/s of own speed (dB per m/s). */
  dbPerMs: number;
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
  /** Optional speed-dependent self-noise; absent keeps the legacy channel. */
  selfNoise?: SelfNoiseConfig;
  /** Optional 1-sigma noise on depression-angle-derived contact depth (m).
   *  Only the multi-return path reports depth; absent keeps observations
   *  bit-identical to the legacy stream. */
  depthSigmaM?: number;
}

export interface EnvironmentConfig {
  temperatureC: number;
  salinityPsu: number;
  waterDepth: number;
  spreadingCoefficient: number;
  /** Optional depth-dependent sound-speed profile with simplified
   *  refraction shadowing. Absent keeps the homogeneous-water channel. */
  soundProfile?: SoundProfileConfig;
}

/** Synthetic piecewise profile: a mixed surface layer of near-constant
 *  speed, a thermocline drop, and a deep isothermal rise. When the source
 *  and receiver straddle the layer the direct path bends away and takes an
 *  extra transmission loss, creating a mid-range shadow band that fades
 *  with range. All values synthetic. */
export interface SoundProfileConfig {
  /** Base of the mixed layer (m, positive down). */
  layerDepth: number;
  /** Sound-speed decrease from the layer base to the thermocline minimum (m/s). */
  thermoclineDrop: number;
  /** Deep isothermal gradient (m/s per m, positive down). */
  deepGradient: number;
  /** Extra one-way loss when the path straddles the layer (dB). */
  layerLossDb: number;
  /** Range inside which the full layer loss applies (m). */
  recoveryRange: number;
  /** Range over which the layer loss fades out beyond recoveryRange (m). */
  fadeWidth: number;
}

/** Truth-side threat perception for a contact: hears the weapon's active
 *  pings and, after a sustained detection, evades — turning away, diving
 *  below the layer, and optionally slowing. Synthetic. */
export interface TargetPerceptionConfig {
  /** Detection threshold on heard SNR (dB). */
  detectionThresholdDb: number;
  /** Logistic transition width (dB). */
  detectionTransitionDb: number;
  /** Sustained detection required before reacting (s). */
  reactionDelay: number;
  /** Detection grace before the reaction is dropped (s). */
  reactionGrace: number;
  /** Maximum evasive turn rate (rad/s, magnitude). */
  evasiveRate: number;
  /** Commanded depth once reacting — typically below the layer (m). */
  diveDepth?: number;
  /** Speed multiplier once reacting (going quiet). */
  quietFactor?: number;
  /** Bearing-estimate noise of the heard threat (rad). */
  bearingSigmaRad: number;
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
  /** Extra one-way loss from refraction across the layer (dB), when a
   *  sound profile is configured. */
  refractionLossDb?: number;
}

export interface EstimatorConfig {
  accelerationNoise: number;
  initialVelocityVariance: number;
  innovationGate: number;
  staleAfter: number;
  /** Optional maneuver adaptation: when an innovation exceeds the gate, the
   *  update is retried once with process noise inflated by this factor (the
   *  constant-velocity model momentarily distrustusted, as in a Singer-style
   *  maneuver model) and accepted if it then passes. Absent keeps the
   *  fixed-noise filter bit-identical. */
  maneuverNoiseScale?: number;
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
  /** Multi-contact scene. Absent keeps the single-`target` legacy engagement
   *  bit-identical. */
  contacts?: ContactSpec[];
  doctrine?: DoctrineConfig;
  weapon?: WeaponSystemConfig;
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
  /** Echo-derived feature: implied target strength (dB) with spreading
   *  removed. A measurement feature, not an identity. */
  impliedTargetStrengthDb?: number;
  /** Synthetic friendly-marking correlation (0..1); a fictional IFF analog
   *  measured by the receiver. A measurement feature, not an identity. */
  signatureCorrelation?: number;
  /** Depression-angle-derived contact depth (m, positive down). Consumed
   *  only by depth steering, never by the horizontal estimator. Absent on
   *  the legacy single-return path. */
  targetDepth?: number;
  /** Passive radiated-noise SNR (dB) at the weapon's receiver. A
   *  measurement feature for classification; independent of the active
   *  echo path. */
  passiveSnrDb?: number;
  /** Bearing-only (passive) measurement: range carries a nominal prior
   *  with a huge variance and is ignored by the filter's update — range
   *  stays unobservable until own-ship geometry diversifies. */
  bearingOnly?: boolean;
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

/** Multi-contact engagement state for display: the classified track table
 *  and authorization status. Estimate data only — no truth identity. */
export interface EngagementTelemetry {
  authorized: boolean;
  designatedTrackId: number | null;
  tracks: {
    trackId: number;
    quality: string;
    classification: string;
    confidence: number;
    range: number;
  }[];
}

/** Per-sample weapon engagement state; present only with a weapon block. */
export interface WeaponTelemetry {
  phase: HomingPhase;
  phaseEnteredAt: number;
  /** Seconds since the track was last usable (null when never usable). */
  trackLostFor: number | null;
  enduranceRemaining: number | null;
  armed: boolean;
  commandedSpeed: number;
  /** Current seeker employment ("passive" during a silent midcourse). */
  sensorMode?: "passive" | "active";
  /** Designated track 2-sigma position uncertainty (m); the TMA solution
   *  quality. Null when no track is held. */
  solutionSigmaM?: number | null;
  /** Frozen launch solution advisory (estimate symbology, not truth). */
  enablePoint: Vec2 | null;
  interceptPoint: Vec2 | null;
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
  weapon?: WeaponTelemetry;
  contacts?: ContactTruth[];
  engagement?: EngagementTelemetry;
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
  weapon?: WeaponTelemetry;
  contacts?: ContactTruth[];
  engagement?: EngagementTelemetry;
  acoustic?: AcousticChannelState | null;
}

export type TerminationReason =
  | "intercept"
  | "timeout"
  | "invalid-state"
  | "fuzed-detonation"
  | "endurance-exhausted";

/** Engagement correctness outcome (multi-contact scoring; truth-consuming,
 *  results only). */
export type EngagementOutcome =
  | "correct-hostile"
  | "decoy-seduction"
  | "wrong-contact"
  | "miss";

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
  /** Weapon engagement timeline; present only with a weapon block. */
  phaseTimeline?: { phase: HomingPhase; startedAt: number; reason: string }[];
  /** True 3D separation at fuze actuation (m). */
  fuzeMissDistance?: number;
  /** Synthetic effectiveness score in [0, 1]; fictional calibration. */
  effectivenessScore?: number;
  /** Multi-contact engagement scoring (truth-consuming, results only). */
  engagedContact?: { id: string; kind: ContactKind };
  engagementOutcome?: EngagementOutcome;
  tewaEvents?: { stage: string; at: number; detail: string }[];
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
