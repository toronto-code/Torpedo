import { hashConfig, validateConfig } from "./config";
import {
  depthRateAutopilot,
  type VehicleControl,
} from "./dynamics";
import { createVehicleDynamics, type VehicleDynamics } from "./dynamics-model";
import { ExtendedKalmanFilter } from "./ekf";
import { computeGuidance, idleGuidance } from "./guidance";
import {
  engagementMetrics,
  estimationError,
  normalizedEstimationErrorSquared,
} from "./metrics";
import { clamp, isFiniteArray, mean } from "./math";
import { deriveSeed, SeededRandom } from "./random";
import { horizontalRange, targetYawRateCommand } from "./scenario";
import { SeekerModel } from "./sensor";
import { sixDofAttitude } from "./six-dof";
import { perfectTrack, RawObservationTracker } from "./trackers";
import type {
  ConsistencySample,
  EngineStep,
  ExperimentResult,
  GuidanceCommand,
  RenderSnapshot,
  SeekerStatus,
  SensorObservation,
  SimulationConfig,
  TelemetryBatch,
  TelemetrySample,
  TrackEstimate,
  VehicleState,
} from "./types";

export interface HeadlessRun {
  result: ExperimentResult;
  telemetry: TelemetrySample[];
  consistency: {
    nis: ConsistencySample[];
    nees: ConsistencySample[];
  };
}

export class SimulationEngine {
  private readonly dt: number;
  private readonly autopilotEvery: number;
  private readonly guidanceEvery: number;
  private readonly snapshotEvery: number;
  private readonly telemetryEvery: number;
  private readonly seeker: SeekerModel;
  private readonly ekf: ExtendedKalmanFilter;
  private readonly rawTracker = new RawObservationTracker();
  private readonly torpedoDynamics: VehicleDynamics;
  private readonly targetDynamics: VehicleDynamics;
  private readonly pendingObservations: SensorObservation[] = [];
  private torpedo: VehicleState;
  private target: VehicleState;
  private tick = 0;
  private sequence = 0;
  private telemetrySequence = 0;
  private result: ExperimentResult | null = null;
  private latestObservation: SensorObservation | null = null;
  private latestAcoustic: import("./types").AcousticChannelState | null = null;
  private seekerStatus: SeekerStatus = "searching";
  private guidance: GuidanceCommand;
  private torpedoControl: VehicleControl;
  private closestApproach = Number.POSITIVE_INFINITY;
  private observationsAccepted = 0;
  private observationsRejected = 0;
  private saturationTicks = 0;
  private controlEffortSum = 0;
  private actuatorTrackingErrorSum = 0;
  private maximumRoll = 0;
  private maximumPitch = 0;
  private readonly nisSamples: ConsistencySample[] = [];
  private readonly neesSamples: ConsistencySample[] = [];
  private readonly telemetrySamples: TelemetrySample[] = [];

  constructor(readonly config: SimulationConfig) {
    validateConfig(config);
    this.dt = 1 / config.runtime.physicsHz;
    this.autopilotEvery =
      config.runtime.physicsHz / config.runtime.autopilotHz;
    this.guidanceEvery =
      config.runtime.physicsHz / config.runtime.guidanceHz;
    this.snapshotEvery =
      config.runtime.physicsHz / config.runtime.snapshotHz;
    this.telemetryEvery =
      config.runtime.physicsHz / config.runtime.telemetryHz;
    this.torpedoDynamics = createVehicleDynamics(
      config.torpedo.dynamicsModel ?? config.dynamics.model,
      config.dynamics.sixDof,
    );
    this.targetDynamics = createVehicleDynamics(
      config.target.dynamicsModel ?? "planar-2.5d",
      config.dynamics.sixDof,
    );
    this.torpedo = this.torpedoDynamics.initialize(config.torpedo);
    this.target = this.targetDynamics.initialize(config.target);
    this.guidance = idleGuidance(
      0,
      config.guidance.law,
      this.torpedo.heading,
    );
    this.torpedoControl = {
      yawRateCommand: 0,
      depthRateCommand: 0,
      speedCommand: config.torpedo.commandedSpeed,
    };
    this.seeker = new SeekerModel(
      config.sensor,
      new SeededRandom(deriveSeed(config.seed, "sensor-noise")),
      new SeededRandom(deriveSeed(config.seed, "sensor-dropout")),
      config.environment,
      config.acoustic,
      new SeededRandom(deriveSeed(config.seed, "acoustic-channel")),
    );
    this.ekf = new ExtendedKalmanFilter(config.estimator);
  }

  get timestamp(): number {
    return this.tick * this.dt;
  }

