import { acousticChannel } from "./acoustics";
import { wrapAngle } from "./math";
import type { SeededRandom } from "./random";
import type {
  AcousticConfig,
  EnvironmentConfig,
  TargetPerceptionConfig,
  VehicleState,
} from "./types";

/**
 * Truth-side threat perception: a contact hears the weapon's active pings
 * through the same acoustic channel the seeker uses — including refraction
 * across the sound-speed layer, so diving below the layer shields the
 * contact in both directions. After sustained detection the contact reacts:
 * it turns away from its (noisy) bearing estimate of the threat and dives.
 *
 * This is truth-side sensing of truth emissions with seeded noise; it is
 * never visible to the weapon's estimation chain.
 */

export interface TargetPerceptionState {
  reacting: boolean;
  detectedSince: number | null;
  lastHeardAt: number | null;
  /** Bearing estimate from the contact toward the perceived threat (rad). */
  heardBearing: number | null;
}

export function initialTargetPerceptionState(): TargetPerceptionState {
  return { reacting: false, detectedSince: null, lastHeardAt: null, heardBearing: null };
}

export interface PerceptionUpdateInput {
  state: TargetPerceptionState;
  now: number;
  weapon: VehicleState;
  contact: VehicleState;
  perception: TargetPerceptionConfig;
  environment?: EnvironmentConfig;
  acoustic?: AcousticConfig;
  random: SeededRandom;
}

export function updateTargetPerception(
  input: PerceptionUpdateInput,
): TargetPerceptionState {
  const state: TargetPerceptionState = { ...input.state };
  const dx = input.weapon.position.x - input.contact.position.x;
  const dy = input.weapon.position.y - input.contact.position.y;
  const range = Math.hypot(dx, dy);
  const trueBearing = Math.atan2(dy, dx);

  let heard = false;
  if (input.environment && input.acoustic?.enabled) {
    const channel = acousticChannel(
      input.now,
      range,
      input.weapon.depth,
      input.contact.depth,
      input.environment,
      input.acoustic,
    );
    const receivedDb =
      input.acoustic.sourceLevelDb - channel.oneWayTransmissionLossDb;
    const snrDb = receivedDb - input.acoustic.ambientNoiseDb;
    const scale = Math.max(0.01, input.perception.detectionTransitionDb);
    const detectionProbability = 1 / (
      1 + Math.exp(-(snrDb - input.perception.detectionThresholdDb) / scale)
    );
    if (input.random.next() <= detectionProbability) {
      heard = true;
    }
  }

  if (heard) {
    if (state.detectedSince === null) state.detectedSince = input.now;
    state.lastHeardAt = input.now;
    state.heardBearing = wrapAngle(
      trueBearing + input.random.gaussian(0, input.perception.bearingSigmaRad),
    );
  } else if (
    state.detectedSince !== null &&
    state.lastHeardAt !== null &&
    input.now - state.lastHeardAt > input.perception.reactionGrace
  ) {
    state.detectedSince = null;
  }

  state.reacting =
    state.detectedSince !== null &&
    input.now - state.detectedSince >= input.perception.reactionDelay;
  return state;
}
