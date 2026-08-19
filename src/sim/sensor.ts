import { magnitude2, subtract2, wrapAngle } from "./math";
import { SeededRandom } from "./random";
import { acousticChannel } from "./acoustics";
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

/** Truth-side inputs for one contact during a multi-return ping. The
 *  observation stays anonymous: no identity field crosses this boundary. */
export interface SeekerContact {
  state: VehicleState;
  targetStrengthDb: number;
  echoFluctuation?: { amplitudeDb: number; period: number };
  friendlySignature?: number;
}

export class SeekerModel {
  private nextSampleTime = 0;
  private observationId = 0;
  private cadenceHz: number;

  constructor(
    private readonly config: SensorConfig,
    private readonly noise: SeededRandom,
    private readonly dropout: SeededRandom,
    private readonly environment?: EnvironmentConfig,
    private readonly acoustic?: AcousticConfig,
    private readonly channelRandom?: SeededRandom,
  ) {
    this.cadenceHz = config.cadenceHz;
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
    }[],
    fallbackStreams: {
      noise: SeededRandom;
      dropout: SeededRandom;
      channel: SeededRandom;
    },
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
      );
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
  ): SensorSample {
    const relative = subtract2(target.position, sensor.position);
    const range = magnitude2(relative);
    const channel = this.environment && this.acoustic?.enabled
      ? acousticChannel(
          timestamp,
          range,
          sensor.depth,
          target.depth,
          this.environment,
          echoFluctuation
            ? {
                ...this.acoustic!,
                targetStrengthDb:
                  targetStrengthDb +
                  echoFluctuation.amplitudeDb *
                    Math.sin((2 * Math.PI * timestamp) / echoFluctuation.period),
              }
            : { ...this.acoustic!, targetStrengthDb },
        )
      : null;
    if (range < this.config.minRange || range > this.config.maxRange) {
      return { status: "out-of-range", observation: null, acoustic: channel };
    }
    const trueBearing = wrapAngle(
      Math.atan2(relative.y, relative.x) - sensor.heading,
    );
    if (Math.abs(trueBearing) > this.config.fovHalfAngle) {
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
    return { status: "locked", observation, acoustic: channel };
  }
}
