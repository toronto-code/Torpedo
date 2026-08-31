import { depthRateAutopilot, type VehicleControl } from "./dynamics";
import {
  createVehicleDynamics,
  type VehicleDynamics,
} from "./dynamics-model";
import { wrapAngle } from "./math";
import { initialTargetPerceptionState, type TargetPerceptionState } from "./target-perception";
import type {
  ContactBehavior,
  ContactSpec,
  ScenarioConfig,
  SimulationConfig,
  VehicleState,
} from "./types";

export interface ContactRuntime {
  spec: ContactSpec;
  state: VehicleState;
  active: boolean;
  dynamics: VehicleDynamics;
  /** Truth-side threat perception state; present when spec.perception is. */
  perceptionState?: TargetPerceptionState;
}

/**
 * Multi-contact truth layer. Behaviors are deterministic functions of time,
 * state, and range-to-weapon in the scenario.ts style. The legacy
 * single-target scenario maps onto the same behavior commands so the
 * multi-contact engine path and the legacy path share one implementation.
 */

export function behaviorFromScenario(scenario: ScenarioConfig): ContactBehavior {
  switch (scenario.kind) {
    case "constant-velocity":
      return { kind: "constant-velocity" };
    case "constant-turn":
      return { kind: "constant-turn", rate: scenario.targetTurnRate };
    case "scripted-evasive":
      return {
        kind: "scripted-evasive",
        triggerRange: scenario.evasiveTriggerRange,
        rate: scenario.evasiveTurnRate,
      };
  }
}

export function contactYawRateCommand(
  behavior: ContactBehavior | undefined,
  range: number,
  timestamp: number,
): number {
  switch (behavior?.kind) {
    case "constant-turn":
      return behavior.rate;
    case "scripted-evasive":
      return range <= behavior.triggerRange ? behavior.rate : 0;
    case "biologic-wander":
      // Smooth deterministic weave: heading(t) = heading0 + A sin(2πt/T).
      return (
        behavior.amplitude *
        (2 * Math.PI / behavior.period) *
        Math.cos((2 * Math.PI * timestamp) / behavior.period)
      );
    default:
      return 0;
  }
}

export function createContactRuntime(
  spec: ContactSpec,
  config: SimulationConfig,
): ContactRuntime {
  const dynamics = createVehicleDynamics(
    spec.vehicle.dynamicsModel ?? "planar-2.5d",
    config.dynamics.sixDof,
  );
  return {
    spec,
    state: dynamics.initialize(spec.vehicle),
    active: spec.behavior?.kind !== "decoy",
    dynamics,
    ...(spec.perception
      ? { perceptionState: initialTargetPerceptionState() }
      : {}),
  };
}

/** Effective target strength for a contact at its current aspect to the
 *  weapon: aspect-dependent when configured, otherwise the flat value. */
export function effectiveTargetStrength(
  runtime: ContactRuntime,
  weaponPosition: { x: number; y: number },
  fallbackDb: number,
): number {
  const aspectEcho = runtime.spec.aspectEcho;
  if (!aspectEcho) {
    return runtime.spec.targetStrengthDb ?? fallbackDb;
  }
  const dx = weaponPosition.x - runtime.state.position.x;
  const dy = weaponPosition.y - runtime.state.position.y;
  const bearingToWeapon = Math.atan2(dy, dx);
  let aspect = bearingToWeapon - runtime.state.heading;
  aspect = Math.atan2(Math.sin(aspect), Math.cos(aspect));
  return aspectEcho.bowDb + (aspectEcho.beamDb - aspectEcho.bowDb) * Math.sin(aspect) ** 2;
}

export function contactControl(
  runtime: ContactRuntime,
  rangeToWeapon: number,
  timestamp: number,
): VehicleControl {
  return {
    yawRateCommand: contactYawRateCommand(
      runtime.spec.behavior,
      rangeToWeapon,
      timestamp,
    ),
    depthRateCommand:
      (runtime.spec.vehicle.dynamicsModel ?? "planar-2.5d") === "six-dof"
        ? depthRateAutopilot(
            runtime.spec.vehicle.commandedDepth,
            runtime.state,
            runtime.spec.vehicle.parameters,
          )
        : 0,
    speedCommand: runtime.spec.vehicle.commandedSpeed,
  };
}

/** Activates an inactive decoy at its deploying contact's current state. */
export function activateDecoy(
  runtime: ContactRuntime,
  spawner: ContactRuntime,
): void {
  const behavior = runtime.spec.behavior;
  if (behavior?.kind !== "decoy") return;
  const offset = behavior.headingOffset ?? 0;
  const initial = {
    ...runtime.spec.vehicle.initial,
    position: { ...spawner.state.position },
    heading: wrapAngle(spawner.state.heading + offset),
    speed: behavior.deploySpeed,
    depth: spawner.state.depth,
  };
  initial.position = { ...spawner.state.position, z: spawner.state.depth };
  runtime.state = runtime.dynamics.initialize({
    ...runtime.spec.vehicle,
    initial,
  });
  runtime.active = true;
}
