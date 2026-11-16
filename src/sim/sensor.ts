import { magnitude2, subtract2, wrapAngle } from "./math";
import { SeededRandom } from "./random";
import {
  acousticChannel,
  pathScreeningLossDb,
  powerSumDb,
  type ScreeningVolume,
} from "./acoustics";
import type {
  AcousticChannelState,
  AcousticConfig,
  EnvironmentConfig,
  SeekerStatus,
  SensorConfig,
  SensorObservation,
  VehicleState,
} from "./types";

export interface SensorSample {
  status: SeekerStatus;
  observation: SensorObservation | null;
  acoustic: AcousticChannelState | null;
}

/** Truth-side countermeasure effects for one ping: in-band jamming noise
 *  at the receiver (dB, already path-attenuated) and screening volumes
 *  crossed by propagation paths. Computed by the engine from truth. */
export interface CountermeasureEffects {
  jammingNoiseDb: number | null;
  screens: ScreeningVolume[];
}

/** Truth-side inputs for one contact during a multi-return ping. The
 *  observation stays anonymous: no identity field crosses this boundary. */
export interface SeekerContact {
  state: VehicleState;
  targetStrengthDb: number;
  echoFluctuation?: { amplitudeDb: number; period: number };
  friendlySignature?: number;
  /** Synthetic broadband radiated-noise level (dB); passive-silent when
   *  absent. */
  radiatedNoiseDb?: number;
}

export class SeekerModel {
  private nextSampleTime = 0;
  private observationId = 0;
  private cadenceHz: number;
  private fovHalfAngle: number;

  constructor(
    private readonly config: SensorConfig,
    private readonly noise: SeededRandom,
    private readonly dropout: SeededRandom,
    private readonly environment?: EnvironmentConfig,
    private readonly acoustic?: AcousticConfig,
    private readonly channelRandom?: SeededRandom,
  ) {
    this.cadenceHz = config.cadenceHz;
    this.fovHalfAngle = config.fovHalfAngle;
  }

  /** Terminal-phase field-of-view override (rad). */
  setFov(halfAngle: number): void {
    this.fovHalfAngle = halfAngle;
  }

  /**
   * Switches the sampling cadence (e.g. a terminal-phase preset). Scheduling
   * stays tick-driven: the next sample time only moves closer to
   * atTimestamp + one period, so observedAt/deliveredAt ordering remains
   * strictly monotonic across a switch.
   */
  setCadence(cadenceHz: number, atTimestamp: number): void {
    if (cadenceHz === this.cadenceHz) return;
    this.cadenceHz = cadenceHz;
    this.nextSampleTime = Math.min(
      this.nextSampleTime,
      atTimestamp + 1 / cadenceHz,
    );
  }

  sample(
    timestamp: number,
    sensor: VehicleState,
    target: VehicleState,
  ): SensorSample | null {
    if (timestamp + 1e-10 < this.nextSampleTime) return null;
    this.nextSampleTime += 1 / this.cadenceHz;
    return this.sampleContact(
      timestamp,
      sensor,
      target,
      this.noise,
      this.acoustic?.targetStrengthDb ?? 0,
      undefined,
      undefined,
      this.dropout,
      this.channelRandom,
    );
  }

  /**
   * Multi-return ping: evaluates every contact independently with dedicated
   * per-contact random streams, so adding a contact never perturbs another
   * contact's draws. Returns one (possibly null-observation) sample per
   * contact, in the caller's order.
   */
  sampleContacts(
    timestamp: number,
    sensor: VehicleState,
    contacts: readonly SeekerContact[],
    streams: {
      noise: SeededRandom;
      dropout: SeededRandom;
      channel: SeededRandom;
      depth?: SeededRandom | null;
    }[],
    fallbackStreams: {
      noise: SeededRandom;
      dropout: SeededRandom;
      channel: SeededRandom;
      depth?: SeededRandom | null;
    },
    countermeasures?: CountermeasureEffects,
  ): SensorSample[] | null {
    if (timestamp + 1e-10 < this.nextSampleTime) return null;
    this.nextSampleTime += 1 / this.cadenceHz;
    return contacts.map((contact, index) => {
      const stream = streams[index] ?? fallbackStreams;
      return this.sampleContact(
        timestamp,
        sensor,
        contact.state,
        stream.noise,
        contact.targetStrengthDb,
        contact.echoFluctuation,
        contact.friendlySignature ?? 0.1,
        stream.dropout,
        stream.channel,
        stream.depth,
        contact.radiatedNoiseDb,
        countermeasures,
      );
    });
  }

