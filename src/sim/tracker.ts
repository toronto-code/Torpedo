import { ExtendedKalmanFilter, measurementJacobian } from "./ekf";
import { wrapAngle } from "./math";
import { inverse, multiply, type Matrix } from "./matrix";
import { RawObservationTracker } from "./trackers";
import type {
  EstimatorConfig,
  SensorObservation,
  TrackEstimate,
} from "./types";

export type TrackQuality = "tentative" | "confirmed" | "coasting" | "deleted";

/** Acoustic features accumulated per track from delivered observations. */
export interface TrackFeatures {
  /** Mean implied target strength (dB): echo level with spreading removed. */
  impliedTargetStrengthDb: number | null;
  /** Running 1-sigma of the implied target strength (dB): echo stability.
   *  Streaky/fluctuating returns score high; aspect-driven returns low. */
  impliedTsSigmaDb: number | null;
  /** Last measured signal-to-noise ratio (dB). */
  snrDb: number | null;
  /** Mean synthetic friendly-marking correlation (0..1). */
  signatureCorrelation: number | null;
  /** Smoothed |depth rate| from depression-angle measurements (m/s). */
  depthRateMPerS: number | null;
  /** Smoothed passive radiated-noise SNR (dB); null when passive-silent. */
  passiveSnrDb: number | null;
  observationCount: number;
}

export interface TrackMeta {
  id: number;
  createdAt: number;
  lastObservationAt: number;
  lastDeliveryDelay: number;
  acceptedCount: number;
  quality: TrackQuality;
  features: TrackFeatures;
  /** Smoothed depression-angle contact depth (m, positive down); null until
   *  a depth-bearing observation arrives. Steering aid, not identity. */
  depth: number | null;
}

export interface LiveTrack {
  meta: TrackMeta;
  estimate: TrackEstimate;
}

interface InternalTrack {
  meta: TrackMeta;
  ekf: ExtendedKalmanFilter;
  raw: RawObservationTracker;
  impliedTsSum: number;
  correlationSum: number;
  // Welford running variance for implied target strength.
  tsMean: number;
  tsVariance: number;
  tsCount: number;
  // Depth-rate smoothing from successive depth observations.
  lastDepthAt: number | null;
  lastDepthValue: number;
}

export interface TrackerOptions {
  estimator: EstimatorConfig;
  /** Accepted observations required to confirm a track. */
  confirmationCount: number;
  /** Seconds without confirmation before a tentative track is deleted. */
  tentativeTimeout: number;
  /** Seconds without updates before a track is deleted. */
  deletionTimeout: number;
}

export interface AssociationResult {
  trackId: number;
  accepted: boolean;
  distance: number | null;
}

/**
 * Nearest-neighbor multi-target tracker over anonymous observations.
 *
 * Association gates each track (predicted to the observation timestamp,
 * non-mutating) on bearing/range residuals with the Mahalanobis distance;
 * the lowest-distance track wins, ties break to the lowest track id, so the
 * tracker is deterministic given the observation stream. Unassigned returns
 * initiate tentative tracks. Deliveries arrive in observation-time order, so
 * per-track update sequences stay monotonic — the per-track EKF never sees
 * out-of-sequence observations.
 */
export class MultiTargetTracker {
  private tracks: InternalTrack[] = [];
  private nextId = 1;

  constructor(
    private readonly options: TrackerOptions,
    private readonly mode: "raw" | "ekf",
  ) {}

  get trackCount(): number {
    return this.tracks.filter((track) => track.meta.quality !== "deleted")
      .length;
  }

