export type Derivative = (state: readonly number[]) => number[];

function offset(
  state: readonly number[],
  derivative: readonly number[],
  scale: number,
): number[] {
  return state.map((value, index) => value + derivative[index] * scale);
}

export function rk4Step(
  state: readonly number[],
  dt: number,
  derivative: Derivative,
): number[] {
  const k1 = derivative(state);
  const k2 = derivative(offset(state, k1, dt * 0.5));
  const k3 = derivative(offset(state, k2, dt * 0.5));
  const k4 = derivative(offset(state, k3, dt));
  return state.map(
    (value, index) =>
      value +
      (dt / 6) *
        (k1[index] + 2 * k2[index] + 2 * k3[index] + k4[index]),
  );
}
