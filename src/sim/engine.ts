import { hashConfig, validateConfig } from "./config";
import {
  depthRateAutopilot,
  type VehicleControl,
} from "./dynamics";
import { createVehicleDynamics, type VehicleDynamics } from "./dynamics-model";
import { ExtendedKalmanFilter } from "./ekf";
import { computeLaunchSolution, type LaunchSolution } from "./fire-control";
import { computeGuidance, idleGuidance } from "./guidance";
import {
  initialHomingState,
  trackUsable,
  updateHomingPhase,
  type HomingState,
  type PhaseTransition,
} from "./homing";
import {
  fuzeArmedAt,
  fuzeTriggers,
  syntheticEffectiveness,
  updateFuzeArming,
  type FuzeState,
} from "./fuze";
import {
  engagementMetrics,
  estimationError,
  normalizedEstimationErrorSquared,
} from "./metrics";
import { clamp, isFiniteArray, magnitude2, mean, subtract2 } from "./math";
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
  HomingPhase,
  RenderSnapshot,
  SeekerStatus,
  SensorObservation,
  SimulationConfig,
  TelemetryBatch,
  TelemetrySample,
  TrackEstimate,
  VehicleState,
  WeaponSystemConfig,
  WeaponTelemetry,
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
  private ekf: ExtendedKalmanFilter;
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
  // Phased-weapon state; all null when no weapon block is configured, in
  // which case the engine follows the legacy continuous-guidance path.
  private readonly weapon: WeaponSystemConfig | undefined;
  private readonly launchSolution: LaunchSolution | null = null;
  private readonly runOutHeading: number | null = null;
  private readonly enablePointAbsolute: { x: number; y: number } | null = null;
  private readonly interceptPointAbsolute: { x: number; y: number } | null = null;
  private readonly fuzeArmAt: number | null = null;
  private readonly fuzeRandom: SeededRandom | null = null;
  private readonly phaseTimeline: PhaseTransition[] = [];
  private homing: HomingState | null = null;
  private fuzeState: FuzeState | null = null;
  private distanceTravelled = 0;

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
    if (config.weapon) {
      this.weapon = config.weapon;
      this.homing = initialHomingState();
      this.fuzeState = { armed: false };
      this.fuzeArmAt = fuzeArmedAt(config.weapon);
      this.fuzeRandom = (config.weapon.fuze?.jitter ?? 0) > 0
        ? new SeededRandom(deriveSeed(config.seed, "fuze"))
        : null;
      const cruiseSpeed =
        config.weapon.speed?.cruiseSpeed ?? config.torpedo.commandedSpeed;
      // The launch solution is frozen here from the delivered track (at t=0
      // only perfect mode has one; otherwise the weapon runs out on its
      // launch heading and homes after enable).
      this.launchSolution = computeLaunchSolution({
        ownPosition: {
          x: this.torpedo.position.x,
          y: this.torpedo.position.y,
        },
        track: this.selectedTrack(),
        weapon: config.weapon,
        weaponSpeed: cruiseSpeed,
        maxRunTime: config.runtime.maxTime,
        enduranceSeconds: config.weapon.endurance?.runTime ?? null,
      });
      this.runOutHeading = this.launchSolution.solvable
        ? this.launchSolution.heading
        : this.torpedo.heading;
      const enableTime = this.launchSolution.enableTime;
      this.enablePointAbsolute = this.runOutHeading === null || enableTime <= 0
        ? null
        : {
            x: this.torpedo.position.x + Math.cos(this.runOutHeading) * cruiseSpeed * enableTime,
            y: this.torpedo.position.y + Math.sin(this.runOutHeading) * cruiseSpeed * enableTime,
          };
      this.interceptPointAbsolute = this.launchSolution.solvable
        ? {
            x: this.torpedo.position.x + this.launchSolution.interceptPoint.x,
            y: this.torpedo.position.y + this.launchSolution.interceptPoint.y,
          }
        : null;
      this.phaseTimeline.push({ phase: "run-out", startedAt: 0, reason: "launch" });
    }
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
    if (this.weapon && this.homing) {
      this.updateWeaponPhase(track);
      this.guidance = this.weaponGuidance(track);
      return;
    }
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

  /** Staleness bound that credits the modeled delivery delay of the last
 * observation: a fresh observation delayed by sensor latency plus acoustic
 * propagation must not count as stale. */
  private trackStalenessBound(): number {
    const deliveryDelay = this.latestObservation
      ? this.latestObservation.deliveredAt - this.latestObservation.observedAt
      : this.config.sensor.latency;
    return this.config.estimator.staleAfter + deliveryDelay;
  }

  private updateWeaponPhase(track: TrackEstimate | null): void {
    if (!this.weapon || !this.homing) return;
    const estimatedRange = track
      ? magnitude2(
          subtract2(track.position, {
            x: this.torpedo.position.x,
            y: this.torpedo.position.y,
          }),
        )
      : null;
    const stalenessBound = this.trackStalenessBound();
    const update = updateHomingPhase({
      state: this.homing,
      timestamp: this.timestamp,
      track,
      estimatedRange,
      distanceTravelled: this.distanceTravelled,
      weapon: this.weapon,
      stalenessBound,
    });
    this.homing = update.state;
    if (update.transition) {
      this.phaseTimeline.push(update.transition);
      if (update.transition.phase === "reacquisition") {
        // Prolonged loss invalidates the old filter's state; re-birth the
        // track so the next delivered observation re-initializes it. This
        // is an engine-level track-management policy — the estimator
        // implementation itself is untouched and legacy runs never get here.
        if (!trackUsable(track, "homing", this.weapon, stalenessBound)) {
          this.ekf = new ExtendedKalmanFilter(this.config.estimator);
        }
      }
      if (update.transition.phase === "terminal") {
        const cadenceHz = this.weapon.terminalSensor?.cadenceHz;
        if (cadenceHz !== undefined) {
          this.seeker.setCadence(cadenceHz, this.timestamp);
        }
      }
    }
  }

  private weaponGuidance(track: TrackEstimate | null): GuidanceCommand {
    const phase: HomingPhase = this.homing?.phase ?? "homing";
    if (phase === "run-out") {
      return idleGuidance(
        this.timestamp,
        this.config.guidance.law,
        this.runOutHeading ?? this.torpedo.heading,
      );
    }
    if (phase === "reacquisition") {
      // Deterministic loiter until the seeker delivers a usable track
      // again. Defaults to the vehicle's full turn rate so the search
      // sweeps the seeker through 360 degrees promptly.
      const turnRate =
        this.weapon?.phases?.searchTurnRate ??
        this.config.torpedo.parameters.maxTurnRate;
      const lateralAcceleration = turnRate * Math.max(1, this.torpedo.speed);
      return {
        timestamp: this.timestamp,
        law: this.config.guidance.law,
        lateralAcceleration,
        desiredHeading: this.torpedo.heading,
        losRate: 0,
        closingVelocity: 0,
        trackAge: track?.age ?? Number.MAX_SAFE_INTEGER,
        saturated: false,
      };
    }
    if (!track) {
      return idleGuidance(
        this.timestamp,
        this.config.guidance.law,
        this.torpedo.heading,
      );
    }
    return computeGuidance(
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
    );
  }

  private commandedSpeedForPhase(): number {
    if (!this.weapon) return this.config.torpedo.commandedSpeed;
    const cruise =
      this.weapon.speed?.cruiseSpeed ?? this.config.torpedo.commandedSpeed;
    if (this.homing?.phase === "terminal" && this.weapon.speed?.sprintSpeed !== undefined) {
      return this.weapon.speed.sprintSpeed;
    }
    return cruise;
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
      speedCommand: this.commandedSpeedForPhase(),
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

  private buildWeaponTelemetry(): WeaponTelemetry | undefined {
    if (!this.weapon || !this.homing) return undefined;
    const lastUsable = this.homing.lastUsableTrackAt;
    return {
      phase: this.homing.phase,
      phaseEnteredAt: this.homing.enteredPhaseAt,
      trackLostFor: lastUsable === null ? null : this.timestamp - lastUsable,
      enduranceRemaining:
        this.weapon.endurance?.runTime !== undefined
          ? this.weapon.endurance.runTime - this.timestamp
          : null,
      armed: this.fuzeState?.armed ?? false,
      commandedSpeed: this.torpedoControl.speedCommand,
      enablePoint: this.enablePointAbsolute,
      interceptPoint: this.interceptPointAbsolute,
    };
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
      weapon: this.buildWeaponTelemetry(),
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
      weapon: sample.weapon,
      acoustic: this.latestAcoustic,
    };
  }

  private finish(
    reason: ExperimentResult["terminationReason"],
    sample: TelemetrySample,
    fuzeMissDistance?: number,
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
    if (this.weapon) {
      this.result.phaseTimeline = [...this.phaseTimeline];
      if (fuzeMissDistance !== undefined) {
        this.result.fuzeMissDistance = fuzeMissDistance;
        this.result.effectivenessScore = this.weapon.effectiveness
          ? syntheticEffectiveness(fuzeMissDistance, this.weapon.effectiveness)
          : undefined;
      }
    }
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
    const previousTorpedoPosition = this.torpedo.position;
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
    this.distanceTravelled += Math.hypot(
      this.torpedo.position.x - previousTorpedoPosition.x,
      this.torpedo.position.y - previousTorpedoPosition.y,
      this.torpedo.position.z - previousTorpedoPosition.z,
    );
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

    if (this.weapon && this.fuzeArmAt !== null && this.fuzeState) {
      this.fuzeState = updateFuzeArming(
        this.fuzeState,
        this.timestamp,
        this.fuzeArmAt,
      );
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
    const fuzed =
      this.weapon?.fuze !== undefined &&
      this.fuzeState?.armed === true &&
      fuzeTriggers(sample.metrics.range, this.weapon.fuze, this.fuzeRandom ?? undefined);
    const exhausted =
      this.weapon?.endurance?.runTime !== undefined &&
      this.timestamp >= this.weapon.endurance.runTime;
    if (!isFiniteArray(stateValues)) this.finish("invalid-state", sample);
    else if (fuzed) this.finish("fuzed-detonation", sample, sample.metrics.range);
    else if (exhausted && this.timestamp < this.config.runtime.maxTime) {
      this.finish("endurance-exhausted", sample);
    }
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