  process(now: number, observation: SensorObservation): AssociationResult {
    let best: { track: InternalTrack; distance: number } | null = null;
    for (const track of this.tracks) {
      if (track.meta.quality === "deleted") continue;
      const distance = this.associationDistance(track, observation);
      if (distance === null) continue;
      if (best === null || distance < best.distance) {
        best = { track, distance };
      }
    }

    if (best) {
      const accepted =
        this.mode === "ekf"
          ? best.track.ekf.process(observation)
          : (best.track.raw.process(observation), true);
      best.track.meta.lastObservationAt = observation.observedAt;
      best.track.meta.lastDeliveryDelay =
        observation.deliveredAt - observation.observedAt;
      if (accepted) {
        best.track.meta.acceptedCount += 1;
        if (
          best.track.meta.acceptedCount >= this.options.confirmationCount
        ) {
          best.track.meta.quality = "confirmed";
        }
      }
      this.updateFeatures(best.track, observation);
      return { trackId: best.track.meta.id, accepted, distance: best.distance };
    }

    const track = this.initiateTrack(observation);
    return { trackId: track.meta.id, accepted: true, distance: null };
  }

  /** Ages tracks; call once per guidance update. */
  prune(now: number): void {
    for (const track of this.tracks) {
      if (track.meta.quality === "deleted") continue;
      const age = now - track.meta.lastObservationAt;
      if (
        track.meta.quality === "tentative" &&
        track.meta.acceptedCount < this.options.confirmationCount &&
        age > this.options.tentativeTimeout
      ) {
        track.meta.quality = "deleted";
        continue;
      }
      if (track.meta.quality === "confirmed") {
        const staleness =
          age -
          track.meta.lastDeliveryDelay -
          this.options.estimator.staleAfter;
        if (staleness > 0) track.meta.quality = "coasting";
      }
      if (
        track.meta.quality === "coasting" &&
        age > this.options.deletionTimeout
      ) {
        track.meta.quality = "deleted";
      }
    }
    if (this.tracks.length > 32) {
      this.tracks = this.tracks.filter(
        (track) => track.meta.quality !== "deleted",
      );
    }
  }

  liveTracks(now: number): LiveTrack[] {
    return this.tracks
      .filter((track) => track.meta.quality !== "deleted")
      .map((track) => ({
        meta: { ...track.meta },
        estimate: this.estimateOf(track, now),
      }))
      .filter((entry): entry is LiveTrack => entry.estimate !== null);
  }

  estimateForTrack(now: number, trackId: number): TrackEstimate | null {
    const track = this.tracks.find(
      (candidate) => candidate.meta.id === trackId,
    );
    if (!track || track.meta.quality === "deleted") return null;
    return this.estimateOf(track, now);
  }

  /** Smoothed depth estimate for a track (m down), or null when none. */
  depthForTrack(trackId: number): number | null {
    const track = this.tracks.find(
      (candidate) => candidate.meta.id === trackId,
    );
    if (!track || track.meta.quality === "deleted") return null;
    return track.meta.depth;
  }

  private estimateOf(track: InternalTrack, now: number): TrackEstimate | null {
    return this.mode === "ekf"
      ? track.ekf.estimateAt(now)
      : track.raw.estimateAt(now);
  }

  private initiateTrack(observation: SensorObservation): InternalTrack {
    const track: InternalTrack = {
      meta: {
        id: this.nextId++,
        createdAt: observation.observedAt,
        lastObservationAt: observation.observedAt,
        lastDeliveryDelay: observation.deliveredAt - observation.observedAt,
        acceptedCount: 1,
        quality: "tentative",
        features: {
          impliedTargetStrengthDb: null,
          impliedTsSigmaDb: null,
          snrDb: null,
          signatureCorrelation: null,
          depthRateMPerS: null,
          passiveSnrDb: null,
          observationCount: 0,
        },
        depth: null,
      },
      ekf: new ExtendedKalmanFilter(this.options.estimator),
      raw: new RawObservationTracker(),
      impliedTsSum: 0,
      correlationSum: 0,
      tsMean: 0,
      tsVariance: 0,
      tsCount: 0,
      lastDepthAt: null,
      lastDepthValue: 0,
    };
    track.ekf.process(observation);
    track.raw.process(observation);
    this.updateFeatures(track, observation);
    this.tracks.push(track);
    return track;
  }

