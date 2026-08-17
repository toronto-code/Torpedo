import {
  initialVehicleState,
  integrateVehicle,
  type VehicleControl,
} from "./dynamics";
import { initialSixDofState, integrateSixDofVehicle } from "./six-dof";
import type {
  DynamicsModel,
  SixDofConfig,
  VehicleConfig,
  VehicleState,
} from "./types";

export interface VehicleDynamics {
  readonly model: DynamicsModel;
  initialize(vehicle: VehicleConfig): VehicleState;
  integrate(
    state: VehicleState,
    control: VehicleControl,
    vehicle: VehicleConfig,
    dt: number,
  ): VehicleState;
}

class PlanarDynamics implements VehicleDynamics {
  readonly model = "planar-2.5d" as const;

  initialize(vehicle: VehicleConfig): VehicleState {
    return initialVehicleState(vehicle);
  }

  integrate(state: VehicleState, control: VehicleControl, vehicle: VehicleConfig, dt: number): VehicleState {
    return integrateVehicle(state, control, vehicle.parameters, dt);
  }
}

class SixDofDynamics implements VehicleDynamics {
  readonly model = "six-dof" as const;

  constructor(private readonly config: SixDofConfig) {}

  initialize(vehicle: VehicleConfig): VehicleState {
    return initialSixDofState(vehicle, this.config);
  }

  integrate(state: VehicleState, control: VehicleControl, vehicle: VehicleConfig, dt: number): VehicleState {
    return integrateSixDofVehicle(state, control, vehicle, this.config, dt);
  }
}

export function createVehicleDynamics(model: DynamicsModel, config: SixDofConfig): VehicleDynamics {
  return model === "six-dof" ? new SixDofDynamics(config) : new PlanarDynamics();
}

export const PLANAR_DYNAMICS: VehicleDynamics = new PlanarDynamics();
