import * as THREE from "three";

export interface TrailOptions {
  color: number;
  opacity?: number;
  /** Maximum retained points. Configurable; defaults to 2,000. */
  limit?: number;
}

/**
 * Bounded 3D trail backed by one preallocated Float32Array. Points are full
 * X/Y/Z render-space samples; vertical motion is preserved exactly. Once the
 * cap is reached the buffer shifts by one point in place, so steady-state
 * pushes never allocate.
 */
export class Trail {
  readonly line: THREE.Line;
  private attribute: THREE.BufferAttribute;
  private capacity: number;
  private count = 0;
  private hasLast = false;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private static readonly MIN_SQUARED_DISTANCE = 0.16;

  constructor(options: TrailOptions) {
    this.capacity = Math.max(2, Math.floor(options.limit ?? 2_000));
    this.line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: options.color,
        transparent: true,
        opacity: options.opacity ?? 0.9,
        depthWrite: false,
      }),
    );
    this.line.frustumCulled = false;
    this.attribute = this.createAttribute(this.capacity);
    this.attachAttribute(this.attribute);
  }

  get length(): number {
    return this.count;
  }

  get limit(): number {
    return this.capacity;
  }

  setLimit(limit: number): void {
    const next = Math.max(2, Math.floor(limit));
    if (next === this.capacity) return;
    const keep = Math.min(this.count, next);
    const attribute = this.createAttribute(next);
    if (keep > 0) {
      // Retain the most recent points when shrinking.
      const offset = (this.count - keep) * 3;
      (attribute.array as Float32Array).set(
        (this.attribute.array as Float32Array).subarray(offset, offset + keep * 3),
      );
    }
    this.capacity = next;
    this.count = keep;
    this.attribute = attribute;
    this.attachAttribute(attribute);
  }

  push(x: number, y: number, z: number): void {
    if (this.hasLast) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      const dz = z - this.lastZ;
      if (dx * dx + dy * dy + dz * dz < Trail.MIN_SQUARED_DISTANCE) return;
    }
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    this.hasLast = true;
    if (this.count === this.capacity) {
      (this.attribute.array as Float32Array).copyWithin(0, 3, this.count * 3);
      this.count -= 1;
    }
    const buffer = this.attribute.array as Float32Array;
    buffer[this.count * 3] = x;
    buffer[this.count * 3 + 1] = y;
    buffer[this.count * 3 + 2] = z;
    this.count += 1;
    this.attribute.needsUpdate = true;
    this.line.geometry.setDrawRange(0, this.count);
  }

  pointAt(index: number): { x: number; y: number; z: number } | null {
    if (index < 0 || index >= this.count) return null;
    const buffer = this.attribute.array as Float32Array;
    return {
      x: buffer[index * 3],
      y: buffer[index * 3 + 1],
      z: buffer[index * 3 + 2],
    };
  }

  clear(): void {
    this.count = 0;
    this.hasLast = false;
    this.line.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
  }

  private createAttribute(capacity: number): THREE.BufferAttribute {
    const attribute = new THREE.BufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    attribute.setUsage(THREE.DynamicDrawUsage);
    return attribute;
  }

  private attachAttribute(attribute: THREE.BufferAttribute): void {
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry();
    this.line.geometry.setAttribute("position", attribute);
    this.line.geometry.setDrawRange(0, this.count);
  }
}
