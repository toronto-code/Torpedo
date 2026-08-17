import type { ScenarioConfig, VehicleState } from "./types";

export function targetYawRateCommand(
  scenario: ScenarioConfig,
  range: number,
): number {
  switch (scenario.kind) {
    case "constant-velocity":
      return 0;
    case "constant-turn":
      return scenario.targetTurnRate;
    case "scripted-evasive":
      return range <= scenario.evasiveTriggerRange
        ? scenario.evasiveTurnRate
        : 0;
  }
}

export function horizontalRange(a: VehicleState, b: VehicleState): number {
  return Math.hypot(
    a.position.x - b.position.x,
    a.position.z - b.position.z,
  );
}
