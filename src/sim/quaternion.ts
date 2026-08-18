import { clamp } from "./math";
import type { Quaternion, Vec3 } from "./types";

export const IDENTITY_QUATERNION: Quaternion = { w: 1, x: 0, y: 0, z: 0 };

export function quaternionNorm(value: Quaternion): number {
  return Math.hypot(value.w, value.x, value.y, value.z);
}

export function normalizeQuaternion(value: Quaternion): Quaternion {
  const norm = quaternionNorm(value);
  if (!Number.isFinite(norm) || norm < 1e-15) return { ...IDENTITY_QUATERNION };
  return {
    w: value.w / norm,
    x: value.x / norm,
    y: value.y / norm,
    z: value.z / norm,
  };
}

export function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function conjugateQuaternion(value: Quaternion): Quaternion {
  return { w: value.w, x: -value.x, y: -value.y, z: -value.z };
}

export function quaternionFromHeading(heading: number): Quaternion {
  const half = heading * 0.5;
  return { w: Math.cos(half), x: 0, y: 0, z: Math.sin(half) };
}

export function rotateVector(value: Quaternion, vector: Vec3): Vec3 {
  const q = normalizeQuaternion(value);
  const pure: Quaternion = { w: 0, x: vector.x, y: vector.y, z: vector.z };
  const rotated = multiplyQuaternion(multiplyQuaternion(q, pure), conjugateQuaternion(q));
  return { x: rotated.x, y: rotated.y, z: rotated.z };
}

export function inverseRotateVector(value: Quaternion, vector: Vec3): Vec3 {
  return rotateVector(conjugateQuaternion(normalizeQuaternion(value)), vector);
}

export function quaternionDerivative(
  orientation: Quaternion,
  bodyAngularVelocity: Vec3,
): Quaternion {
  const omega: Quaternion = {
    w: 0,
    x: bodyAngularVelocity.x,
    y: bodyAngularVelocity.y,
    z: bodyAngularVelocity.z,
  };
  const derivative = multiplyQuaternion(orientation, omega);
  return {
    w: derivative.w * 0.5,
    x: derivative.x * 0.5,
    y: derivative.y * 0.5,
    z: derivative.z * 0.5,
  };
}

/**
 * NED Euler extraction with the body frame x = forward, y = starboard,
 * z = down. Heading is atan2(East, North), pitch is positive nose-up, and
 * roll is positive starboard-down about the forward axis.
 */
export function orientationAngles(orientation: Quaternion): {
  heading: number;
  roll: number;
  pitch: number;
} {
  const forward = rotateVector(orientation, { x: 1, y: 0, z: 0 });
  const up = rotateVector(orientation, { x: 0, y: 0, z: -1 });
  const horizontal = Math.hypot(forward.x, forward.y);
  const heading = Math.atan2(forward.y, forward.x);
  const pitch = Math.atan2(-forward.z, Math.max(1e-15, horizontal));
  const horizontalRight = horizontal < 1e-12
    ? { x: 0, y: 1, z: 0 }
    : { x: -forward.y / horizontal, y: forward.x / horizontal, z: 0 };
  const roll = Math.atan2(
    up.x * horizontalRight.x + up.y * horizontalRight.y,
    clamp(-up.z, -1, 1),
  );
  return { heading, roll, pitch };
}

export function slerpQuaternion(a: Quaternion, b: Quaternion, amount: number): Quaternion {
  let end = b;
  let dot = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  if (dot < 0) {
    dot = -dot;
    end = { w: -b.w, x: -b.x, y: -b.y, z: -b.z };
  }
  if (dot > 0.9995) {
    return normalizeQuaternion({
      w: a.w + (end.w - a.w) * amount,
      x: a.x + (end.x - a.x) * amount,
      y: a.y + (end.y - a.y) * amount,
      z: a.z + (end.z - a.z) * amount,
    });
  }
  const theta = Math.acos(clamp(dot, -1, 1));
  const sinTheta = Math.sin(theta);
  const left = Math.sin((1 - amount) * theta) / sinTheta;
  const right = Math.sin(amount * theta) / sinTheta;
  return {
    w: a.w * left + end.w * right,
    x: a.x * left + end.x * right,
    y: a.y * left + end.y * right,
    z: a.z * left + end.z * right,
  };
}
