import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  nedToRenderMatrix,
  toRenderHorizontal,
  toRenderPosition,
  toRenderQuaternion,
} from "../src/desktop/scene/coordinates";
import { Trail } from "../src/desktop/scene/trail";
import { quaternionFromEuler } from "../src/sim/quaternion";

describe("NED to Three.js conversion layer", () => {
  it("maps the NED basis axes onto the documented render axes", () => {
    const north = toRenderPosition({ x: 1, y: 0, z: 0 });
    expect(north.x).toBeCloseTo(1, 12);
    expect(north.y).toBeCloseTo(0, 12);
    expect(north.z).toBeCloseTo(0, 12);
    const east = toRenderPosition({ x: 0, y: 1, z: 0 });
    expect(east.x).toBeCloseTo(0, 12);
    expect(east.y).toBeCloseTo(0, 12);
    expect(east.z).toBeCloseTo(1, 12);
    // Depth is positive down in NED and becomes negative (below surface) in
    // the Y-up render space.
    const down = toRenderPosition({ x: 0, y: 0, z: 1 });
    expect(down.x).toBeCloseTo(0, 12);
    expect(down.y).toBeCloseTo(-1, 12);
    expect(down.z).toBeCloseTo(0, 12);
  });

  it("is a proper rotation: handedness preserved, no mirroring", () => {
    const matrix = nedToRenderMatrix();
    const determinant = matrix.determinant();
    expect(determinant).toBeCloseTo(1, 12);

    // Cross-product equivariance: R(a x b) === R(a) x R(b). A mirrored or
    // naive axis swap breaks this.
    const east = { x: 0, y: 2, z: 0 };
    const down = { x: 0, y: 0, z: 1.5 };
    const crossSim = {
      x: east.y * down.z - east.z * down.y,
      y: east.z * down.x - east.x * down.z,
      z: east.x * down.y - east.y * down.x,
    };
    const mapped = toRenderPosition(crossSim);
    const renderedCross = toRenderPosition(east).cross(toRenderPosition(down));
    expect(mapped.distanceTo(renderedCross)).toBeCloseTo(0, 12);
  });

  it("keeps an asymmetric circling trajectory turning the same way", () => {
    // A vehicle circling clockwise viewed from above (positive NED yaw)
    // must still circle clockwise in render space: East maps to render +z
    // while up stays render +y.
    const points = [];
    for (let step = 0; step <= 12; step += 1) {
      const angle = (step / 12) * Math.PI / 2;
      points.push(toRenderPosition({ x: Math.cos(angle), y: Math.sin(angle), z: 0 }));
    }
    // Signed area of the quarter arc polygon (shoelace over x/z render plane).
    let signedArea = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      signedArea +=
        points[index].x * points[index + 1].z -
        points[index + 1].x * points[index].z;
    }
    // NED quarter turn north->east is clockwise from above; in render space
    // (x north, z east, y up) the same path has positive shoelace sign.
    expect(signedArea).toBeGreaterThan(0);
  });

  it("converts orientation so body +X stays forward with correct yaw", () => {
    const heading = Math.PI / 3;
    const renderQuaternion = toRenderQuaternion(quaternionFromEuler(heading, 0, 0));
    const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(renderQuaternion);
    expect(forward.x).toBeCloseTo(Math.cos(heading), 12);
    expect(forward.z).toBeCloseTo(Math.sin(heading), 12);
    expect(forward.y).toBeCloseTo(0, 12);
  });

  it("converts orientation so positive pitch raises the nose in render space", () => {
    const renderQuaternion = toRenderQuaternion(quaternionFromEuler(0, 0.35, 0));
    const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(renderQuaternion);
    expect(forward.y).toBeCloseTo(Math.sin(0.35), 12);
  });

  it("converts orientation so positive roll drops starboard in render space", () => {
    const renderQuaternion = toRenderQuaternion(quaternionFromEuler(0, 0, 0.5));
    const starboard = new THREE.Vector3(0, 0, 1).applyQuaternion(renderQuaternion);
    expect(starboard.y).toBeCloseTo(-Math.sin(0.5), 12);
  });

  it("places horizontal pairs at the given render height", () => {
    const point = toRenderHorizontal({ x: 10, y: -4 }, -120);
    expect(point.toArray()).toEqual([10, -120, -4]);
  });
});

describe("3D trail buffer", () => {
  it("preserves vertical separation across its history", () => {
    const trail = new Trail({ color: 0xffffff, limit: 16 });
    for (let index = 0; index < 10; index += 1) {
      trail.push(index * 10, -index * 20, 0);
    }
    expect(trail.length).toBe(10);
    const first = trail.pointAt(0);
    expect(first?.x).toBeCloseTo(0, 12);
    expect(first?.y).toBeCloseTo(0, 12);
    expect(first?.z).toBeCloseTo(0, 12);
    expect(trail.pointAt(9)?.y).toBeCloseTo(-180, 12);
  });

  it("caps the retained history at the configured limit", () => {
    const trail = new Trail({ color: 0xffffff, limit: 8 });
    for (let index = 0; index < 30; index += 1) {
      trail.push(index * 10, 0, 0);
    }
    expect(trail.length).toBe(8);
    // Oldest points fall off the front.
    expect(trail.pointAt(0)?.x).toBeCloseTo(220, 10);
    expect(trail.pointAt(7)?.x).toBeCloseTo(290, 10);
  });

  it("supports reconfiguring the limit while retaining recent points", () => {
    const trail = new Trail({ color: 0xffffff, limit: 10 });
    for (let index = 0; index < 10; index += 1) {
      trail.push(index * 10, -index, index);
    }
    trail.setLimit(4);
    expect(trail.length).toBe(4);
    expect(trail.pointAt(0)?.x).toBeCloseTo(60, 10);
    trail.setLimit(6);
    expect(trail.limit).toBe(6);
    trail.push(999, -999, 999);
    expect(trail.pointAt(trail.length - 1)).toEqual({ x: 999, y: -999, z: 999 });
  });

  it("clears without retaining state", () => {
    const trail = new Trail({ color: 0xffffff, limit: 4 });
    trail.push(0, 0, 0);
    trail.push(10, 0, 0);
    trail.clear();
    expect(trail.length).toBe(0);
    expect(trail.pointAt(0)).toBeNull();
  });
});