  /**
   * Silent listening pass: omnidirectional bearing-only detections of
   * radiating contacts on the same cadence clock as the active pings. A
   * passive hearing carries a nominal-range prior with a huge variance —
   * range stays unobservable until own-ship geometry diversifies. The
   * active draw sequence is never touched.
   */
  samplePassive(
    timestamp: number,
    sensor: VehicleState,
    contacts: readonly SeekerContact[],
    streams: {
      noise: SeededRandom;
      passive: SeededRandom;
      depth?: SeededRandom | null;
    }[],
    fallbackStreams: {
      noise: SeededRandom;
      passive: SeededRandom;
      depth?: SeededRandom | null;
    },
    countermeasures?: CountermeasureEffects,
  ): SensorSample[] | null {
    if (timestamp + 1e-10 < this.nextSampleTime) return null;
    this.nextSampleTime += 1 / this.cadenceHz;
    let ambientDb = this.acoustic?.ambientNoiseDb ?? 0;
    const selfNoise = this.config.selfNoise;
    if (this.acoustic && selfNoise) {
      const selfDb = selfNoise.baseDb + selfNoise.dbPerMs * sensor.speed;
      ambientDb =
        10 * Math.log10(10 ** (this.acoustic.ambientNoiseDb / 10) + 10 ** (selfDb / 10));
    }
    if (countermeasures?.jammingNoiseDb != null) {
      ambientDb = powerSumDb(ambientDb, countermeasures.jammingNoiseDb);
    }
    return contacts.map((contact, index) => {
      const stream = streams[index] ?? fallbackStreams;
      if (contact.radiatedNoiseDb === undefined) {
        return { status: "searching", observation: null, acoustic: null };
      }
      const dx = contact.state.position.x - sensor.position.x;
      const dy = contact.state.position.y - sensor.position.y;
      const range = Math.max(1, Math.hypot(dx, dy));
      if (range > this.config.maxRange) {
        return { status: "out-of-range", observation: null, acoustic: null };
      }
      const bearingOnlyChannel =
        this.environment && this.acoustic?.enabled
          ? acousticChannel(
              timestamp,
              range,
              sensor.depth,
              contact.state.depth,
              this.environment,
              { ...this.acoustic!, ambientNoiseDb: ambientDb },
            )
          : null;
      if (!bearingOnlyChannel || !this.acoustic) {
        return { status: "searching", observation: null, acoustic: null };
      }
      const snrDb =
        contact.radiatedNoiseDb -
        bearingOnlyChannel.oneWayTransmissionLossDb -
        pathScreeningLossDb(
          sensor.position.x,
          sensor.position.y,
          contact.state.position.x,
          contact.state.position.y,
          countermeasures?.screens ?? [],
        ) -
        ambientDb;
      const scale = Math.max(0.01, this.acoustic.detectionTransitionDb);
      const detectionProbability = 1 / (
        1 + Math.exp(-(snrDb - this.acoustic.detectionThresholdDb) / scale)
      );
      if (stream.passive.next() > detectionProbability) {
        return { status: "searching", observation: null, acoustic: bearingOnlyChannel };
      }
      const trueBearing = wrapAngle(Math.atan2(dy, dx) - sensor.heading);
      // Passive bearing resolution is slightly worse than the active
      // tracker's; the nominal range prior is deliberately loose.
      const nominalRange = Math.min(this.config.maxRange, 2200);
      const observation: SensorObservation = {
        id: this.observationId++,
        observedAt: timestamp,
        deliveredAt:
          timestamp +
          this.config.latency +
          bearingOnlyChannel.propagationDelay / 2,
        bearing: wrapAngle(
          trueBearing + stream.noise.gaussian(0, this.config.bearingSigma * 1.2),
        ),
        range: nominalRange,
        bearingVariance: (this.config.bearingSigma * 1.2) ** 2,
        rangeVariance: 1400 ** 2,
        bearingOnly: true,
        sensorPosition: { x: sensor.position.x, y: sensor.position.y },
        sensorHeading: sensor.heading,
        acoustic: undefined,
        passiveSnrDb: snrDb,
      };
      if (
        stream.depth &&
        this.config.depthSigmaM !== undefined
      ) {
        observation.targetDepth = Math.max(
          0,
          contact.state.depth + stream.depth.gaussian(0, this.config.depthSigmaM),
        );
      }
      return { status: "locked", observation, acoustic: bearingOnlyChannel };
    });
  }

