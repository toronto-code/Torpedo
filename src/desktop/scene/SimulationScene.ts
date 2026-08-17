import * as THREE from "three";

import { clamp, wrapAngle } from "../../sim/math";
import type { RenderSnapshot, Vec3, VehicleState } from "../../sim/types";

export type CameraMode = "tactical" | "chase" | "seeker";

export interface SceneOptions {
  cameraMode: CameraMode;
  showTruth: boolean;
  showDiagnostics: boolean;
  fovHalfAngle: number;
}

const SNAPSHOT_INTERVAL_MS = 20;
const TRAIL_LIMIT = 2_000;

function position(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}

function interpolateAngle(from: number, to: number, alpha: number): number {
  return from + wrapAngle(to - from) * alpha;
}

function interpolateVehicle(
  from: VehicleState,
  to: VehicleState,
  alpha: number,
): { position: THREE.Vector3; heading: number; orientation: THREE.Quaternion } {
  const start = new THREE.Quaternion(
    from.orientation.x,
    from.orientation.y,
    from.orientation.z,
    from.orientation.w,
  );
  const end = new THREE.Quaternion(
    to.orientation.x,
    to.orientation.y,
    to.orientation.z,
    to.orientation.w,
  );
  return {
    position: position(from.position).lerp(position(to.position), alpha),
    heading: interpolateAngle(from.heading, to.heading, alpha),
    orientation: start.slerp(end, alpha),
  };
}

class Trail {
  readonly line: THREE.Line;
  private readonly points: THREE.Vector3[] = [];

  constructor(color: number, opacity = 0.9) {
    this.line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
      }),
    );
    this.line.frustumCulled = false;
  }

  push(next: THREE.Vector3): void {
    const previous = this.points.at(-1);
    if (previous && previous.distanceToSquared(next) < 0.16) return;
    this.points.push(next.clone());
    if (this.points.length > TRAIL_LIMIT) this.points.shift();
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(this.points);
  }

  clear(): void {
    this.points.length = 0;
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry();
  }

  dispose(): void {
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}

function createVehicle(color: number, target = false): THREE.Group {
  const group = new THREE.Group();
  if (target) {
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(58, 10, 15),
      new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.2 }),
    );
    hull.position.y = 2;
    const bow = new THREE.Mesh(
      new THREE.ConeGeometry(10.5, 20, 4),
      new THREE.MeshStandardMaterial({ color, roughness: 0.42 }),
    );
    bow.rotation.z = -Math.PI / 2;
    bow.rotation.y = Math.PI / 4;
    bow.position.x = 38;
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(20, 7, 9),
      new THREE.MeshStandardMaterial({ color: 0xa9bbc0, roughness: 0.6 }),
    );
    deck.position.set(-4, 10, 0);
    group.add(hull, bow, deck);
  } else {
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(3.1, 3.1, 24, 18),
      new THREE.MeshStandardMaterial({ color, roughness: 0.26, metalness: 0.58 }),
    );
    body.rotation.z = Math.PI / 2;
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(3.1, 8, 18),
      new THREE.MeshStandardMaterial({ color: 0xd5e3df, metalness: 0.52 }),
    );
    nose.rotation.z = -Math.PI / 2;
    nose.position.x = 16;
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(5, 12, 0.8),
      new THREE.MeshStandardMaterial({ color: 0x718985, metalness: 0.4 }),
    );
    tail.position.x = -11;
    group.add(body, nose, tail);
  }
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return group;
}

function createSeekerSector(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial({
    color: 0x8ba4b0,
    transparent: true,
    opacity: 0.08,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geometry, material);
}

function updateSeekerSector(mesh: THREE.Mesh, halfAngle: number): void {
  const segments = 32;
  const radius = 620;
  const vertices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const a = -halfAngle + (index / segments) * halfAngle * 2;
    const b = -halfAngle + ((index + 1) / segments) * halfAngle * 2;
    vertices.push(
      0, 0, 0,
      Math.cos(a) * radius, 0, Math.sin(a) * radius,
      Math.cos(b) * radius, 0, Math.sin(b) * radius,
    );
  }
  mesh.geometry.dispose();
  mesh.geometry = new THREE.BufferGeometry();
  mesh.geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
}

