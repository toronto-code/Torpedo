import { runHeadless } from "../sim/engine";
import { createAmbiguityScenarioConfig } from "../sim/scenarios";
import type { AmbiguityPreset } from "../sim/scenarios";
import type { ContactTruth, SimulationConfig } from "../sim/types";

/**
 * Sequential salvo study: shots-to-kill under countermeasures.
 *
 * The full simultaneous-multi-weapon engine is future work; this study
 * answers the weaponeering question honestly with the deterministic
 * single-weapon engine by modeling SEQUENTIAL shots:
 *
 *  - Shot 1: the standard engagement. A clean hostile kill is 1 shot.
 *  - If the countermeasure suite seduces or defeats shot 1, the hostile
 *    survives — but its expendables are depleted (decoys, knuckles, and
 *    screens decay in tens of seconds) and it has kept evading. After a
 *    synthetic reload/transit delay the follow-up weapon is fired at the
 *    survivor: its end-of-engagement state extrapolated through the
 *    delay, with the countermeasure contacts removed from the scene.
 *  - A survivor of two shots is censored ("3+" — enough is not being
 *    carried today).
 *
 * The follow-up carries one hard-won fact forward: the contact the first
 * shot detonated against is discredited and removed from the re-attack
 * scene (a team does not shoot the same distraction twice). Everything
 * else restarts fresh — classification state does not persist across
 * shots, which is a stated pessimism; platform-picture persistence is
 * future work with the multi-weapon engine.
 *
 * Everything is deterministic per (preset, seed).
 */

export interface SalvoRunResult {
  seed: number;
  shots: 1 | 2 | 3;
  firstOutcome: string;
  secondOutcome: string | null;
  /** True 3D fuze miss on the final shot (m), when it detonated. */
  finalFuzeMiss: number | null;
}

export interface SalvoVariantSummary {
  id: AmbiguityPreset;
  runs: number;
  meanShots: number;
  oneShotKills: number;
  twoShotKills: number;
  survivors: number;
}

export interface SalvoStudyReport {
  baseSeed: number;
  runsPerVariant: number;
  /** Synthetic delay between shots (s): reload, transit, re-attack setup. */
  followUpDelayS: number;
  variants: SalvoVariantSummary[];
  runs: SalvoRunResult[];
}

/** Expendable countermeasures are gone by the time the follow-up arrives. */
const EXPENDABLE_KINDS = new Set(["decoy", "knuckle", "jammer", "bubble-screen"]);

const FOLLOW_UP_DELAY_S = 90;

function extrapolateSurvivor(
  hostile: ContactTruth,
  delayS: number,
  diveDepth: number,
): { position: { x: number; y: number; z: number }; heading: number; speed: number; depth: number } {
  return {
    position: {
      x: hostile.position.x + hostile.velocity.x * delayS,
      y: hostile.position.y + hostile.velocity.y * delayS,
      z: hostile.depth,
    },
    heading: hostile.heading,
    speed: hostile.speed,
    // If the survivor was mid-dive, it finishes the dive during the delay.
    depth: Math.min(diveDepth, hostile.depth + 1.5 * delayS),
  };
}

function followUpConfig(
  preset: AmbiguityPreset,
  seed: number,
  hostile: ContactTruth,
  /** Contact the first shot detonated against, when it was not the
   *  hostile: the team will not re-attack the same distraction. */
  discreditedContactId: string | null,
): SimulationConfig {
  const config = createAmbiguityScenarioConfig(preset, seed);
  config.contacts = (config.contacts ?? []).filter(
    (spec) =>
      !EXPENDABLE_KINDS.has(spec.kind) && spec.id !== discreditedContactId,
  );
  const hostileSpec = config.contacts.find((spec) => spec.id === "hostile");
  if (hostileSpec) {
    const survivor = extrapolateSurvivor(
      hostile,
      FOLLOW_UP_DELAY_S,
      hostileSpec.perception?.diveDepth ?? hostile.depth,
    );
    hostileSpec.vehicle.initial = {
      ...hostileSpec.vehicle.initial,
      ...survivor,
    };
    hostileSpec.vehicle.commandedSpeed = survivor.speed;
    hostileSpec.vehicle.commandedDepth = survivor.depth;
  }
  return config;
}

export function runSalvoStudy(options: {
  presets?: AmbiguityPreset[];
  runs: number;
  baseSeed: number;
}): SalvoStudyReport {
  const presets = options.presets ?? ["decoy-stress", "high-ambiguity"];
  const runs: SalvoRunResult[] = [];
  const variants: SalvoVariantSummary[] = [];

  for (const preset of presets) {
    let oneShot = 0;
    let twoShot = 0;
    let survivors = 0;
    let shotSum = 0;
    for (let index = 0; index < options.runs; index += 1) {
      const seed = options.baseSeed + index;
      const first = runHeadless(
        createAmbiguityScenarioConfig(preset, seed),
      ).result;
      if (first.engagementOutcome === "correct-hostile") {
        oneShot += 1;
        shotSum += 1;
        runs.push({
          seed,
          shots: 1,
          firstOutcome: first.engagementOutcome,
          secondOutcome: null,
          finalFuzeMiss: first.fuzeMissDistance ?? null,
        });
        continue;
      }
      const lastSample = runHeadless(
        createAmbiguityScenarioConfig(preset, seed),
      ).telemetry.at(-1);
      const survivor = lastSample?.contacts?.find((c) => c.id === "hostile");
      if (!survivor) {
        survivors += 1;
        shotSum += 3;
        runs.push({
          seed,
          shots: 3,
          firstOutcome: first.engagementOutcome ?? "miss",
          secondOutcome: "no-survivor-state",
          finalFuzeMiss: null,
        });
        continue;
      }
      const discredited =
        first.engagedContact && first.engagedContact.id !== "hostile"
          ? first.engagedContact.id
          : null;
      const second = runHeadless(
        followUpConfig(preset, seed, survivor, discredited),
      ).result;
      const secondKill = second.engagementOutcome === "correct-hostile";
      if (secondKill) {
        twoShot += 1;
        shotSum += 2;
      } else {
        survivors += 1;
        shotSum += 3;
      }
      runs.push({
        seed,
        shots: secondKill ? 2 : 3,
        firstOutcome: first.engagementOutcome ?? "miss",
        secondOutcome: second.engagementOutcome ?? "miss",
        finalFuzeMiss: second.fuzeMissDistance ?? null,
      });
    }
    variants.push({
      id: preset,
      runs: options.runs,
      meanShots: shotSum / options.runs,
      oneShotKills: oneShot,
      twoShotKills: twoShot,
      survivors,
    });
  }

  return {
    baseSeed: options.baseSeed,
    runsPerVariant: options.runs,
    followUpDelayS: FOLLOW_UP_DELAY_S,
    variants,
    runs,
  };
}