  private sampleContact(
    timestamp: number,
    sensor: VehicleState,
    target: VehicleState,
    noise: SeededRandom,
    targetStrengthDb: number,
    echoFluctuation: { amplitudeDb: number; period: number } | undefined,
    friendlySignature: number | undefined,
    dropout: SeededRandom,
    channelRandom: SeededRandom | undefined,
    depthRandom: SeededRandom | null = null,
    radiatedNoiseDb?: number,
    countermeasures?: CountermeasureEffects,
  ): SensorSample {
    const relative = subtract2(target.position, sensor.position);
    const range = magnitude2(relative);
    // Speed-dependent self-noise: own flow noise adds (power-summed) to the
    // ambient level, degrading detection as the weapon speeds up. Absent
    // config keeps the legacy ambient term exactly.
    let ambientDb = this.acoustic?.ambientNoiseDb ?? 0;
    const selfNoise = this.config.selfNoise;
    if (this.acoustic && selfNoise) {
      const selfDb = selfNoise.baseDb + selfNoise.dbPerMs * sensor.speed;
      ambientDb =
        10 *
        Math.log10(
          10 ** (this.acoustic.ambientNoiseDb / 10) + 10 ** (selfDb / 10),
        );
    }
    if (countermeasures?.jammingNoiseDb != null) {
      ambientDb = powerSumDb(ambientDb, countermeasures.jammingNoiseDb);
    }
    const screeningLossDb = pathScreeningLossDb(
      sensor.position.x,
      sensor.position.y,
      target.position.x,
      target.position.y,
      countermeasures?.screens ?? [],
    );
    let channel = this.environment && this.acoustic?.enabled
      ? acousticChannel(
          timestamp,
          range,
          sensor.depth,
          target.depth,
          this.environment,
          {
            ...this.acoustic!,
            ambientNoiseDb: ambientDb,
            targetStrengthDb:
              targetStrengthDb +
              (echoFluctuation
                ? echoFluctuation.amplitudeDb *
                  Math.sin((2 * Math.PI * timestamp) / echoFluctuation.period)
                : 0),
          },
        )
      : null;
    if (channel && screeningLossDb > 0) {
      // A bubble screen crossing the weapon-contact path attenuates the
      // two-way echo; detection rides the screened probability.
      const signalToNoiseDb = channel.signalToNoiseDb - 2 * screeningLossDb;
      const scale = Math.max(0.01, this.acoustic?.detectionTransitionDb ?? 3);
      channel = {
        ...channel,
        oneWayTransmissionLossDb: channel.oneWayTransmissionLossDb + screeningLossDb,
        receivedEchoLevelDb: channel.receivedEchoLevelDb - 2 * screeningLossDb,
        signalToNoiseDb,
        detectionProbability:
          1 / (1 + Math.exp(-(
            (signalToNoiseDb - (this.acoustic?.detectionThresholdDb ?? 0)) / scale
          ))),
      };
    }
    if (range < this.config.minRange || range > this.config.maxRange) {
      return { status: "out-of-range", observation: null, acoustic: channel };
    }
    const trueBearing = wrapAngle(
      Math.atan2(relative.y, relative.x) - sensor.heading,
    );
    if (Math.abs(trueBearing) > this.fovHalfAngle) {
      return { status: "out-of-fov", observation: null, acoustic: channel };
    }
    if (channel && channelRandom && channelRandom.next() > channel.detectionProbability) {
      return { status: "acoustic-loss", observation: null, acoustic: channel };
    }
    if (dropout.next() < this.config.dropoutProbability) {
      return { status: "dropout", observation: null, acoustic: channel };
    }

    const rangeSigma =
      this.config.rangeSigmaBase + this.config.rangeSigmaPerMeter * range;
    const observation: SensorObservation = {
      id: this.observationId++,
      observedAt: timestamp,
      deliveredAt: timestamp + this.config.latency + (channel?.propagationDelay ?? 0),
      bearing: wrapAngle(
        trueBearing + noise.gaussian(0, this.config.bearingSigma),
      ),
      range: Math.max(1, range + noise.gaussian(0, rangeSigma)),
      bearingVariance: this.config.bearingSigma ** 2,
      rangeVariance: rangeSigma ** 2,
      sensorPosition: { x: sensor.position.x, y: sensor.position.y },
      sensorHeading: sensor.heading,
      acoustic: channel ?? undefined,
    };
    if (channel && this.acoustic) {
      // Echo-derived feature: recover the implied target strength by
      // removing the (known) transmit level and spreading loss.
      observation.impliedTargetStrengthDb =
        channel.receivedEchoLevelDb -
        this.acoustic.sourceLevelDb +
        2 * channel.oneWayTransmissionLossDb;
    }
    if (friendlySignature !== undefined) {
      // Synthetic friendly-marking correlation with receiver noise — a
      // fictional IFF analog reported as a measurement feature.
      observation.signatureCorrelation = Math.min(
        1,
        Math.max(0, friendlySignature + noise.gaussian(0, 0.04)),
      );
    }
    if (depthRandom && this.config.depthSigmaM !== undefined) {
      // Depression-angle-derived depth from a dedicated stream so the
      // legacy single-return draw sequence stays bit-identical.
      observation.targetDepth = Math.max(
        0,
        target.depth + depthRandom.gaussian(0, this.config.depthSigmaM),
      );
    }
    if (radiatedNoiseDb !== undefined && channel) {
      // Passive rider: broadband radiated noise on the same one-way path,
      // heard against the (self-noise-degraded) ambient. Sprinting blinds
      // the passive band exactly as it degrades the active one.
      observation.passiveSnrDb =
        radiatedNoiseDb - channel.oneWayTransmissionLossDb - screeningLossDb - ambientDb;
    }

    return { status: "locked", observation, acoustic: channel };
  }
}