  private updateFeatures(track: InternalTrack, observation: SensorObservation): void {
    const features = track.meta.features;
    features.observationCount += 1;
    if (observation.acoustic) {
      features.snrDb = observation.acoustic.signalToNoiseDb;
    }
    if (observation.impliedTargetStrengthDb !== undefined) {
      track.impliedTsSum += observation.impliedTargetStrengthDb;
      features.impliedTargetStrengthDb =
        track.impliedTsSum / features.observationCount;
      // Welford running variance: echo stability is a classification cue
      // (streaky fluctuators vs smooth aspect-driven returns).
      track.tsCount += 1;
      const delta = observation.impliedTargetStrengthDb - track.tsMean;
      track.tsMean += delta / track.tsCount;
      track.tsVariance += delta * (observation.impliedTargetStrengthDb - track.tsMean);
      features.impliedTsSigmaDb =
        track.tsCount >= 3
          ? Math.sqrt(Math.max(0, track.tsVariance / (track.tsCount - 1)))
          : null;
    }
    if (observation.signatureCorrelation !== undefined) {
      track.correlationSum += observation.signatureCorrelation;
      features.signatureCorrelation =
        track.correlationSum / features.observationCount;
    }
    if (observation.targetDepth !== undefined) {
      // Exponential smoothing keeps up with a 1-2 m/s dive while averaging
      // down the depression-angle noise.
      track.meta.depth =
        track.meta.depth === null
          ? observation.targetDepth
          : track.meta.depth + 0.35 * (observation.targetDepth - track.meta.depth);
      if (track.lastDepthAt !== null) {
        const dt = observation.observedAt - track.lastDepthAt;
        if (dt > 1e-3) {
          const rate =
            Math.abs(observation.targetDepth - track.lastDepthValue) / dt;
          features.depthRateMPerS =
            features.depthRateMPerS === null
              ? rate
              : features.depthRateMPerS + 0.25 * (rate - features.depthRateMPerS);
        }
      }
      track.lastDepthAt = observation.observedAt;
      track.lastDepthValue = observation.targetDepth;
    }
    if (observation.passiveSnrDb !== undefined) {
      features.passiveSnrDb =
        features.passiveSnrDb === null
          ? observation.passiveSnrDb
          : features.passiveSnrDb +
            0.3 * (observation.passiveSnrDb - features.passiveSnrDb);
    }
  }

  private associationDistance(
    track: InternalTrack,
    observation: SensorObservation,
  ): number | null {
    const estimate = this.estimateOf(track, observation.observedAt);
    if (!estimate) return null;
    const state = [
      estimate.position.x,
      estimate.position.y,
      estimate.velocity.x,
      estimate.velocity.y,
    ];
    const dx = state[0] - observation.sensorPosition.x;
    const dy = state[1] - observation.sensorPosition.y;
    const range = Math.hypot(dx, dy);
    const expectedBearing = wrapAngle(
      Math.atan2(dy, dx) - observation.sensorHeading,
    );
    const residual = [
      wrapAngle(observation.bearing - expectedBearing),
      observation.range - range,
    ];
    const h = measurementJacobian(state, observation.sensorPosition);
    const p = estimate.covariance;
    const hphT = multiply(multiply(h, p), transpose2x2(h));
    const s: Matrix = [
      [hphT[0][0] + observation.bearingVariance, hphT[0][1]],
      [hphT[1][0], hphT[1][1] + observation.rangeVariance],
    ];
    const sInverse = inverse(s);
    if (!sInverse) return null;
    const value =
      residual[0] *
        (sInverse[0][0] * residual[0] + sInverse[0][1] * residual[1]) +
      residual[1] *
        (sInverse[1][0] * residual[0] + sInverse[1][1] * residual[1]);
    // Coasting tracks get a relaxed gate so a maneuvering contact that
    // briefly exceeds the tight gate resurrects its own track instead of
    // splitting into a duplicate.
    const gate =
      track.meta.quality === "coasting"
        ? this.options.estimator.innovationGate * 2
        : this.options.estimator.innovationGate;
    return value <= gate ? value : null;
  }
}

function transpose2x2(matrix: Matrix): Matrix {
  return [
    [matrix[0][0], matrix[1][0]],
    [matrix[0][1], matrix[1][1]],
  ];
}
