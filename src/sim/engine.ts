import { thorpAbsorptionDbPerKm } from "./acoustics";
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
  initialFuzeState,
  updateProximityFuze,
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
  activateKnuckle,
  contactControl,
  createContactRuntime,
  effectiveTargetStrength,
  type ContactRuntime,
} from "./contacts";
import { SeekerModel, type SeekerContact } from "./sensor";
import { updateTargetPerception } from "./target-perception";
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
  private energyRemainingWs: number | null = null;
  // Multi-contact state; null keeps the legacy single-target path.
  private readonly contactRuntimes: ContactRuntime[] | null = null;
  private readonly contactStreams: {
    noise: SeededRandom;
    dropout: SeededRandom;
    channel: SeededRandom;
    depth: SeededRandom | null;
    passive: SeededRandom;
    perception: SeededRandom | null;
  }[] = [];
  private tracker: MultiTargetTracker | null = null;
  private perceptionIndices: number[] = [];
  private lastPingAt: number | null = null;
  private readonly classifier = new ContactClassifier();
  private tewa: TewaState = initialTewaState();
  private lastCandidates: TewaCandidate[] = [];
  // Cached designated-track -> truth-contact pairing. Recomputed only when
  // the designation changes so metrics cannot flap between contacts when
  // two of them pass near the estimate.
  private pairedDesignatedTrackId: number | null = null;
  private pairedContactId: string | null = null;
  // Last measurement-derived depth target (m down). Latched so a momentary
  // designation drop during track loss does not snap the weapon back to its
  // launch depth — which would put it back above the layer and strand the
  // reacquisition search in the refraction shadow.
  private heldDepthTarget: number | null = null;
  // True once a passive-midcourse seeker has gone active (terminal entry).
  private sensorActivated = false;

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
        depth: config.sensor.depthSigmaM !== undefined
          ? new SeededRandom(deriveSeed(config.seed, `contact-depth-${spec.id}`))
          : null,
        passive: new SeededRandom(deriveSeed(config.seed, `contact-passive-${spec.id}`)),
        perception: spec.perception
          ? new SeededRandom(deriveSeed(config.seed, `contact-perception-${spec.id}`))
          : null,
      }));
      this.perceptionIndices = config.contacts
        .map((spec, index) => (spec.perception ? index : -1))
        .filter((index) => index >= 0);
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
      this.energyRemainingWs = config.weapon.endurance?.battery?.capacityWs ?? null;
      this.homing = initialHomingState();
      this.fuzeState = initialFuzeState();
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
        depth: track.meta.depth,
        createdAt: track.meta.createdAt,
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
        const passiveLevel = runtime.spec.radiatedNoiseDb;
        const passiveEnvironment = this.config.environment;
        const passiveAcoustic = this.config.acoustic;
        const passiveSnrDb =
          passiveLevel === undefined ||
          !passiveEnvironment ||
          !passiveAcoustic?.enabled
            ? null
            : passiveLevel -
              (passiveEnvironment.spreadingCoefficient *
                Math.log10(
                  Math.max(
                    1,
                    Math.hypot(
                      runtime.state.position.x - this.torpedo.position.x,
                      runtime.state.position.y - this.torpedo.position.y,
                    ),
                  ),
                ) +
                thorpAbsorptionDbPerKm(passiveAcoustic.frequencyKhz) *
                  Math.hypot(
                    runtime.state.position.x - this.torpedo.position.x,
                    runtime.state.position.y - this.torpedo.position.y,
                  ) /
                  1000) -
              passiveAcoustic.ambientNoiseDb;
        const features: TrackFeatures = {
          impliedTargetStrengthDb: effectiveTargetStrength(
            runtime,
            { x: this.torpedo.position.x, y: this.torpedo.position.y },
            this.config.acoustic?.targetStrengthDb ?? 0,
            this.timestamp,
          ),
          impliedTsSigmaDb: null,
          snrDb: null,
          signatureCorrelation: runtime.spec.friendlySignature ?? 0.1,
          depthRateMPerS: Math.abs(runtime.state.depthRate),
          passiveSnrDb,
          observationCount: 1,
        };
        const classification: TrackClassification = this.classifier.update(
          trackId,
          this.timestamp,
          estimate,
          features,
        );
        return {
          trackId,
          estimate,
          quality: "confirmed",
          depth: runtime.state.depth,
          createdAt: 0,
          classification,
        };
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
    // Doppler-style fuze discrimination: near-stationary scatterers
    // (turbulence clouds, bottom features) do not actuate a tuned
    // influence fuze; hard moving targets do.
    const minSpeed = this.weapon?.fuze?.minTargetSpeedMs;
    let best: { runtime: ContactRuntime; separation: number } | null = null;
    for (const runtime of this.contactRuntimes) {
      if (!runtime.active) continue;
      if (
        minSpeed !== undefined &&
        Math.hypot(
          runtime.state.velocity.x,
          runtime.state.velocity.y,
        ) < minSpeed
      ) {
        continue;
      }
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
          if (
            this.weapon?.sensorPolicy === "passive-midcourse" &&
            !this.sensorActivated
          ) {
            // TMA legging: alternate straight legs offset from the bearing
            // so the passive bearing history becomes observable — the
            // classic own-ship maneuver that solves bearings-only tracking.
            const LEG_DURATION = 22;
            const leg = Math.floor(this.timestamp / LEG_DURATION) % 2 === 0;
            desiredHeading = bearing + (leg ? 0.9 : -0.9);
          } else {
            // Inside the standoff, fly a gentle inward spiral (heading offset
            // 45 deg off the bearing) so the seeker — a +/-50 deg half-angle
            // field — keeps the contact group in view instead of pointing the
            // nose tangent and staring away from the contacts.
            desiredHeading =
              range > STANDOFF_RANGE
                ? bearing
                : bearing + Math.PI / 4;
          }
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
        if (
          this.weapon.sensorPolicy === "passive-midcourse" &&
          !this.sensorActivated
        ) {
          this.sensorActivated = true;
          this.phaseTimeline.push({
            phase: "terminal",
            startedAt: this.timestamp,
            reason: "seeker activated (passive midcourse ended)",
          });
        }
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
    // Search slow, kill fast: cutting speed during reacquisition lowers
    // flow self-noise and widens the effective detection cone. A silent
    // passive midcourse searches at the quiet speed for the same reason —
    // and to stay below the target's counter-detection threshold.
    if (
      this.weapon.speed?.searchSpeed !== undefined &&
      ((this.homing?.phase === "reacquisition") ||
        (this.weapon.sensorPolicy === "passive-midcourse" &&
          !this.sensorActivated))
    ) {
      return this.weapon.speed.searchSpeed;
    }
    return cruise;
  }

  /**
   * Depth target for the weapon. In a multi-contact engagement the weapon
   * follows the designated track's measured depth — descending with a diving
   * contact instead of losing it across the sound layer — and while holding
   * fire shadows the same candidate the standoff orbit tracks. Depth comes
   * from depression-angle measurements only, never truth. The legacy
   * single-target path keeps the configured commanded depth exactly.
   */
  private commandedDepthForPhase(): number {
    if (!this.contactRuntimes) return this.config.torpedo.commandedDepth;
    let depth: number | null = null;
    const designatedId = this.tewa.designation?.trackId ?? null;
    if (designatedId !== null) {
      depth =
        this.lastCandidates.find((entry) => entry.trackId === designatedId)
          ?.depth ?? null;
      if (depth === null && this.tracker) {
        depth = this.tracker.depthForTrack(designatedId);
      }
    }
    if (depth === null && !this.tewa.authorized) {
      const candidate =
        this.lastCandidates.find(
          (entry) => entry.classification.best === "sub-like",
        ) ?? this.lastCandidates[0];
      depth = candidate?.depth ?? null;
    }
    if (depth !== null) this.heldDepthTarget = depth;
    const target = this.heldDepthTarget ?? this.config.torpedo.commandedDepth;
    const waterDepth = this.config.environment?.waterDepth ?? 500;
    return clamp(target, 5, waterDepth - 20);
  }

  private updateAutopilot(): void {
    const rawYawRate =
      this.guidance.lateralAcceleration / Math.max(1, this.torpedo.speed);
    const maximum = this.config.torpedo.parameters.maxTurnRate;
    this.torpedoControl = {
      yawRateCommand: clamp(rawYawRate, -maximum, maximum),
      depthRateCommand: depthRateAutopilot(
        this.commandedDepthForPhase(),
        this.torpedo,
        this.config.torpedo.parameters,
      ),
      speedCommand: this.commandedSpeedForPhase(),
    };
  }

  private sampleAndDeliverObservations(): void {
    if (this.contactRuntimes) {
      // Silent midcourse: listen instead of ping. The weapon builds a
      // bearing-only picture (and stays acoustically invisible to
      // perception) until the terminal-phase activation.
      if (
        this.weapon?.sensorPolicy === "passive-midcourse" &&
        !this.sensorActivated
      ) {
        const radiating = this.contactRuntimes
          .filter((runtime) => runtime.active)
          .map((runtime) => ({
            state: runtime.state,
            targetStrengthDb: 0,
            radiatedNoiseDb: runtime.spec.radiatedNoiseDb,
          }));
        const samples = this.seeker.samplePassive(
          this.timestamp,
          this.torpedo,
          radiating,
          this.contactStreams,
          { noise: new SeededRandom(0), passive: new SeededRandom(0) },
        );
        if (samples) {
          this.lastPingAt = this.timestamp;
          const locked = samples.find((sample) => sample.status === "locked");
          this.seekerStatus = locked ? "locked" : "searching";
          this.latestAcoustic = locked?.acoustic ?? null;
          for (const sample of samples) {
            if (sample.observation) {
              this.pendingObservations.push(sample.observation);
            }
          }
        }
        this.deliverPendingObservations();
        return;
      }
      const weaponPosition = {
        x: this.torpedo.position.x,
        y: this.torpedo.position.y,
      };
      const seekerContacts: SeekerContact[] = this.contactRuntimes
        .filter((runtime) => runtime.active)
        .map((runtime) => ({
          state: runtime.state,
          targetStrengthDb: effectiveTargetStrength(
            runtime,
            weaponPosition,
            this.config.acoustic?.targetStrengthDb ?? 0,
            this.timestamp,
          ),
          echoFluctuation: runtime.spec.echoFluctuation,
          friendlySignature: runtime.spec.friendlySignature,
          radiatedNoiseDb: runtime.spec.radiatedNoiseDb,
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
          depth: null,
        },
      );
      if (samples) {
        this.lastPingAt = this.timestamp;
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
        this.weapon.endurance?.battery !== undefined &&
          this.energyRemainingWs !== null
          ? this.energyRemainingWs /
            Math.max(
              1e-6,
              this.weapon.endurance.battery.hotelW +
                this.weapon.endurance.battery.dragKW *
                  this.torpedo.speed ** 3,
            )
          : this.weapon.endurance?.runTime !== undefined
            ? this.weapon.endurance.runTime - this.timestamp
            : null,
      armed: this.fuzeState?.armed ?? false,
      commandedSpeed: this.torpedoControl.speedCommand,
      sensorMode:
        this.weapon.sensorPolicy === "passive-midcourse" && !this.sensorActivated
          ? "passive"
          : "active",
      solutionSigmaM: (() => {
        const track = this.selectedTrack();
        if (!track) return null;
        const variance =
          Math.max(0, track.covariance[0]?.[0] ?? 0) +
          Math.max(0, track.covariance[1]?.[1] ?? 0);
        return 2 * Math.sqrt(variance);
      })(),
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
      engagement: this.buildEngagementTelemetry(),
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
            : nearest.runtime.spec.kind === "decoy" ||
                nearest.runtime.spec.kind === "knuckle"
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
    if (this.contactRuntimes && this.lastPingAt !== null) {
      this.lastPingAt = null;
      for (const index of this.perceptionIndices) {
        const runtime = this.contactRuntimes[index];
        if (!runtime.active || !runtime.spec.perception) continue;
        runtime.perceptionState = updateTargetPerception({
          state: runtime.perceptionState!,
          now: this.timestamp,
          weapon: this.torpedo,
          contact: runtime.state,
          perception: runtime.spec.perception,
          environment: this.config.environment,
          acoustic: this.config.acoustic,
          random: this.contactStreams[index].perception!,
          ...(this.weapon?.sensorPolicy === "passive-midcourse" &&
          !this.sensorActivated
            ? this.weapon.radiatedNoise
              ? {
                  overrideSourceLevelDb:
                    this.weapon.radiatedNoise.baseDb +
                    this.weapon.radiatedNoise.dbPerMs * this.torpedo.speed,
                }
              : { silent: true }
            : {}),
        });
      }
    }
    if (this.contactRuntimes) {
      for (const runtime of this.contactRuntimes) {
        if (!runtime.active) {
          const behavior = runtime.spec.behavior;
          if (behavior?.kind === "decoy" || behavior?.kind === "knuckle") {
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
              if (behavior.kind === "decoy") {
                activateDecoy(runtime, spawner);
              } else {
                activateKnuckle(runtime, spawner, this.timestamp);
              }
            }
          }
          if (!runtime.active) continue;
        }
        let control = contactControl(runtime, rangeBefore, this.timestamp);
        const perception = runtime.spec.perception;
        if (perception && runtime.perceptionState?.reacting) {
          // Evasion from the perceived threat: turn away from the heard
          // bearing, dive toward the configured depth, optionally go quiet.
          const away = wrapAngle(
            (runtime.perceptionState.heardBearing ?? runtime.state.heading) +
              Math.PI,
          );
          const error = wrapAngle(away - runtime.state.heading);
          control = {
            ...control,
            yawRateCommand: clamp(
              error,
              -perception.evasiveRate,
              perception.evasiveRate,
            ),
            ...(perception.diveDepth !== undefined
              ? {
                  depthRateCommand: depthRateAutopilot(
                    perception.diveDepth,
                    runtime.state,
                    runtime.spec.vehicle.parameters,
                  ),
                }
              : {}),
            ...(perception.quietFactor !== undefined
              ? {
                  speedCommand: Math.max(
                    0.5,
                    runtime.spec.vehicle.commandedSpeed * perception.quietFactor,
                  ),
                }
              : {}),
          };
        }
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
    const battery = this.weapon?.endurance?.battery;
    if (battery && this.energyRemainingWs !== null) {
      this.energyRemainingWs -=
        (battery.hotelW + battery.dragKW * this.torpedo.speed ** 3) * this.dt;
    }
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
    let fuzeSeparation: number | null = null;
    if (
      this.weapon?.fuze !== undefined &&
      this.fuzeState?.armed === true &&
      this.engagementAuthorized
    ) {
      const update = updateProximityFuze(
        this.fuzeState,
        proximityRange,
        this.weapon.fuze,
        this.fuzeRandom ?? undefined,
      );
      this.fuzeState = update.state;
      if (update.detonate) {
        fuzeSeparation = update.detonationSeparation ?? proximityRange;
      }
    }
    const exhausted =
      (this.weapon?.endurance?.battery !== undefined &&
        this.energyRemainingWs !== null &&
        this.energyRemainingWs <= 0) ||
      (this.weapon?.endurance?.battery === undefined &&
        this.weapon?.endurance?.runTime !== undefined &&
        this.timestamp >= this.weapon.endurance.runTime);
    // Multi-contact termination uses the nearest true contact (proximity
    // scoring, like the fuze); legacy keeps the designated single target.
    if (!isFiniteArray(stateValues)) this.finish("invalid-state", sample);
    else if (fuzeSeparation !== null) {
      this.finish("fuzed-detonation", sample, fuzeSeparation);
    }
    else if (exhausted && this.timestamp < this.config.runtime.maxTime) {
      this.finish("endurance-exhausted", sample);
    }
    else if (
      this.weapon?.fuze === undefined &&
      proximityRange <= this.config.interceptRadius
    ) {
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