function createMarker(color: number, radius: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 14, 10),
    new THREE.MeshBasicMaterial({ color, depthTest: false }),
  );
}

function createReferencePlane(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(12_000, 12_000);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color: 0x15191b, depthWrite: false });
  return new THREE.Mesh(geometry, material);
}

export class SimulationScene {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly perspective = new THREE.PerspectiveCamera(52, 1, 0.5, 20_000);
  private readonly tactical = new THREE.OrthographicCamera(-1000, 1000, 700, -700, 1, 20_000);
  private readonly torpedo = createVehicle(0x7cf7df);
  private readonly target = createVehicle(0xe7b97c, true);
  private readonly estimate = createMarker(0x53b8ff, 8);
  private readonly observation = createMarker(0xffd166, 5);
  private readonly seeker = createSeekerSector();
  private readonly covariance = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x53b8ff, transparent: true, opacity: 0.85 }),
  );
  private readonly cpaLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({ color: 0xff7d68, dashSize: 15, gapSize: 8, opacity: 0.75, transparent: true }),
  );
  private readonly observerVelocity = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(),
    1,
    0x8fb6a0,
    10,
    5,
  );
  private readonly trackVelocity = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(),
    1,
    0x76a9c5,
    10,
    5,
  );
  private readonly referencePlane = createReferencePlane();
  private readonly torpedoTrail = new Trail(0x7cf7df);
  private readonly targetTrail = new Trail(0xe7b97c, 0.7);
  private readonly estimateTrail = new Trail(0x53b8ff, 0.7);
  private readonly resizeObserver: ResizeObserver;
  private animationFrame = 0;
  private previous: RenderSnapshot | null = null;
  private current: RenderSnapshot | null = null;
  private arrivedAt = performance.now();
  private lastSequence = -1;
  private options: SceneOptions;

  constructor(private readonly host: HTMLElement, options: SceneOptions) {
    this.options = options;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(host.clientWidth, host.clientHeight, false);
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute("aria-label", "Three-dimensional simulation view");
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x111415);
    const ambient = new THREE.HemisphereLight(0xc6cccf, 0x151719, 1.15);
    const sun = new THREE.DirectionalLight(0xd9dddf, 1.35);
    sun.position.set(-800, 1400, 500);
    this.scene.add(ambient, sun, this.referencePlane);

    const grid = new THREE.GridHelper(12_000, 120, 0x4d5559, 0x2b3033);
    grid.position.y = -0.3;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.68;
    const axes = new THREE.AxesHelper(240);
    this.scene.add(
      grid,
      axes,
      this.torpedo,
      this.target,
      this.estimate,
      this.observation,
      this.seeker,
      this.covariance,
      this.cpaLine,
      this.observerVelocity,
      this.trackVelocity,
      this.torpedoTrail.line,
      this.targetTrail.line,
      this.estimateTrail.line,
    );
    this.estimate.visible = false;
    this.observation.visible = false;
    this.target.visible = options.showTruth;
    updateSeekerSector(this.seeker, options.fovHalfAngle);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.animate = this.animate.bind(this);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  setOptions(options: SceneOptions): void {
    if (options.fovHalfAngle !== this.options.fovHalfAngle) {
      updateSeekerSector(this.seeker, options.fovHalfAngle);
    }
    this.options = options;
  }

  setSnapshot(snapshot: RenderSnapshot | null, immediate = false): void {
    if (!snapshot) {
      this.previous = null;
      this.current = null;
      this.lastSequence = -1;
      this.torpedoTrail.clear();
      this.targetTrail.clear();
      this.estimateTrail.clear();
      return;
    }
    if (snapshot.sequence === this.lastSequence) return;
    if (snapshot.sequence < this.lastSequence) {
      this.torpedoTrail.clear();
      this.targetTrail.clear();
      this.estimateTrail.clear();
    }
    this.previous = immediate ? snapshot : (this.current ?? snapshot);
    this.current = snapshot;
    this.arrivedAt = performance.now();
    this.lastSequence = snapshot.sequence;
    this.torpedoTrail.push(position(snapshot.torpedo.position));
    this.targetTrail.push(position(snapshot.target.position));
    if (snapshot.estimate) {
      this.estimateTrail.push(
        new THREE.Vector3(snapshot.estimate.position.x, snapshot.target.position.y, snapshot.estimate.position.z),
      );
    }
  }

  setReplayHistory(snapshots: readonly RenderSnapshot[]): void {
    this.torpedoTrail.clear();
    this.targetTrail.clear();
    this.estimateTrail.clear();
    for (const snapshot of snapshots) {
      this.torpedoTrail.push(position(snapshot.torpedo.position));
      this.targetTrail.push(position(snapshot.target.position));
      if (snapshot.estimate) {
        this.estimateTrail.push(
          new THREE.Vector3(
            snapshot.estimate.position.x,
            snapshot.target.position.y,
            snapshot.estimate.position.z,
          ),
        );
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.torpedoTrail.dispose();
    this.targetTrail.dispose();
    this.estimateTrail.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments) {
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material?.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    const aspect = width / height;
    this.tactical.left = -1000 * aspect;
    this.tactical.right = 1000 * aspect;
    this.tactical.top = 1000;
    this.tactical.bottom = -1000;
    this.tactical.updateProjectionMatrix();
  }

  private updateCovariance(snapshot: RenderSnapshot): void {
    const estimate = snapshot.estimate;
    if (!estimate) {
      this.covariance.visible = false;
      return;
    }
    const a = Math.max(0, estimate.covariance[0]?.[0] ?? 0);
    const b = estimate.covariance[0]?.[1] ?? 0;
    const d = Math.max(0, estimate.covariance[1]?.[1] ?? 0);
    const trace = a + d;
    const difference = a - d;
    const root = Math.sqrt(Math.max(0, difference * difference + 4 * b * b));
    const major = Math.sqrt(Math.max(0.01, (trace + root) * 0.5) * 5.991);
    const minor = Math.sqrt(Math.max(0.01, (trace - root) * 0.5) * 5.991);
    const theta = 0.5 * Math.atan2(2 * b, difference);
    const center = new THREE.Vector3(estimate.position.x, snapshot.target.position.y + 0.8, estimate.position.z);
    const points = Array.from({ length: 72 }, (_, index) => {
      const angle = (index / 72) * Math.PI * 2;
      const x = Math.cos(angle) * Math.min(major, 1_500);
      const z = Math.sin(angle) * Math.min(minor, 1_500);
      return new THREE.Vector3(
        center.x + x * Math.cos(theta) - z * Math.sin(theta),
        center.y,
        center.z + x * Math.sin(theta) + z * Math.cos(theta),
      );
    });
    this.covariance.geometry.dispose();
    this.covariance.geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.covariance.visible = true;
  }

  private updateDiagnostics(snapshot: RenderSnapshot): void {
    const time = snapshot.metrics.predictedTimeToCpa;
    const ownFuture = position(snapshot.torpedo.position).addScaledVector(position(snapshot.torpedo.velocity), time);
    const trackPosition = snapshot.estimate
      ? new THREE.Vector3(snapshot.estimate.position.x, snapshot.target.position.y, snapshot.estimate.position.z)
      : position(snapshot.target.position);
    const trackVelocity = snapshot.estimate
      ? new THREE.Vector3(snapshot.estimate.velocity.x, 0, snapshot.estimate.velocity.z)
      : position(snapshot.target.velocity);
    const targetFuture = trackPosition.clone().addScaledVector(trackVelocity, time);
    this.cpaLine.geometry.dispose();
    this.cpaLine.geometry = new THREE.BufferGeometry().setFromPoints([ownFuture, targetFuture]);
    this.cpaLine.computeLineDistances();

    const vectorScale = 8;
    const observerVelocity = position(snapshot.torpedo.velocity);
    const observerLength = Math.max(0.01, observerVelocity.length() * vectorScale);
    const trackLength = Math.max(0.01, trackVelocity.length() * vectorScale);
    this.observerVelocity.position.copy(position(snapshot.torpedo.position));
    this.observerVelocity.setDirection(observerVelocity.normalize());
    this.observerVelocity.setLength(observerLength, Math.min(18, observerLength * 0.18), Math.min(8, observerLength * 0.08));
    this.trackVelocity.position.copy(trackPosition);
    this.trackVelocity.setDirection(trackVelocity.normalize());
    this.trackVelocity.setLength(trackLength, Math.min(18, trackLength * 0.18), Math.min(8, trackLength * 0.08));
    this.cpaLine.visible = this.options.showDiagnostics;
    this.observerVelocity.visible = this.options.showDiagnostics;
    this.trackVelocity.visible = this.options.showDiagnostics;
  }

  private updateCamera(
    snapshot: RenderSnapshot,
    ownPosition: THREE.Vector3,
    targetPosition: THREE.Vector3,
    orientation: THREE.Quaternion,
  ): THREE.Camera {
    const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(orientation).normalize();
    if (this.options.cameraMode === "tactical") {
      const center = ownPosition.clone().lerp(targetPosition, 0.5);
      const separation = Math.max(700, ownPosition.distanceTo(targetPosition) * 0.72);
      const aspect = Math.max(0.5, this.host.clientWidth / Math.max(1, this.host.clientHeight));
      this.tactical.left = -separation * aspect;
      this.tactical.right = separation * aspect;
      this.tactical.top = separation;
      this.tactical.bottom = -separation;
      this.tactical.position.set(center.x, Math.max(1200, separation * 1.9), center.z);
      this.tactical.up.set(0, 0, -1);
      this.tactical.lookAt(center);
      this.tactical.updateProjectionMatrix();
      return this.tactical;
    }
    if (this.options.cameraMode === "seeker") {
      this.perspective.position.copy(ownPosition).addScaledVector(forward, 18).add(new THREE.Vector3(0, 1.4, 0));
      this.perspective.up.set(0, 1, 0);
      this.perspective.lookAt(this.perspective.position.clone().addScaledVector(forward, 800));
      this.target.visible = snapshot.seekerStatus === "locked" || this.options.showTruth;
      return this.perspective;
    }
    this.perspective.position.copy(ownPosition).addScaledVector(forward, -85).add(new THREE.Vector3(0, 36, 0));
    this.perspective.up.set(0, 1, 0);
    this.perspective.lookAt(ownPosition.clone().addScaledVector(forward, 110));
    return this.perspective;
  }

  private animate(now: number): void {
    this.animationFrame = requestAnimationFrame(this.animate);
    if (!this.current || !this.previous) {
      this.renderer.render(this.scene, this.perspective);
      return;
    }
    const alpha = clamp((now - this.arrivedAt) / SNAPSHOT_INTERVAL_MS, 0, 1);
    const own = interpolateVehicle(this.previous.torpedo, this.current.torpedo, alpha);
    const contact = interpolateVehicle(this.previous.target, this.current.target, alpha);
    this.torpedo.position.copy(own.position);
    this.torpedo.quaternion.copy(own.orientation);
    this.target.position.copy(contact.position);
    this.target.quaternion.copy(contact.orientation);
    this.target.visible = this.options.showTruth;
    this.seeker.position.copy(own.position);
    this.seeker.position.y += 0.2;
    this.seeker.rotation.y = -own.heading;

    const estimate = this.current.estimate;
    this.estimate.visible = Boolean(estimate);
    if (estimate) this.estimate.position.set(estimate.position.x, contact.position.y, estimate.position.z);
    const observation = this.current.observation;
    this.observation.visible = Boolean(observation);
    if (observation) {
      const bearing = observation.sensorHeading + observation.bearing;
      this.observation.position.set(
        observation.sensorPosition.x + Math.cos(bearing) * observation.range,
        contact.position.y,
        observation.sensorPosition.z + Math.sin(bearing) * observation.range,
      );
    }

    this.targetTrail.line.visible = this.options.showTruth;
    this.estimateTrail.line.visible = true;
    this.observation.visible = this.observation.visible && this.options.showDiagnostics;
    this.updateCovariance(this.current);
    this.updateDiagnostics(this.current);
    const camera = this.updateCamera(this.current, own.position, contact.position, own.orientation);
    this.renderer.render(this.scene, camera);
  }
}
