import { describe, expect, it } from "vitest";
import { cpa, wrapAngle } from "../src/sim/math";
import { rk4Step } from "../src/sim/rk4";

describe("numerical foundations", () => {
  it("wraps angles to [-pi, pi)", () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(-Math.PI, 12);
    expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it("integrates constant velocity exactly with RK4", () => {
    const next = rk4Step([2, -3], 0.5, () => [4, 6]);
    expect(next[0]).toBeCloseTo(4, 12);
    expect(next[1]).toBeCloseTo(0, 12);
  });

  it("computes closest point of approach", () => {
    const result = cpa({ x: 100, y: 10 }, { x: -10, y: 0 });
    expect(result.time).toBeCloseTo(10, 12);
    expect(result.distance).toBeCloseTo(10, 12);
  });
});
