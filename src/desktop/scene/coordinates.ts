import * as THREE from "three";

import type { Vec2, Vec3 } from "../../sim/types";
import type { Quaternion } from "../../sim/types";

/**
 * The single conversion layer between NED simulation coordinates and the
 * right-handed Y-up Three.js render space.
 *
 *   render.x =  sim.x   (North)
 *   render.y = -sim.z   (up; simulation z is positive down)
 *   render.z =  sim.y   (East)
 *
 * This is a proper rotation (Rx(90°) applied to NED vectors), so it preserves
 * handedness — a naive axis swap would mirror the world. All orientation
 * conversions use the conjugating rotation C with C * q_ned * C^-1, which
 * keeps body +X forward and maps NED yaw/pitch/roll onto the render frame.
 */
const C = new THREE.Quaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const C_INVERSE = C.clone().invert();

export function toRenderPosition(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value.x, -value.z, value.y);
}

/** Allocation-free variant for per-frame hot paths. */
export function toRenderPositionInto(value: Vec3, target: THREE.Vector3): THREE.Vector3 {
  return target.set(value.x, -value.z, value.y);
}

export function toRenderDirection(value: Vec3): THREE.Vector3 {
  return toRenderPosition(value);
}

/** Horizontal (North, East) pair at a fixed render height. */
export function toRenderHorizontal(value: Vec2, renderY: number): THREE.Vector3 {
  return new THREE.Vector3(value.x, renderY, value.y);
}

export function toRenderHorizontalInto(
  value: Vec2,
  renderY: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  return target.set(value.x, renderY, value.y);
}

export function toRenderQuaternion(value: Quaternion): THREE.Quaternion {
  return new THREE.Quaternion(value.x, value.y, value.z, value.w)
    .premultiply(C)
    .multiply(C_INVERSE);
}

export function toRenderQuaternionInto(
  value: Quaternion,
  target: THREE.Quaternion,
): THREE.Quaternion {
  return target.set(value.x, value.y, value.z, value.w)
    .premultiply(C)
    .multiply(C_INVERSE);
}

export function nedToRenderMatrix(): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationFromQuaternion(C);
}
