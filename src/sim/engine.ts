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
import {
  SeekerModel,
  type CountermeasureEffects,
  type SeekerContact,
} from "./sensor";
import { powerSumDb, type ScreeningVolume } from "./acoustics";
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
  // Launch platform pipeline (null keeps the weapon-centric architecture).
  private platformState: VehicleState | null = null;
  private platformDynamics: VehicleDynamics | null = null;
  private platformControl: VehicleControl = {
    yawRateCommand: 0,
    depthRateCommand: 0,
    speedCommand: 0,
  };
  private platformSeeker: SeekerModel | null = null;
  private platformTracker: MultiTargetTracker | null = null;
  private platformClassifier = new ContactClassifier();
  private platformTewa: TewaState | null = null;
  private platformStreams: {
    noise: SeededRandom;
    passive: SeededRandom;
  }[] = [];
  private platformPending: import("./types").SensorObservation[] = [];
  private wireAttached = false;
  // True when the weapon's own passive picture has a track near the
  // platform's designated solution (two independent sensors consenting).
  private wireCorroborated = false;
  // True once the platform's designation has crossed the wire at least
  // once; losing it afterwards cuts the wire.
  private wireHadDesignation = false;
  // Wingman weapon (salvo): a second fully-equipped weapon prosecuting
  // the SAME designated solution, launched after an interval with an
  // angular spread. Null until launched / when no salvo is configured.
  private wingTorpedo: VehicleState | null = null;
  private wingDynamics: VehicleDynamics | null = null;
  private wingHoming: HomingState | null = null;
  private wingFuze: FuzeState | null = null;
  private wingEnergyWs: number | null = null;
  private wingDistance = 0;
  private wingPrevious: { x: number; y: number; z: number } | null = null;
  private wingLaunched = false;
  // When the wire solution stopped being corroborated (null = currently
  // corroborated). Sustained disagreement cuts the wire.
  private corroborationLostAt: number | null = null;

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
      if (config.platform) {
        this.platformDynamics = createVehicleDynamics(
          config.platform.vehicle.dynamicsModel ?? "planar-2.5d",
          config.dynamics.sixDof,
        );
        this.platformState = this.platformDynamics.initialize(
          config.platform.vehicle,
        );
        this.platformControl = {
          yawRateCommand: 0,
          depthRateCommand: 0,
          speedCommand: config.platform.vehicle.commandedSpeed,
        };
        const platformSensor = {
          ...config.sensor,
          bearingSigma: config.sensor.bearingSigma *
            (config.platform.bearingSigmaScale ?? 1),
          cadenceHz: config.platform.cadenceHz ?? 2,
          fovHalfAngle: Math.PI, // omnidirectional towed array
          minRange: 0,
          maxRange: Math.max(config.sensor.maxRange, 6000),
        };
        this.platformSeeker = new SeekerModel(
          platformSensor,
          new SeededRandom(deriveSeed(config.seed, "platform-noise")),
          new SeededRandom(deriveSeed(config.seed, "platform-dropout")),
          config.environment,
          config.acoustic,
        );
        if (config.guidance.mode === "ekf" || config.guidance.mode === "raw") {
          // The towed array's bearings are bearingSigmaScale times the
          // seeker's, so its association gate tightens by the same factor:
          // loud contacts on converging bearings merge far less readily.
          const bearingScale = config.platform.bearingSigmaScale ?? 1;
          this.platformTracker = new MultiTargetTracker(
            {
              estimator: {
                ...config.estimator,
                innovationGate: Math.max(
                  2,
                  config.estimator.innovationGate * bearingScale,
                ),
              },
              confirmationCount: 5,
              tentativeTimeout: 2.5,
              deletionTimeout: 6,
            },
            config.guidance.mode,
          );
        }
        this.platformTewa = initialTewaState();
        this.platformStreams = config.contacts.map((spec) => ({
          noise: new SeededRandom(deriveSeed(config.seed, `platform-noise-${spec.id}`)),
          passive: new SeededRandom(deriveSeed(config.seed, `platform-passive-${spec.id}`)),
          depth: config.sensor.depthSigmaM !== undefined
            ? new SeededRandom(deriveSeed(config.seed, `platform-depth-${spec.id}`))
            : null,
        }));
        this.wireAttached = Boolean(config.weapon?.wireGuidance);
      }
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
    if (this.wireAttached && this.platformTracker && this.platformTewa) {
      const designation = this.platformTewa.designation;
      if (designation) {
        return this.platformTracker.estimateForTrack(
          this.timestamp,
          designation.trackId,
        );
      }
      return null;
    }
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
    if (this.platformTewa?.authorized && this.wireCorroborated) return true;
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
  private nearestActiveContact(
    origin?: { x: number; y: number; z: number },
  ): { runtime: ContactRuntime; separation: number } | null {
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
      const at = origin ?? this.torpedo.position;
      const separation = Math.hypot(
        runtime.state.position.x - at.x,
        runtime.state.position.y - at.y,
        runtime.state.position.z - at.z,
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
        // A passive midcourse's phase clock runs regardless of doctrine —
        // its run-out completes while authorization is pending. Active
        // policies keep the validated frozen-during-hold-fire behavior
        // (the launch-solution track is stale pre-authorization).
        if (this.weapon?.sensorPolicy === "passive-midcourse") {
          this.updateWeaponPhase(this.selectedTrack());
        }
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

  /** Launch-transient level heard at perceiving contacts during the
   *  ejection window (dB); null outside it. Shooting is loud. */
  private launchTransientLevelDb(): number | null {
    const platform = this.config.platform;
    if (!platform?.radiatedNoiseDb) return null;
    const duration = platform.transientS ?? 6;
    if (this.timestamp > duration) return null;
    return platform.radiatedNoiseDb + (platform.transientDb ?? 20);
  }

  /**
   * Launch-platform tick: own-ship TMA legs, passive towed-array pings,
   * its own MHT tracker / classifier / TEWA. The platform is truth-side
   * hardware feeding itself — its picture crosses to the weapon only
   * through the wire (selectedTrack override while attached).
   */
  private updatePlatform(): void {
    const platform = this.config.platform;
    if (!platform || !this.platformState || !this.platformDynamics) return;
    // Crisp own-ship TMA legs: hold base heading +/- a solid offset,
    // alternating each leg period, so the bearing history diversifies
    // quickly (constant-rate ramps diversify far too slowly).
    const legPeriod = platform.legPeriodS ?? 30;
    const leg = Math.floor(this.timestamp / legPeriod) % 2 === 0 ? 1 : -1;
    const desired = platform.vehicle.initial.heading + leg * 0.7;
    const error = wrapAngle(desired - this.platformState.heading);
    const maxRate = platform.vehicle.parameters.maxTurnRate;
    this.platformControl = {
      ...this.platformControl,
      yawRateCommand: clamp(0.12 * error, -maxRate, maxRate),
      speedCommand: platform.vehicle.commandedSpeed,
    };
    this.platformState = this.platformDynamics.integrate(
      this.platformState,
      this.platformControl,
      platform.vehicle,
      this.dt,
    );
    if (!this.contactRuntimes || !this.platformSeeker) return;

    // Passive ping on the platform cadence.
    const radiating = this.contactRuntimes
      .filter((runtime) => runtime.active)
      .map((runtime) => ({
        state: runtime.state,
        targetStrengthDb: 0,
        radiatedNoiseDb: runtime.spec.radiatedNoiseDb,
      }));
    const samples = this.platformSeeker.samplePassive(
      this.timestamp,
      this.platformState,
      radiating,
      this.platformStreams,
      { noise: new SeededRandom(0), passive: new SeededRandom(0) },
    );
    if (samples) {
      for (const sample of samples) {
        if (sample.observation) this.platformPending.push(sample.observation);
      }
    }
    while (
      this.platformPending.length > 0 &&
      this.platformPending[0].deliveredAt <= this.timestamp + 1e-10
    ) {
      const observation = this.platformPending.shift()!;
      this.platformTracker?.process(this.timestamp, observation);
    }
    if (!this.platformTracker) return;
    this.platformTracker.prune(this.timestamp);
    const candidates: TewaCandidate[] = this.platformTracker
      .liveTracks(this.timestamp)
      .map((track) => ({
        trackId: track.meta.id,
        estimate: track.estimate,
        quality: track.meta.quality,
        depth: track.meta.depth,
        createdAt: track.meta.createdAt,
        classification: this.platformClassifier.update(
          track.meta.id,
          this.timestamp,
          track.estimate,
          track.meta.features,
        ),
      }));
    if (this.platformTewa) {
      // Corroboration gate: the platform's designated solution must sit
      // near a track in the weapon's own independent picture — a
      // converged-wrong phantom fails this and the weapon keeps
      // searching (or self-authorizes on its own proven doctrine).
      // Corroboration is CONTINUOUS: after release, sustained
      // disagreement between the two pictures cuts the wire and hands
      // the weapon to its own doctrine instead of enslaving it to a
      // drifting relayed solution.
      const designation = this.platformTewa.designation;
      this.wireCorroborated = false;
      if (designation && this.platformTracker && this.tracker) {
        const platformEstimate = this.platformTracker.estimateForTrack(
          this.timestamp,
          designation.trackId,
        );
        if (platformEstimate) {
          for (const track of this.tracker.liveTracks(this.timestamp)) {
            const separation = Math.hypot(
              track.estimate.position.x - platformEstimate.position.x,
              track.estimate.position.y - platformEstimate.position.y,
            );
            if (separation <= 600) {
              this.wireCorroborated = true;
              break;
            }
          }
        }
      }
      if (this.wireCorroborated) {
        this.corroborationLostAt = null;
      } else if (this.corroborationLostAt === null) {
        this.corroborationLostAt = this.timestamp;
      } else if (
        this.wireAttached &&
        this.wireHadDesignation &&
        this.timestamp - this.corroborationLostAt >= 15
      ) {
        this.cutWire("corroboration lost");
      }
      this.platformTewa = updateTewa({
        state: this.platformTewa,
        now: this.timestamp,
        candidates,
        ownPosition: {
          x: this.platformState.position.x,
          y: this.platformState.position.y,
        },
        doctrine: this.config.doctrine ?? defaultDoctrine(),
      });
    }
  }

  private cutWire(reason: string): void {
    this.wireAttached = false;
    this.phaseTimeline.push({
      phase: this.homing?.phase ?? "homing",
      startedAt: this.timestamp,
      reason: `wire cut (${reason})`,
    });
  }

  /** Ends a passive midcourse: the seeker goes active from here on A
   *  weapon that has not been authorized stays silent — going active early
   *  alerts the target and abandons the approach's whole purpose. */
  private activateSeeker(reason: string): void {
    if (this.sensorActivated || !this.engagementAuthorized) return;
    this.sensorActivated = true;
    this.phaseTimeline.push({
      phase: this.homing?.phase ?? "homing",
      startedAt: this.timestamp,
      reason: `seeker activated (${reason})`,
    });
  }

  private updateWeaponPhase(track: TrackEstimate | null): void {
    if (!this.weapon || !this.homing) return;
    // Enable-on-distance fallback: a passive midcourse also activates
    // after a configured along-track run, even if the (possibly wrong)
    // solution never estimates terminal range.
    if (
      this.weapon.sensorPolicy === "passive-midcourse" &&
      !this.sensorActivated &&
      this.weapon.phases?.enableDistance !== undefined &&
      this.distanceTravelled >= this.weapon.phases.enableDistance
    ) {
      this.activateSeeker("enable distance");
    }
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
          this.activateSeeker("terminal range");
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
    const command = computeGuidance(
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
    if (
      this.weapon?.sensorPolicy === "passive-midcourse" &&
      !this.sensorActivated
    ) {
      // Snake while closing passively: a slow cross-course sinusoid keeps
      // the bearing history diversifying, so the solution keeps converging
      // instead of collapsing onto an unobservable constant bearing.
      const snake = 0.35 * Math.sin((2 * Math.PI * this.timestamp) / 30);
      const desired = command.desiredHeading + snake;
      const headingError = wrapAngle(desired - this.torpedo.heading);
      return {
        ...command,
        desiredHeading: desired,
        lateralAcceleration: Math.min(
          this.config.guidance.maxLateralAcceleration,
          headingError * Math.max(1, this.torpedo.speed) * 0.6,
        ),
      };
    }
    return command;
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

  /** Truth-side countermeasure effects for the current ping: in-band
   *  jamming noise at the weapon receiver and active screening volumes
   *  (fading with age). */
  private countermeasureEffects(): CountermeasureEffects | undefined {
    if (!this.contactRuntimes) return undefined;
    let jamming: number | null = null;
    const screens: ScreeningVolume[] = [];
    let any = false;
    for (const runtime of this.contactRuntimes) {
      if (!runtime.active || runtime.deployedAt === null) continue;
      const behavior = runtime.spec.behavior;
      const age = this.timestamp - runtime.deployedAt;
      if (behavior?.kind === "jammer") {
        const range = Math.max(
          1,
          Math.hypot(
            runtime.state.position.x - this.torpedo.position.x,
            runtime.state.position.y - this.torpedo.position.y,
          ),
        );
        // In-band noise on the direct path, against the base ambient
        // (self-noise is applied inside the seeker).
        const spreading = this.config.environment?.spreadingCoefficient ?? 17;
        const absorption = this.config.acoustic
          ? thorpAbsorptionDbPerKm(this.config.acoustic.frequencyKhz) * range / 1000
          : 0;
        const received =
          behavior.noiseDb - spreading * Math.log10(range) - absorption;
        jamming = jamming === null ? received : powerSumDb(jamming, received);
        any = true;
      } else if (behavior?.kind === "bubble-screen") {
        const loss = Math.max(
          0,
          behavior.lossDb - behavior.fadeDbPerS * age,
        );
        if (loss > 0.5) {
          screens.push({
            x: runtime.state.position.x,
            y: runtime.state.position.y,
            radiusM: behavior.effectRadiusM,
            lossDb: loss,
          });
          any = true;
        }
      }
    }
    return any ? { jammingNoiseDb: jamming, screens } : undefined;
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
        // The weapon's small array does not resolve depression angle —
        // depth-bearing passive observations are the towed array's
        // capability (the platform), not the seeker's.
        const weaponPassiveStreams = this.contactStreams.map((stream) => ({
          ...stream,
          depth: null as SeededRandom | null,
        }));
        const samples = this.seeker.samplePassive(
          this.timestamp,
          this.torpedo,
          radiating,
          weaponPassiveStreams,
          { noise: new SeededRandom(0), passive: new SeededRandom(0), depth: null },
          this.countermeasureEffects(),
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
        this.countermeasureEffects(),
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
      slot: this.weapon.salvo ? "lead" : undefined,
      sensorMode:
        this.weapon.sensorPolicy === "passive-midcourse" && !this.sensorActivated
          ? "passive"
          : "active",
      wireAttached: this.wireAttached || undefined,
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
      wingman: this.buildWingmanTelemetry(),
      acoustic: this.latestAcoustic,
    };
  }

  /** Wingman weapon telemetry; null until launched or when no salvo. */
  private buildWingmanTelemetry():
    | { torpedo: VehicleState; weapon: WeaponTelemetry }
    | undefined {
    if (!this.wingTorpedo || !this.wingHoming) return undefined;
    const weapon = this.weapon!;
    const battery = weapon.endurance?.battery;
    const speed = this.wingTorpedo.speed;
    return {
      torpedo: this.wingTorpedo,
      weapon: {
        phase: this.wingHoming.phase,
        phaseEnteredAt: this.wingHoming.enteredPhaseAt,
        trackLostFor: null,
        enduranceRemaining:
          battery && this.wingEnergyWs !== null
            ? this.wingEnergyWs /
              Math.max(1e-6, battery.hotelW + battery.dragKW * speed ** 3)
            : null,
        armed: this.wingFuze?.armed ?? false,
        commandedSpeed:
          this.wingHoming.phase === "terminal" &&
          weapon.speed?.sprintSpeed !== undefined
            ? weapon.speed.sprintSpeed
            : (weapon.speed?.cruiseSpeed ?? this.config.torpedo.commandedSpeed),
        slot: "wing",
        sensorMode: "active",
        enablePoint: null,
        interceptPoint: null,
      },
    };
  }

  private buildSnapshot(sample: TelemetrySample): RenderSnapshot {
    return {
      sequence: this.sequence++,
      timestamp: this.timestamp,
      torpedo: this.torpedo,
      target: this.target,
      platform: this.platformState ?? undefined,
      wingman: sample.wingman,
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
    detonationOrigin?: { x: number; y: number; z: number },
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
      const nearest = this.nearestActiveContact(detonationOrigin);
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

  /** Launches the wingman at its interval, offset by the spread. */
  private maybeLaunchWingman(): void {
    const salvo = this.weapon?.salvo;
    if (!salvo || this.wingLaunched || this.timestamp < salvo.intervalS) return;
    this.wingLaunched = true;
    this.wingDynamics = createVehicleDynamics(
      this.config.torpedo.dynamicsModel ?? this.config.dynamics.model,
      this.config.dynamics.sixDof,
    );
    const spread = (salvo.spreadDeg * Math.PI) / 180;
    const initial = {
      ...this.config.torpedo.initial,
      heading: this.config.torpedo.initial.heading - spread,
    };
    this.wingTorpedo = this.wingDynamics.initialize({
      ...this.config.torpedo,
      initial,
    });
    this.wingHoming = initialHomingState();
    this.wingFuze = initialFuzeState();
    this.wingEnergyWs =
      this.weapon?.endurance?.battery?.capacityWs ?? null;
    this.phaseTimeline.push({
      phase: "run-out",
      startedAt: this.timestamp,
      reason: "wingman launched",
    });
  }

  /**
   * Wingman tick: pure proportional navigation on the SHARED designated
   * solution (one fire-control authority, two weapons), the same phase
   * machine, closest-point fuze, and energy budget. Returns the true
   * separation at a wingman fuze detonation, else null. The wingman
   * always runs an active seeker and shares the lead's depth-target
   * latch — it attacks the same contact.
   */
  private updateWingman(): number | null {
    if (!this.wingTorpedo || !this.wingDynamics || !this.wingHoming) {
      return null;
    }
    const salvo = this.weapon!.salvo!;
    const track = this.selectedTrack();
    const weapon = this.weapon!;
    const estimatedRange = track
      ? magnitude2(
          subtract2(track.position, {
            x: this.wingTorpedo.position.x,
            y: this.wingTorpedo.position.y,
          }),
        )
      : null;
    const phaseUpdate = updateHomingPhase({
      state: this.wingHoming,
      timestamp: this.timestamp,
      track,
      estimatedRange,
      distanceTravelled: this.wingDistance,
      weapon,
      stalenessBound: this.trackStalenessBound(),
    });
    this.wingHoming = phaseUpdate.state;
    const phase = this.wingHoming.phase;

    // Guidance: hold launch heading through run-out, loiter in
    // reacquisition, otherwise proportional navigation on the shared
    // solution.
    let command: GuidanceCommand;
    if (phase === "run-out") {
      command = idleGuidance(
        this.timestamp,
        this.config.guidance.law,
        this.config.torpedo.initial.heading - (salvo.spreadDeg * Math.PI) / 180,
      );
    } else if (phase === "reacquisition" || !track) {
      const turnRate =
        weapon.phases?.searchTurnRate ??
        this.config.torpedo.parameters.maxTurnRate;
      command = {
        timestamp: this.timestamp,
        law: this.config.guidance.law,
        lateralAcceleration: turnRate * Math.max(1, this.wingTorpedo.speed),
        desiredHeading: this.wingTorpedo.heading,
        losRate: 0,
        closingVelocity: 0,
        trackAge: track?.age ?? Number.MAX_SAFE_INTEGER,
        saturated: false,
      };
    } else {
      // Spread doctrine: the wingman aims along the solution's error
      // ellipse, offset laterally by a fraction of the 2-sigma position
      // uncertainty — a heading spread alone washes out by midcourse.
      const sigma = Math.sqrt(
        Math.max(
          0,
          (track.covariance[0]?.[0] ?? 0) + (track.covariance[1]?.[1] ?? 0),
        ),
      );
      const dx = track.position.x - this.wingTorpedo.position.x;
      const dy = track.position.y - this.wingTorpedo.position.y;
      const lineOfSight = Math.max(1, Math.hypot(dx, dy));
      const offset = 0.7 * sigma;
      const spreadTrack: TrackEstimate = {
        ...track,
        position: {
          x: track.position.x + (-dy / lineOfSight) * offset,
          y: track.position.y + (dx / lineOfSight) * offset,
        },
      };
      command = computeGuidance(
        {
          timestamp: this.timestamp,
          ownPosition: {
            x: this.wingTorpedo.position.x,
            y: this.wingTorpedo.position.y,
          },
          ownVelocity: {
            x: this.wingTorpedo.velocity.x,
            y: this.wingTorpedo.velocity.y,
          },
          ownHeading: this.wingTorpedo.heading,
          track: spreadTrack,
        },
        this.config.guidance,
      );
    }

    const cruise = weapon.speed?.cruiseSpeed ?? this.config.torpedo.commandedSpeed;
    const speed =
      phase === "terminal" && weapon.speed?.sprintSpeed !== undefined
        ? weapon.speed.sprintSpeed
        : cruise;
    const rawYawRate = command.lateralAcceleration / Math.max(1, this.wingTorpedo.speed);
    const maximum = this.config.torpedo.parameters.maxTurnRate;
    const depthTarget = clamp(
      this.heldDepthTarget ?? this.config.torpedo.commandedDepth,
      5,
      (this.config.environment?.waterDepth ?? 500) - 20,
    );
    const previous = this.wingTorpedo.position;
    this.wingTorpedo = this.wingDynamics.integrate(
      this.wingTorpedo,
      {
        yawRateCommand: clamp(rawYawRate, -maximum, maximum),
        depthRateCommand: depthRateAutopilot(
          depthTarget,
          this.wingTorpedo,
          this.config.torpedo.parameters,
        ),
        speedCommand: speed,
      },
      this.config.torpedo,
      this.dt,
    );
    this.wingDistance += Math.hypot(
      this.wingTorpedo.position.x - previous.x,
      this.wingTorpedo.position.y - previous.y,
    );
    if (this.wingEnergyWs !== null) {
      const battery = weapon.endurance?.battery;
      if (battery) {
        this.wingEnergyWs -=
          (battery.hotelW + battery.dragKW * this.wingTorpedo.speed ** 3) * this.dt;
      }
    }
    this.wingFuze = updateFuzeArming(
      this.wingFuze ?? initialFuzeState(),
      this.timestamp,
      this.fuzeArmAt ?? 0,
    );
    // Fuze against the nearest true contact to the WINGMAN.
    let nearest: { separation: number; velocity: number } | null = null;
    for (const runtime of this.contactRuntimes ?? []) {
      if (!runtime.active) continue;
      const separation = Math.hypot(
        runtime.state.position.x - this.wingTorpedo.position.x,
        runtime.state.position.y - this.wingTorpedo.position.y,
        runtime.state.position.z - this.wingTorpedo.position.z,
      );
      const contactSpeed = Math.hypot(
        runtime.state.velocity.x,
        runtime.state.velocity.y,
      );
      if (
        weapon.fuze?.minTargetSpeedMs !== undefined &&
        contactSpeed < weapon.fuze.minTargetSpeedMs
      ) {
        continue;
      }
      if (!nearest || separation < nearest.separation) {
        nearest = { separation, velocity: contactSpeed };
      }
    }
    const target = this.target;
    const wingRange = nearest?.separation ??
      Math.hypot(
        target.position.x - this.wingTorpedo.position.x,
        target.position.y - this.wingTorpedo.position.y,
        target.position.z - this.wingTorpedo.position.z,
      );
    if (this.wingFuze?.armed === true && this.engagementAuthorized) {
      const update = updateProximityFuze(
        this.wingFuze,
        wingRange,
        weapon.fuze ?? {},
        this.fuzeRandom ?? undefined,
      );
      this.wingFuze = update.state;
      if (update.detonate) {
        return update.detonationSeparation ?? wingRange;
      }
    }
    return null;
  }

  step(forceSnapshot = false): EngineStep {
    if (this.result) return { result: this.result };

    if (this.tick % this.guidanceEvery === 0) this.updateGuidance();
    if (this.tick % this.autopilotEvery === 0) this.updateAutopilot();

    const rangeBefore = horizontalRange(this.torpedo, this.target);
    const previousTorpedoPosition = this.torpedo.position;
    this.updatePlatform();
    if (this.wireAttached && this.platformTewa?.designation) {
      this.wireHadDesignation = true;
    }
    if (this.wireAttached && this.sensorActivated) {
      // Wire cut: the weapon's seeker went active; from here its own
      // picture is sovereign.
      this.cutWire("seeker activation");
    } else if (
      this.wireAttached &&
      this.wireHadDesignation &&
      !this.platformTewa?.designation
    ) {
      // The platform lost its solution mid-course. Without this cut the
      // weapon would deadlock: activation waits on the relayed
      // designation, which is gone. Release it to its own doctrine.
      this.cutWire("platform solution lost");
    }
    this.maybeLaunchWingman();
    const wingDetonation = this.updateWingman();
    if (this.wingEnergyWs !== null && this.wingEnergyWs <= 0 && this.wingTorpedo) {
      this.wingTorpedo = null;
      this.phaseTimeline.push({
        phase: this.wingHoming?.phase ?? "homing",
        startedAt: this.timestamp,
        reason: "wingman expended",
      });
    }
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
          ...(this.launchTransientLevelDb() !== null
            ? { overrideSourceLevelDb: this.launchTransientLevelDb()! }
            : this.weapon?.sensorPolicy === "passive-midcourse" &&
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
          if (
            behavior?.kind === "decoy" ||
            behavior?.kind === "knuckle" ||
            behavior?.kind === "jammer" ||
            behavior?.kind === "bubble-screen"
          ) {
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
              this.phaseTimeline.push({
                phase: this.homing?.phase ?? "run-out",
                startedAt: this.timestamp,
                reason: `countermeasure deployed: ${behavior.kind}`,
              });
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
    else if (wingDetonation !== null) {
      this.finish(
        "fuzed-detonation",
        sample,
        wingDetonation,
        this.wingTorpedo?.position ?? undefined,
      );
    } else if (fuzeSeparation !== null) {
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
