import type { Vec2 } from "./types";

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function wrapAngle(angle: number): number {
  let wrapped = (angle + Math.PI) % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped - Math.PI;
}

export function add2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, z: a.z + b.z };
}

export function subtract2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

export function scale2(v: Vec2, scalar: number): Vec2 {
  return { x: v.x * scalar, z: v.z * scalar };
}

export function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.z * b.z;
}

export function cross2(a: Vec2, b: Vec2): number {
  return a.x * b.z - a.z * b.x;
}

export function magnitude2(v: Vec2): number {
  return Math.hypot(v.x, v.z);
}

export function distance2(a: Vec2, b: Vec2): number {
  return magnitude2(subtract2(a, b));
}

export function headingVector(heading: number): Vec2 {
  return { x: Math.cos(heading), z: Math.sin(heading) };
}

export function isFiniteArray(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function cpa(
  relativePosition: Vec2,
  relativeVelocity: Vec2,
): { distance: number; time: number } {
  const speedSquared = dot2(relativeVelocity, relativeVelocity);
  const time =
    speedSquared < 1e-12
      ? 0
      : Math.max(0, -dot2(relativePosition, relativeVelocity) / speedSquared);
  const atCpa = add2(relativePosition, scale2(relativeVelocity, time));
  return { distance: magnitude2(atCpa), time };
}