  get completed(): boolean {
    return this.result !== null;
  }

  currentSnapshot(): RenderSnapshot {
    return this.buildSnapshot(this.buildTelemetry());
  }

  private selectedTrack(): TrackEstimate | null {
    switch (this.config.guidance.mode) {
      case "perfect":
        return perfectTrack(this.target, this.timestamp);
      case "raw":
        return this.rawTracker.estimateAt(this.timestamp);
      case "ekf":
        return this.ekf.estimateAt(this.timestamp);
    }
  }

  private updateGuidance(): void {
    const track = this.selectedTrack();
    this.guidance = track
      ? computeGuidance(
          {
            timestamp: this.timestamp,
            ownPosition: {
              x: this.torpedo.position.x,
              y: this.torpedo.position.y,
            },
            ownVelocity: {
              x: this.torpedo.velocity.x,
              y: this.torpedo.velocity.y,
            },
            ownHeading: this.torpedo.heading,
            track,
          },
          this.config.guidance,
        )
      : idleGuidance(
          this.timestamp,
          this.config.guidance.law,
          this.torpedo.heading,
        );
  }

  private updateAutopilot(): void {
    const rawYawRate =
      this.guidance.lateralAcceleration / Math.max(1, this.torpedo.speed);
    const maximum = this.config.torpedo.parameters.maxTurnRate;
    this.torpedoControl = {
      yawRateCommand: clamp(rawYawRate, -maximum, maximum),
      depthRateCommand: depthRateAutopilot(
        this.config.torpedo.commandedDepth,
        this.torpedo,
        this.config.torpedo.parameters,
      ),
      speedCommand: this.config.torpedo.commandedSpeed,
    };
  }

  private sampleAndDeliverObservations(): void {
    const sample = this.seeker.sample(
      this.timestamp,
      this.torpedo,
      this.target,
    );
    if (sample) {
      this.seekerStatus = sample.status;
      this.latestAcoustic = sample.acoustic;
      if (sample.observation) {
        this.pendingObservations.push(sample.observation);
      }
    }
    while (
      this.pendingObservations.length > 0 &&
      this.pendingObservations[0].deliveredAt <= this.timestamp + 1e-10
    ) {
      const observation = this.pendingObservations.shift()!;
      this.latestObservation = observation;
      this.rawTracker.process(observation);
      const accepted = this.ekf.process(observation);
      if (accepted) this.observationsAccepted += 1;
      else this.observationsRejected += 1;
      const estimate = this.ekf.estimateAt(this.timestamp);
      if (estimate?.nis !== undefined) {
        this.nisSamples.push({
          timestamp: observation.observedAt,
          value: estimate.nis,
        });
      }
    }
  }

  private buildTelemetry(): TelemetrySample {
    const estimate = this.selectedTrack();
    const metrics = engagementMetrics(this.torpedo, this.target, estimate);
    const nees = normalizedEstimationErrorSquared(
      this.ekf.estimateAt(this.timestamp),
      this.target,
    );
    const covarianceTrace = estimate
      ? estimate.covariance.reduce(
          (sum, row, index) => sum + row[index],
          0,
        )
      : null;
    return {
      timestamp: this.timestamp,
      torpedo: this.torpedo,
      target: this.target,
      estimate,
      guidance: this.guidance,
      metrics,
      seekerStatus: this.seekerStatus,
      estimationPositionError: estimationError(estimate, this.target),
      covarianceTrace,
      nees,
      acoustic: this.latestAcoustic,
    };
  }

  private buildSnapshot(sample: TelemetrySample): RenderSnapshot {
    return {
      sequence: this.sequence++,
      timestamp: this.timestamp,
      torpedo: this.torpedo,
      target: this.target,
      estimate: sample.estimate,
      observation: this.latestObservation,
      guidance: this.guidance,
      metrics: sample.metrics,
      seekerStatus: this.seekerStatus,
      acoustic: this.latestAcoustic,
    };
  }

  private finish(
    reason: ExperimentResult["terminationReason"],
    sample: TelemetrySample,
  ): void {
    this.result = {
      seed: this.config.seed,
      configHash: hashConfig(this.config),
      mode: this.config.guidance.mode,
      law: this.config.guidance.law,
      scenario: this.config.scenario.kind,
      dynamicsModel: this.config.dynamics.model,
      terminationReason: reason,
      elapsedTime: this.timestamp,
      closestApproach: this.closestApproach,
      finalRange: sample.metrics.range,
      finalEstimationError: sample.estimationPositionError,
      meanNis: mean(this.nisSamples.map((entry) => entry.value)),
      meanNees: mean(this.neesSamples.map((entry) => entry.value)),
      observationsAccepted: this.observationsAccepted,
      observationsRejected: this.observationsRejected,
      saturationFraction:
        this.tick === 0 ? 0 : this.saturationTicks / this.tick,
      meanControlEffort: this.tick === 0 ? 0 : this.controlEffortSum / this.tick,
      meanActuatorTrackingError:
        this.tick === 0 ? 0 : this.actuatorTrackingErrorSum / this.tick,
      maximumRoll: this.maximumRoll,
      maximumPitch: this.maximumPitch,
    };
  }

