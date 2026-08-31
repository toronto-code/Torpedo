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
import { clamp, isFiniteArray, magnitude2, mean, subtract2, wrapAngle } from "./math";
import { deriveSeed, SeededRandom } from "./random";
import { horizontalRange, targetYawRateCommand } from "./scenario";
import {
  activateDecoy,
  contactControl,
  createContactRuntime,
  type ContactRuntime,
} from "./contacts";
import { SeekerModel, type SeekerContact } from "./sensor";
import { MultiTargetTracker, type TrackFeatures } from "./tracker";
import { ContactClassifier, type TrackClassification } from "./classify";
import {
  defaultDoctrine,
  initialTewaState,
  manualAuthorize,
  updateTewa,
  type TewaCandidate,
  type TewaState,
} from "./tewa";
import { sixDofAttitude } from "./six-dof";
import { perfectTrack, RawObservationTracker } from "./trackers";
import type {
  ConsistencySample,
  ContactTruth,
  EngagementTelemetry,
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
  // Multi-contact state; null keeps the legacy single-target path.
  private readonly contactRuntimes: ContactRuntime[] | null = null;
  private readonly contactStreams: {
    noise: SeededRandom;
    dropout: SeededRandom;
    channel: SeededRandom;
  }[] = [];
  private tracker: MultiTargetTracker | null = null;
  private readonly classifier = new ContactClassifier();
  private tewa: TewaState = initialTewaState();
  private lastCandidates: TewaCandidate[] = [];
  // Cached designated-track -> truth-contact pairing. Recomputed only when
  // the designation changes so metrics cannot flap between contacts when
  // two of them pass near the estimate.
  private pairedDesignatedTrackId: number | null = null;
  private pairedContactId: string | null = null;

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
    if (config.contacts && config.contacts.length > 0) {
      this.contactRuntimes = config.contacts.map((spec) =>
        createContactRuntime(spec, config),
      );
      this.contactStreams = config.contacts.map((spec) => ({
        noise: new SeededRandom(deriveSeed(config.seed, `contact-noise-${spec.id}`)),
        dropout: new SeededRandom(deriveSeed(config.seed, `contact-dropout-${spec.id}`)),
        channel: new SeededRandom(deriveSeed(config.seed, `contact-channel-${spec.id}`)),
      }));
      const primary =
        this.designatedContactRuntime() ?? this.primaryContactRuntime();
      if (primary) this.target = primary.state;
      if (config.guidance.mode === "raw" || config.guidance.mode === "ekf") {
        this.tracker = new MultiTargetTracker(
          {
            estimator: config.estimator,
            confirmationCount: 5,
            tentativeTimeout: 2.5,
            deletionTimeout: 6,
          },
          config.guidance.mode,
        );
      }
    }
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
    if (this.contactRuntimes) {
      const designation = this.tewa.designation;
      if (!designation) return null;
      if (this.tracker) {
        return this.tracker.estimateForTrack(this.timestamp, designation.trackId);
      }
      const candidate = this.lastCandidates.find(
        (entry) => entry.trackId === designation.trackId,
      );
      return candidate?.estimate ?? null;
    }
    switch (this.config.guidance.mode) {
      case "perfect":
        return perfectTrack(this.target, this.timestamp);
      case "raw":
        return this.rawTracker.estimateAt(this.timestamp);
      case "ekf":
        return this.ekf.estimateAt(this.timestamp);
    }
  }

  /**
   * The tracked picture the TEWA layer sees: live tracks with accumulated
   * classification. Perfect mode mirrors truth contacts with zero-noise
   * kinematics; classification still runs on features so ablations remain
   * comparable.
   */
  private buildTrackPicture(): TewaCandidate[] {
    if (!this.contactRuntimes) return [];
    if (this.tracker) {
      return this.tracker.liveTracks(this.timestamp).map((track) => ({
        trackId: track.meta.id,
        estimate: track.estimate,
        quality: track.meta.quality,
        classification: this.classifier.update(
          track.meta.id,
          this.timestamp,
          track.estimate,
          track.meta.features,
        ),
      }));
    }
    return this.contactRuntimes
      .filter((runtime) => runtime.active)
      .map((runtime, index) => {
        const trackId = -(index + 1);
        const estimate = perfectTrack(runtime.state, this.timestamp);
        const features: TrackFeatures = {
          impliedTargetStrengthDb: runtime.spec.targetStrengthDb ?? null,
          snrDb: null,
          signatureCorrelation: runtime.spec.friendlySignature ?? 0.1,
          observationCount: 1,
        };
        const classification: TrackClassification = this.classifier.update(
          trackId,
          this.timestamp,
          estimate,
          features,
        );
        return { trackId, estimate, quality: "confirmed", classification };
      });
  }

  /** Operator authorization (manual override; logged as a pipeline event). */
  authorize(): void {
    if (!this.contactRuntimes) return;
    this.tewa = manualAuthorize(this.tewa, this.timestamp);
  }

  get engagementAuthorized(): boolean {
    return this.contactRuntimes === null || this.tewa.authorized;
  }

  /** Primary (hostile-first) active contact; drives legacy-oriented
   * termination/metrics until designation replaces it. */
  private primaryContactRuntime(): ContactRuntime | null {
    if (!this.contactRuntimes) return null;
    return (
      this.contactRuntimes.find(
        (runtime) => runtime.active && runtime.spec.kind === "hostile-sub",
      ) ??
      this.contactRuntimes.find((runtime) => runtime.active) ??
      null
    );
  }

  /**
   * Truth contact paired with the designated track for metrics/termination
   * (truth-side usage, like the range check — never fed to control). Falls
   * back to the primary hostile contact without a designation.
   */
  private designatedContactRuntime(): ContactRuntime | null {
    if (!this.contactRuntimes) return null;
    const designation = this.tewa.designation;
    if (designation) {
      // A live cached pairing wins; recompute only on designation change.
      if (
        this.pairedDesignatedTrackId === designation.trackId &&
        this.pairedContactId !== null
      ) {
        const cached = this.contactRuntimes.find(
          (runtime) => runtime.spec.id === this.pairedContactId,
        );
        if (cached?.active) return cached;
      }
      const candidate = this.lastCandidates.find(
        (entry) => entry.trackId === designation.trackId,
      );
      if (candidate) {
        let best: ContactRuntime | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const runtime of this.contactRuntimes) {
          if (!runtime.active) continue;
          const distance = Math.hypot(
            runtime.state.position.x - candidate.estimate.position.x,
            runtime.state.position.y - candidate.estimate.position.y,
          );
          if (distance < bestDistance) {
            bestDistance = distance;
            best = runtime;
          }
        }
        if (best) {
          this.pairedDesignatedTrackId = designation.trackId;
          this.pairedContactId = best.spec.id;
          return best;
        }
      }
    }
    this.pairedDesignatedTrackId = null;
    this.pairedContactId = null;
    return this.primaryContactRuntime();
  }

  /** Nearest active truth contact in full 3D (fuze/termination scoring). */
  private nearestActiveContact(): { runtime: ContactRuntime; separation: number } | null {
    if (!this.contactRuntimes) return null;
    let best: { runtime: ContactRuntime; separation: number } | null = null;
    for (const runtime of this.contactRuntimes) {
      if (!runtime.active) continue;
      const separation = Math.hypot(
        runtime.state.position.x - this.torpedo.position.x,
        runtime.state.position.y - this.torpedo.position.y,
        runtime.state.position.z - this.torpedo.position.z,
      );
      if (!best || separation < best.separation) best = { runtime, separation };
    }
    return best;
  }

  private updateGuidance(): void {
    if (this.tracker) this.tracker.prune(this.timestamp);
    if (this.contactRuntimes) {
      // TEWA: build the classified track picture, run selection and the
      // authorization doctrine, then gate the engagement.
      this.lastCandidates = this.buildTrackPicture();
      this.tewa = updateTewa({
        state: this.tewa,
        now: this.timestamp,
        candidates: this.lastCandidates,
        ownPosition: {
          x: this.torpedo.position.x,
          y: this.torpedo.position.y,
        },
        doctrine: this.config.doctrine ?? defaultDoctrine(),
      });
      if (!this.tewa.authorized) {
        // Hold fire: maintain a deterministic orbit standoff around the
        // best tracked candidate so the seeker keeps the contact group in
        // view while authorization is pending, instead of overshooting or
        // spinning the field of view away. Pure guidance-side behavior;
        // the phase machine and seeker are untouched.
        const STANDOFF_RANGE = 1500;
        const candidate = this.lastCandidates.find(
          (entry) => entry.classification.best === "sub-like",
        ) ?? this.lastCandidates[0];
        let desiredHeading = this.torpedo.heading;
        if (candidate) {
          const dx = candidate.estimate.position.x - this.torpedo.position.x;
          const dy = candidate.estimate.position.y - this.torpedo.position.y;
          const bearing = Math.atan2(dy, dx);
          const range = Math.hypot(dx, dy);
          // Inside the standoff, fly a gentle inward spiral (heading offset
          // 45 deg off the bearing) so the seeker — a +/-50 deg half-angle
          // field — keeps the contact group in view instead of pointing the
          // nose tangent and staring away from the contacts.
          desiredHeading =
            range > STANDOFF_RANGE
              ? bearing
              : bearing + Math.PI / 4;
        }
        const headingError = wrapAngle(desiredHeading - this.torpedo.heading);
        const lateralAcceleration = Math.min(
          this.config.guidance.maxLateralAcceleration,
          headingError * Math.max(1, this.torpedo.speed) * 0.6,
        );
        this.guidance = {
          timestamp: this.timestamp,
          law: this.config.guidance.law,
          lateralAcceleration,
          desiredHeading,
          losRate: 0,
          closingVelocity: 0,
          trackAge: candidate?.estimate.age ?? Number.MAX_SAFE_INTEGER,
          saturated: false,
        };
        return;
      }
    }
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
        const terminalFov = this.weapon.terminalSensor?.fovHalfAngle;
        if (terminalFov !== undefined) {
          this.seeker.setFov(terminalFov);
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
    if (this.contactRuntimes) {
      const seekerContacts: SeekerContact[] = this.contactRuntimes
        .filter((runtime) => runtime.active)
        .map((runtime) => ({
          state: runtime.state,
          targetStrengthDb: runtime.spec.targetStrengthDb
            ?? this.config.acoustic?.targetStrengthDb
            ?? 0,
          echoFluctuation: runtime.spec.echoFluctuation,
          friendlySignature: runtime.spec.friendlySignature,
        }));
      const samples = this.seeker.sampleContacts(
        this.timestamp,
        this.torpedo,
        seekerContacts,
        this.contactStreams,
        {
          noise: new SeededRandom(0),
          dropout: new SeededRandom(0),
          channel: new SeededRandom(0),
        },
      );
      if (samples) {
        const locked = samples.find((sample) => sample.status === "locked");
        this.seekerStatus = locked
          ? "locked"
          : (samples[0]?.status ?? "searching");
        this.latestAcoustic =
          samples.find((sample) => sample.acoustic)?.acoustic ?? null;
        for (const sample of samples) {
          if (sample.observation) {
            this.pendingObservations.push(sample.observation);
          }
        }
      }
      this.deliverPendingObservations();
      return;
    }
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
    this.deliverPendingObservations();
  }

  private deliverPendingObservations(): void {
    while (
      this.pendingObservations.length > 0 &&
      this.pendingObservations[0].deliveredAt <= this.timestamp + 1e-10
    ) {
      const observation = this.pendingObservations.shift()!;
      this.latestObservation = observation;
      if (this.tracker) {
        const result = this.tracker.process(this.timestamp, observation);
        if (result.accepted) this.observationsAccepted += 1;
        else this.observationsRejected += 1;
        continue;
      }
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

  private buildEngagementTelemetry(): EngagementTelemetry | undefined {
    if (!this.contactRuntimes) return undefined;
    return {
      authorized: this.tewa.authorized,
      designatedTrackId: this.tewa.designation?.trackId ?? null,
      tracks: this.lastCandidates.map((candidate) => ({
        trackId: candidate.trackId,
        quality: candidate.quality,
        classification: candidate.classification.best,
        confidence: candidate.classification.confidence,
        range: Math.hypot(
          candidate.estimate.position.x - this.torpedo.position.x,
          candidate.estimate.position.y - this.torpedo.position.y,
        ),
      })),
    };
  }

  private buildContactTruth(): ContactTruth[] | undefined {
    if (!this.contactRuntimes) return undefined;
    return this.contactRuntimes.map((runtime) => ({
      id: runtime.spec.id,
      kind: runtime.spec.kind,
      position: runtime.state.position,
      velocity: runtime.state.velocity,
      heading: runtime.state.heading,
      speed: runtime.state.speed,
      depth: runtime.state.depth,
      active: runtime.active,
    }));
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
      contacts: this.buildContactTruth(),
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
      contacts: sample.contacts,
      engagement: this.buildEngagementTelemetry(),
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
    if (this.contactRuntimes) {
      this.result.tewaEvents = this.tewa.events.map((event) => ({ ...event }));
      const nearest = this.nearestActiveContact();
      if (
        (reason === "fuzed-detonation" || reason === "intercept") &&
        nearest
      ) {
        this.result.engagedContact = {
          id: nearest.runtime.spec.id,
          kind: nearest.runtime.spec.kind,
        };
        this.result.engagementOutcome =
          nearest.runtime.spec.kind === "hostile-sub"
            ? "correct-hostile"
            : nearest.runtime.spec.kind === "decoy"
              ? "decoy-seduction"
              : "wrong-contact";
      } else {
        this.result.engagementOutcome = "miss";
      }
    }
  }

  step(forceSnapshot = false): EngineStep {
    if (this.result) return { result: this.result };

    if (this.tick % this.guidanceEvery === 0) this.updateGuidance();
    if (this.tick % this.autopilotEvery === 0) this.updateAutopilot();

    const rangeBefore = horizontalRange(this.torpedo, this.target);
    const previousTorpedoPosition = this.torpedo.position;
    if (this.contactRuntimes) {
      for (const runtime of this.contactRuntimes) {
        if (!runtime.active) {
          const behavior = runtime.spec.behavior;
          if (behavior?.kind === "decoy") {
            const runtimes = this.contactRuntimes;
            const spawnerId =
              runtime.spec.deployedBy ??
              runtimes.find((c) => c.spec.kind === "hostile-sub")?.spec.id ??
              "";
            const spawner =
              runtimes.find((candidate) => candidate.spec.id === spawnerId) ??
              this.primaryContactRuntime();
            const spawnerRange = spawner
              ? horizontalRange(this.torpedo, spawner.state)
              : Number.POSITIVE_INFINITY;
            if (spawner && spawnerRange <= behavior.triggerRange) {
              activateDecoy(runtime, spawner);
            }
          }
          if (!runtime.active) continue;
        }
        const control = contactControl(runtime, rangeBefore, this.timestamp);
        runtime.state = runtime.dynamics.integrate(
          runtime.state,
          control,
          runtime.spec.vehicle,
          this.dt,
        );
      }
      const primary =
        this.designatedContactRuntime() ?? this.primaryContactRuntime();
      if (primary) this.target = primary.state;
      this.torpedo = this.torpedoDynamics.integrate(
        this.torpedo,
        this.torpedoControl,
        this.config.torpedo,
        this.dt,
      );
    } else {
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
    }
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
      ...(this.contactRuntimes ?? []).flatMap((runtime) => [
        runtime.state.position.x,
        runtime.state.position.y,
        runtime.state.position.z,
      ]),
    ];
    const nearest = this.nearestActiveContact();
    const proximityRange = nearest ? nearest.separation : sample.metrics.range;
    const fuzed =
      this.weapon?.fuze !== undefined &&
      this.fuzeState?.armed === true &&
      fuzeTriggers(
        proximityRange,
        this.weapon.fuze,
        this.fuzeRandom ?? undefined,
      );
    const exhausted =
      this.weapon?.endurance?.runTime !== undefined &&
      this.timestamp >= this.weapon.endurance.runTime;
    // Multi-contact termination uses the nearest true contact (proximity
    // scoring, like the fuze); legacy keeps the designated single target.
    if (!isFiniteArray(stateValues)) this.finish("invalid-state", sample);
    else if (fuzed) {
      this.finish("fuzed-detonation", sample, proximityRange);
    }
    else if (exhausted && this.timestamp < this.config.runtime.maxTime) {
      this.finish("endurance-exhausted", sample);
    }
    else if (proximityRange <= this.config.interceptRadius) {
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
