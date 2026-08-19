export { createDefaultConfig, createPortfolioDemoConfig, hashConfig, validateConfig } from "./config";
export { acousticChannel, soundSpeedMackenzie, thorpAbsorptionDbPerKm } from "./acoustics";
export { solveIntercept, launchEnvelope } from "./intercept";
export { createAmbiguityScenarioConfig } from "./scenarios";
export type { AmbiguityPreset } from "./scenarios";
export type { InterceptSolution, LaunchEnvelope, InterceptInput } from "./intercept";
export {
  assessFireability,
  computeLaunchSolution,
} from "./fire-control";
export type { FireabilityAssessment, FireControlInput, LaunchSolution } from "./fire-control";
export {
  initialHomingState,
  trackUsable,
  updateHomingPhase,
} from "./homing";
export type { HomingState, PhaseTransition, PhaseUpdate } from "./homing";
export {
  fuzeArmedAt,
  fuzeTriggers,
  syntheticEffectiveness,
  updateFuzeArming,
} from "./fuze";
export {
  RESEARCH_INTERFACE_CAPABILITIES,
  RecordedSensorPlayback,
  SYNTHETIC_ACOUSTIC_SIGNATURES,
  syntheticRelativeLevelDb,
} from "./research-interfaces";
export type {
  RecordedSensorFrame,
  SyntheticAcousticBand,
  SyntheticAcousticSignature,
} from "./research-interfaces";
export { telemetryToCsv } from "./csv";
export { SimulationEngine, runHeadless } from "./engine";
export { ExtendedKalmanFilter } from "./ekf";
export { computeGuidance } from "./guidance";
export { solveSixDofTrim } from "./six-dof";
export { applyHydrodynamicProfile, HYDRODYNAMIC_PROFILES } from "./hydrodynamic-profiles";
export type { HydrodynamicProfile, HydrodynamicProfileId } from "./hydrodynamic-profiles";
export type {
  AcousticChannelState,
  AcousticConfig,
  EffectivenessConfig,
  EnvironmentConfig,
  ExperimentResult,
  DynamicsModel,
  FuzeConfig,
  GuidanceCommand,
  HomingPhase,
  NavigationInput,
  RenderSnapshot,
  SensorObservation,
  SimulationConfig,
  TelemetryBatch,
  TrackEstimate,
  VehicleState,
  WeaponSystemConfig,
  WeaponTelemetry,
} from "./types";
export type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from "./worker-protocol";
export { runMonteCarlo } from "../analysis/monte-carlo";
export { runFidelityStudy } from "../analysis/fidelity";
export {
  buildConsistencyReport,
  buildEnsembleConsistencyReport,
} from "../analysis/statistics";
export type {
  ConsistencyReport,
  MonteCarloReport,
  MonteCarloRunRecord,
  FidelityStudyReport,
} from "../analysis/types";