  step(forceSnapshot = false): EngineStep {
    if (this.result) return { result: this.result };

    if (this.tick % this.guidanceEvery === 0) this.updateGuidance();
    if (this.tick % this.autopilotEvery === 0) this.updateAutopilot();

    const rangeBefore = horizontalRange(this.torpedo, this.target);
    const targetControl: VehicleControl = {
      yawRateCommand: targetYawRateCommand(
        this.config.scenario,
        rangeBefore,
      ),
      depthRateCommand:
        this.target.dynamicsModel === "six-dof"
          ? depthRateAutopilot(
              this.config.target.commandedDepth,
              this.target,
              this.config.target.parameters,
            )
          : 0,
      speedCommand: this.config.target.commandedSpeed,
    };
    this.torpedo = this.torpedoDynamics.integrate(
      this.torpedo,
      this.torpedoControl,
      this.config.torpedo,
      this.dt,
    );
    this.target = this.targetDynamics.integrate(
      this.target,
      targetControl,
      this.config.target,
      this.dt,
    );
    this.tick += 1;
    this.sampleAndDeliverObservations();

    const sample = this.buildTelemetry();
    if (
      this.tick % this.telemetryEvery === 0 &&
      sample.nees !== null &&
      Number.isFinite(sample.nees)
    ) {
      this.neesSamples.push({
        timestamp: this.timestamp,
        value: sample.nees,
      });
    }
    this.closestApproach = Math.min(
      this.closestApproach,
      sample.metrics.range,
    );
    if (this.guidance.saturated || this.torpedo.actuator.saturated) {
      this.saturationTicks += 1;
    }
    this.controlEffortSum += this.torpedo.actuator.controlEffort;
    this.actuatorTrackingErrorSum += this.torpedo.actuator.trackingError;
    if (this.torpedo.dynamicsModel === "six-dof") {
      const attitude = sixDofAttitude(this.torpedo);
      this.maximumRoll = Math.max(this.maximumRoll, Math.abs(attitude.roll));
      this.maximumPitch = Math.max(this.maximumPitch, Math.abs(attitude.pitch));
    }

    const stateValues = [
      this.torpedo.position.x,
      this.torpedo.position.y,
      this.torpedo.position.z,
      this.target.position.x,
      this.target.position.y,
      this.target.position.z,
      sample.metrics.range,
      this.torpedo.orientation.w,
      this.torpedo.orientation.x,
      this.torpedo.orientation.y,
      this.torpedo.orientation.z,
      this.torpedo.bodyVelocity.x,
      this.torpedo.bodyVelocity.y,
      this.torpedo.bodyVelocity.z,
      this.torpedo.angularVelocity.x,
      this.torpedo.angularVelocity.y,
      this.torpedo.angularVelocity.z,
    ];
    if (!isFiniteArray(stateValues)) this.finish("invalid-state", sample);
    else if (sample.metrics.range <= this.config.interceptRadius) {
      this.finish("intercept", sample);
    } else if (this.timestamp >= this.config.runtime.maxTime) {
      this.finish("timeout", sample);
    }

    const output: EngineStep = {};
    if (this.tick % this.telemetryEvery === 0 || this.result) {
      this.telemetrySamples.push(sample);
      const batch: TelemetryBatch = {
        sequence: this.telemetrySequence++,
        samples: [sample],
      };
      output.telemetry = batch;
    }
    if (forceSnapshot || this.tick % this.snapshotEvery === 0 || this.result) {
      output.snapshot = this.buildSnapshot(sample);
    }
    if (this.result) output.result = this.result;
    return output;
  }

  runToCompletion(): HeadlessRun {
    while (!this.completed) this.step();
    return {
      result: this.result!,
      telemetry: [...this.telemetrySamples],
      consistency: {
        nis: [...this.nisSamples],
        nees: [...this.neesSamples],
      },
    };
  }
}

export function runHeadless(config: SimulationConfig): HeadlessRun {
  return new SimulationEngine(config).runToCompletion();
}
