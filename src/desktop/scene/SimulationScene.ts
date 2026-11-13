import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { clamp, wrapAngle } from "../../sim/math";
import type { RenderSnapshot, VehicleState } from "../../sim/types";
import {
  toRenderHorizontalInto,
  toRenderPositionInto,
  toRenderQuaternionInto,
} from "./coordinates";
import { Trail } from "./trail";

export type CameraMode = "orbit" | "chase" | "tactical" | "seeker";

export interface SceneOptions {
  cameraMode: CameraMode;
  showTruth: boolean;
  showDiagnostics: boolean;
  fovHalfAngle: number;
  /** Water column depth in metres used for the seabed plane. Default 500. */
  waterDepth?: number;
  /** Maximum points retained per trail. Default 2,000. */
  trailLimit?: number;
}

const SNAPSHOT_INTERVAL_MS = 20;
const DEFAULT_WATER_DEPTH = 500;
const DEFAULT_TRAIL_LIMIT = 2_000;
const WORLD_EXTENT = 12_000;

const scratchFromPosition = new THREE.Vector3();
const scratchToPosition = new THREE.Vector3();
const scratchFromQuaternion = new THREE.Quaternion();
const scratchToQuaternion = new THREE.Quaternion();
const scratchForward = new THREE.Vector3();
const scratchCenter = new THREE.Vector3();
const scratchDesired = new THREE.Vector3();

function interpolateAngle(from: number, to: number, alpha: number): number {
  return from + wrapAngle(to - from) * alpha;
}

interface InterpolatedVehicle {
  position: THREE.Vector3;
  heading: number;
  orientation: THREE.Quaternion;
}

const ownInterpolated: InterpolatedVehicle = {
  position: new THREE.Vector3(),
  heading: 0,
  orientation: new THREE.Quaternion(),
};

const contactInterpolated: InterpolatedVehicle = {
  position: new THREE.Vector3(),
  heading: 0,
  orientation: new THREE.Quaternion(),
};

function interpolateVehicleInto(
  from: VehicleState,
  to: VehicleState,
  alpha: number,
  result: InterpolatedVehicle,
): InterpolatedVehicle {
  toRenderQuaternionInto(from.orientation, scratchFromQuaternion);
  toRenderQuaternionInto(to.orientation, scratchToQuaternion);
  toRenderPositionInto(from.position, scratchFromPosition);
  toRenderPositionInto(to.position, scratchToPosition);
  result.position.copy(scratchFromPosition).lerp(scratchToPosition, alpha);
  result.heading = interpolateAngle(from.heading, to.heading, alpha);
  result.orientation.copy(scratchFromQuaternion).slerp(scratchToQuaternion, alpha);
  return result;
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

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (
      child instanceof THREE.Mesh ||
      child instanceof THREE.Line ||
      child instanceof THREE.LineSegments ||
      child instanceof THREE.Sprite
    ) {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        // The HUD diamond texture is shared module-wide and must survive a
        // scene teardown (hot reload, panel remount).
        if (material instanceof THREE.SpriteMaterial && material.map === diamondTexture) {
          material.dispose();
          continue;
        }
        if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
        material?.dispose();
      }
    }
  });
}

const CONTACT_COLORS: Record<string, number> = {
  "hostile-sub": 0xe7b97c,
  "friendly-sub": 0x7cd67c,
  "commercial-surface": 0xc9c9c9,
  biological: 0x7cb8d4,
  decoy: 0xff5c5c,
  knuckle: 0xd7e4ea,
  ambiguous: 0xd4a7dd,
};

let diamondTexture: THREE.CanvasTexture | null = null;

/** HUD diamond shared by every contact marker; tinted per material. */
function getDiamondTexture(): THREE.CanvasTexture {
  if (diamondTexture) return diamondTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.translate(32, 32);
  context.rotate(Math.PI / 4);
  context.fillStyle = "#ffffff";
  context.fillRect(-17, -17, 34, 34);
  context.lineWidth = 5;
  context.strokeStyle = "#10181c";
  context.strokeRect(-17, -17, 34, 34);
  diamondTexture = new THREE.CanvasTexture(canvas);
  diamondTexture.colorSpace = THREE.SRGBColorSpace;
  return diamondTexture;
}

function createLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.font = "600 34px ui-monospace, Menlo, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#dfe6e9";
  context.shadowColor = "rgba(0, 0, 0, 0.9)";
  context.shadowBlur = 6;
  context.fillText(text.toUpperCase(), canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }),
  );
  // Float the label above its anchor point, clear of the marker diamond.
  sprite.center.set(0.5, -1.1);
  sprite.renderOrder = 997;
  return sprite;
}

function createMarkerSprite(color: number): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: getDiamondTexture(),
      color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }),
  );
  sprite.renderOrder = 999;
  return sprite;
}

interface ContactVisual {
  group: THREE.Group;
  marker: THREE.Sprite;
  label: THREE.Sprite;
  trail: Trail;
}

/**
 * Stable per-contact truth visuals (rendering/scoring surface only — the
 * guidance chain never sees them). One mesh per contact id, so a mesh is
 * never reassigned between different physical contacts. Each contact also
 * gets a fixed-screen-size HUD diamond, a name label, and a truth trail so
 * the tactical picture stays readable at multi-kilometre camera ranges.
 */
class ContactMeshPool {
  private readonly visuals = new Map<string, ContactVisual>();

  constructor(private readonly scene: THREE.Scene) {}

  private createVisual(id: string, kind: string): ContactVisual {
    const color = CONTACT_COLORS[kind] ?? 0xa0a0a0;
    const group = new THREE.Group();
    let geometry: THREE.BufferGeometry;
    if (kind === "commercial-surface") {
      geometry = new THREE.BoxGeometry(70, 12, 18);
    } else if (kind === "biological") {
      geometry = new THREE.SphereGeometry(7, 12, 8);
    } else if (kind === "decoy") {
      geometry = new THREE.SphereGeometry(4, 10, 8);
    } else if (kind === "knuckle") {
      geometry = new THREE.SphereGeometry(9, 12, 8);
    } else {
      geometry = new THREE.CapsuleGeometry(4, 26, 6, 10);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 }),
      );
      mesh.rotation.z = Math.PI / 2;
      group.add(mesh);
      const visual: ContactVisual = {
        group,
        marker: createMarkerSprite(color),
        label: createLabelSprite(id),
        trail: new Trail({ color, opacity: 0.5, limit: 1_200 }),
      };
      this.scene.add(group, visual.marker, visual.label, visual.trail.line);
      return visual;
    }
    group.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 }),
      ),
    );
    const visual: ContactVisual = {
      group,
      marker: createMarkerSprite(color),
      label: createLabelSprite(id),
      trail: new Trail({ color, opacity: 0.5, limit: 1_200 }),
    };
    this.scene.add(group, visual.marker, visual.label, visual.trail.line);
    return visual;
  }

  update(
    contacts: readonly {
      id: string;
      kind: string;
      active: boolean;
      position: { x: number; y: number; z: number };
      heading: number;
    }[],
    visible: boolean,
    scratch: THREE.Vector3,
    camera: THREE.Camera,
  ): void {
    const seen = new Set<string>();
    const orthographic = camera instanceof THREE.OrthographicCamera;
    const fovRadians = ((camera as THREE.PerspectiveCamera).fov ?? 50) * (Math.PI / 180);
    const orthoHeight = orthographic
      ? ((camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom)
      : 0;
    for (const contact of contacts) {
      seen.add(contact.id);
      let visual = this.visuals.get(contact.id);
      if (!visual) {
        visual = this.createVisual(contact.id, contact.kind);
        this.visuals.set(contact.id, visual);
      }
      const shown = visible && contact.active;
      visual.group.visible = shown;
      visual.marker.visible = shown;
      visual.label.visible = shown;
      visual.trail.line.visible = visible;
      if (!shown) continue;
      toRenderPositionInto(contact.position as never, scratch);
      visual.group.position.copy(scratch);
      visual.marker.position.copy(scratch);
      visual.label.position.copy(scratch);
      if (contact.kind !== "biological" && contact.kind !== "decoy") {
        visual.group.rotation.set(0, -contact.heading, 0);
      }
      // Fixed screen footprint: scale the HUD sprites by the world height
      // visible at the contact's distance, so diamonds stay ~constant pixels
      // whether the camera is 200 m or 12 km away.
      const worldHeight = orthographic
        ? Math.max(1, orthoHeight)
        : Math.max(
            1,
            2 * camera.position.distanceTo(scratch) * Math.tan(fovRadians / 2),
          );
      const markerSize = worldHeight * 0.03;
      visual.marker.scale.set(markerSize, markerSize, 1);
      const labelWidth = worldHeight * 0.12;
      visual.label.scale.set(labelWidth, labelWidth * 0.25, 1);
    }
    for (const [id, visual] of this.visuals) {
      if (!seen.has(id)) {
        visual.group.visible = false;
        visual.marker.visible = false;
        visual.label.visible = false;
        visual.trail.line.visible = false;
      }
    }
  }

  /** Pushes one truth sample per new snapshot; call with the latest frame. */
  pushTrailPoints(
    contacts: readonly {
      id: string;
      active: boolean;
      position: { x: number; y: number; z: number };
    }[],
    scratch: THREE.Vector3,
  ): void {
    for (const contact of contacts) {
      if (!contact.active) continue;
      const visual = this.visuals.get(contact.id);
      if (!visual) continue;
      toRenderPositionInto(contact.position as never, scratch);
      visual.trail.push(scratch.x, scratch.y, scratch.z);
    }
  }

  clearTrails(): void {
    for (const visual of this.visuals.values()) visual.trail.clear();
  }

  dispose(): void {
    for (const visual of this.visuals.values()) {
      disposeObject(visual.group);
      visual.marker.material.dispose();
      const labelMaterial = visual.label.material;
      labelMaterial.map?.dispose();
      labelMaterial.dispose();
      visual.trail.dispose();
      this.scene.remove(
        visual.group,
        visual.marker,
        visual.label,
        visual.trail.line,
      );
    }
    this.visuals.clear();
  }
}

function createDepthLabel(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgba(10, 26, 32, 0.0)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "600 52px ui-monospace, monospace";
  context.fillStyle = "#8fb3bd";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(110, 41, 1);
  return sprite;
}

/**
 * Lightweight 3D environment: a translucent water surface at zero depth, a
 * seabed at the configured water depth, and a vertical depth ruler with
 * ticks and metre labels at the origin. Exponential fog provides depth
 * perspective without any per-frame simulation cost.
 */
function buildEnvironment(waterDepth: number): THREE.Group {
  const group = new THREE.Group();
  const seabedY = -Math.max(50, waterDepth);

  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_EXTENT, WORLD_EXTENT),
    new THREE.MeshStandardMaterial({
      color: 0x1c4a5c,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
      roughness: 0.9,
    }),
  );
  surface.rotation.x = -Math.PI / 2;
  group.add(surface);

  const surfaceGrid = new THREE.GridHelper(WORLD_EXTENT, 120, 0x5d8496, 0x24404e);
  surfaceGrid.position.y = 0.6;
  (surfaceGrid.material as THREE.Material).transparent = true;
  (surfaceGrid.material as THREE.Material).opacity = 0.5;
  group.add(surfaceGrid);

  const seabed = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_EXTENT, WORLD_EXTENT),
    new THREE.MeshStandardMaterial({ color: 0x2f2a21, roughness: 1 }),
  );
  seabed.rotation.x = -Math.PI / 2;
  seabed.position.y = seabedY;
  group.add(seabed);

  const seabedGrid = new THREE.GridHelper(WORLD_EXTENT, 60, 0x4a4234, 0x27231d);
  seabedGrid.position.y = seabedY + 0.6;
  (seabedGrid.material as THREE.Material).transparent = true;
  (seabedGrid.material as THREE.Material).opacity = 0.4;
  group.add(seabedGrid);

  const rulerVertices: number[] = [];
  const tickSpacing = 25;
  for (let depth = 0; depth <= -seabedY; depth += tickSpacing) {
    const major = depth % 100 === 0;
    const length = major ? 70 : 28;
    const y = -depth;
    rulerVertices.push(0, y, 0, length, y, 0);
    if (major && depth > 0) {
      const label = createDepthLabel(`−${depth} m`);
      label.position.set(length + 70, y, 0);
      group.add(label);
    }
  }
  const ruler = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(rulerVertices, 3),
    ),
    new THREE.LineBasicMaterial({ color: 0x6c8189, transparent: true, opacity: 0.85 }),
  );
  group.add(ruler);
  return group;
}

export class SimulationScene {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly perspective = new THREE.PerspectiveCamera(52, 1, 0.5, 40_000);
  private readonly tactical = new THREE.OrthographicCamera(-1000, 1000, 700, -700, 1, 40_000);
  private readonly orbitCamera = new THREE.PerspectiveCamera(52, 1, 2, 40_000);
  private readonly orbitControls: OrbitControls;
  private readonly torpedo = createVehicle(0x7cf7df);
  private readonly target = createVehicle(0xe7b97c, true);
  private readonly estimate = createMarker(0x53b8ff, 8);
  private readonly observation = createMarker(0xffd166, 5);
  private readonly enablePoint = createMarker(0x9bd4a8, 6);
  private readonly interceptPoint = createMarker(0xc79bd4, 6);
  private readonly seeker = createSeekerSector();
  private readonly covariance = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x53b8ff, transparent: true, opacity: 0.85 }),
  );
  private readonly covariancePoints = new Float32Array(72 * 3);
  private readonly cpaLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({ color: 0xff7d68, dashSize: 15, gapSize: 8, opacity: 0.75, transparent: true }),
  );
  private readonly cpaPoints = new Float32Array(6);
  private readonly cpaDistances = new Float32Array(2);
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
  private environment: THREE.Group;
  private readonly contactMeshes: ContactMeshPool;
  private readonly torpedoMarker: THREE.Sprite;
  private readonly torpedoTrail: Trail;
  private readonly targetTrail: Trail;
  private readonly estimateTrail: Trail;
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

    this.scene.background = new THREE.Color(0x0d1418);
    this.scene.fog = new THREE.FogExp2(0x0e1c24, 0.00004);
    const ambient = new THREE.HemisphereLight(0xc6cccf, 0x1a2a33, 1.2);
    const sun = new THREE.DirectionalLight(0xd9dddf, 1.35);
    sun.position.set(-800, 1400, 500);
    this.environment = buildEnvironment(options.waterDepth ?? DEFAULT_WATER_DEPTH);
    this.contactMeshes = new ContactMeshPool(this.scene);

    this.torpedoTrail = new Trail({ color: 0x7cf7df, limit: options.trailLimit ?? DEFAULT_TRAIL_LIMIT });
    this.targetTrail = new Trail({ color: 0xe7b97c, opacity: 0.7, limit: options.trailLimit ?? DEFAULT_TRAIL_LIMIT });
    this.estimateTrail = new Trail({ color: 0x53b8ff, opacity: 0.7, limit: options.trailLimit ?? DEFAULT_TRAIL_LIMIT });

    const covarianceAttribute = new THREE.BufferAttribute(this.covariancePoints, 3);
    covarianceAttribute.setUsage(THREE.DynamicDrawUsage);
    this.covariance.geometry.setAttribute("position", covarianceAttribute);

    const cpaAttribute = new THREE.BufferAttribute(this.cpaPoints, 3);
    cpaAttribute.setUsage(THREE.DynamicDrawUsage);
    this.cpaLine.geometry.setAttribute("position", cpaAttribute);
    const cpaDistanceAttribute = new THREE.BufferAttribute(this.cpaDistances, 1);
    cpaDistanceAttribute.setUsage(THREE.DynamicDrawUsage);
    this.cpaLine.geometry.setAttribute("lineDistance", cpaDistanceAttribute);

    const axes = new THREE.AxesHelper(240);
    this.scene.add(
      ambient,
      sun,
      this.environment,
      axes,
      this.torpedo,
      this.target,
      this.estimate,
      this.observation,
      this.enablePoint,
      this.interceptPoint,
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
    this.enablePoint.visible = false;
    this.interceptPoint.visible = false;
    this.target.visible = options.showTruth;
    updateSeekerSector(this.seeker, options.fovHalfAngle);

    this.orbitControls = new OrbitControls(this.orbitCamera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.minDistance = 50;
    this.orbitControls.maxDistance = 18_000;
    this.orbitControls.maxPolarAngle = Math.PI - 0.02;
    this.orbitControls.enabled = false;
    this.orbitCamera.position.set(-900, 700, -900);
    this.orbitControls.target.set(0, -40, 0);
    // The shared perspective camera also starts on the environment so the
    // frames before the first snapshot show the water column instead of a
    // void from inside the origin.
    this.perspective.position.set(-900, 700, -900);
    this.perspective.lookAt(0, -40, 0);
    this.torpedoMarker = createMarkerSprite(0x7cf7df);
    this.scene.add(this.torpedoMarker);
    this.renderer.domElement.addEventListener("dblclick", () => {
      if (this.options.cameraMode === "orbit") this.focusOrbit();
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.animate = this.animate.bind(this);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  /** Re-centers the orbit camera on the current engagement midpoint. */
  focusOrbit(): void {
    if (!this.current) return;
    toRenderPositionInto(this.current.torpedo.position, scratchFromPosition);
    toRenderPositionInto(this.current.target.position, scratchToPosition);
    scratchCenter.copy(scratchFromPosition).lerp(scratchToPosition, 0.5);
    const separation = Math.max(
      300,
      scratchFromPosition.distanceTo(scratchToPosition),
    );
    const direction = scratchDesired
      .copy(this.orbitCamera.position)
      .sub(this.orbitControls.target)
      .normalize();
    if (!Number.isFinite(direction.x) || direction.lengthSq() < 0.5) {
      direction.set(-0.55, 0.45, -0.7).normalize();
    }
    this.orbitControls.target.copy(scratchCenter);
    this.orbitCamera.position.copy(scratchCenter).addScaledVector(direction, separation * 1.15 + 260);
    this.orbitControls.update();
  }

  setOptions(options: SceneOptions): void {
    if (options.fovHalfAngle !== this.options.fovHalfAngle) {
      updateSeekerSector(this.seeker, options.fovHalfAngle);
    }
    const waterDepth = options.waterDepth ?? DEFAULT_WATER_DEPTH;
    if (waterDepth !== (this.options.waterDepth ?? DEFAULT_WATER_DEPTH)) {
      disposeObject(this.environment);
      this.scene.remove(this.environment);
      this.environment = buildEnvironment(waterDepth);
      this.scene.add(this.environment);
    }
    const trailLimit = options.trailLimit ?? DEFAULT_TRAIL_LIMIT;
    if (trailLimit !== (this.options.trailLimit ?? DEFAULT_TRAIL_LIMIT)) {
      this.torpedoTrail.setLimit(trailLimit);
      this.targetTrail.setLimit(trailLimit);
      this.estimateTrail.setLimit(trailLimit);
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
      this.contactMeshes.clearTrails();
      return;
    }
    if (snapshot.sequence === this.lastSequence) return;
    if (snapshot.sequence < this.lastSequence) {
      this.torpedoTrail.clear();
      this.targetTrail.clear();
      this.estimateTrail.clear();
      this.contactMeshes.clearTrails();
    }
    this.previous = immediate ? snapshot : (this.current ?? snapshot);
    this.current = snapshot;
    this.arrivedAt = performance.now();
    this.lastSequence = snapshot.sequence;
    toRenderPositionInto(snapshot.torpedo.position, scratchFromPosition);
    this.torpedoTrail.push(scratchFromPosition.x, scratchFromPosition.y, scratchFromPosition.z);
    toRenderPositionInto(snapshot.target.position, scratchToPosition);
    this.targetTrail.push(scratchToPosition.x, scratchToPosition.y, scratchToPosition.z);
    if (snapshot.contacts) {
      this.contactMeshes.pushTrailPoints(snapshot.contacts, scratchDesired);
    }
    if (snapshot.estimate) {
      toRenderHorizontalInto(snapshot.estimate.position, scratchToPosition.y, scratchDesired);
      this.estimateTrail.push(scratchDesired.x, scratchDesired.y, scratchDesired.z);
    }
  }

  setReplayHistory(snapshots: readonly RenderSnapshot[]): void {
    this.torpedoTrail.clear();
    this.targetTrail.clear();
    this.estimateTrail.clear();
    this.contactMeshes.clearTrails();
    for (const snapshot of snapshots) {
      toRenderPositionInto(snapshot.torpedo.position, scratchFromPosition);
      this.torpedoTrail.push(scratchFromPosition.x, scratchFromPosition.y, scratchFromPosition.z);
      toRenderPositionInto(snapshot.target.position, scratchToPosition);
      this.targetTrail.push(scratchToPosition.x, scratchToPosition.y, scratchToPosition.z);
      if (snapshot.contacts) {
        this.contactMeshes.pushTrailPoints(snapshot.contacts, scratchDesired);
      }
      if (snapshot.estimate) {
        toRenderHorizontalInto(snapshot.estimate.position, scratchToPosition.y, scratchDesired);
        this.estimateTrail.push(scratchDesired.x, scratchDesired.y, scratchDesired.z);
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.orbitControls.dispose();
    this.contactMeshes.dispose();
    this.torpedoTrail.dispose();
    this.targetTrail.dispose();
    this.estimateTrail.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    this.orbitCamera.aspect = width / height;
    this.orbitCamera.updateProjectionMatrix();
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
    toRenderPositionInto(snapshot.target.position, scratchToPosition);
    const centerY = scratchToPosition.y + 0.8;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    const points = this.covariancePoints;
    for (let index = 0; index < 72; index += 1) {
      const angle = (index / 72) * Math.PI * 2;
      const x = Math.cos(angle) * Math.min(major, 1_500);
      const z = Math.sin(angle) * Math.min(minor, 1_500);
      points[index * 3] = estimate.position.x + x * cosTheta - z * sinTheta;
      points[index * 3 + 1] = centerY;
      points[index * 3 + 2] = estimate.position.y + x * sinTheta + z * cosTheta;
    }
    (this.covariance.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.covariance.visible = true;
  }

  private updateDiagnostics(snapshot: RenderSnapshot): void {
    const time = snapshot.metrics.predictedTimeToCpa;
    toRenderPositionInto(snapshot.torpedo.position, scratchFromPosition);
    toRenderPositionInto(snapshot.torpedo.velocity, scratchToPosition);
    const ownFutureX = scratchFromPosition.x + scratchToPosition.x * time;
    const ownFutureY = scratchFromPosition.y + scratchToPosition.y * time;
    const ownFutureZ = scratchFromPosition.z + scratchToPosition.z * time;

    let trackX: number;
    let trackY: number;
    let trackZ: number;
    let trackVelocityX: number;
    let trackVelocityY: number;
    let trackVelocityZ: number;
    if (snapshot.estimate) {
      trackX = snapshot.estimate.position.x;
      trackZ = snapshot.estimate.position.y;
      trackVelocityX = snapshot.estimate.velocity.x;
      trackVelocityZ = snapshot.estimate.velocity.y;
      toRenderPositionInto(snapshot.target.position, scratchCenter);
      trackY = scratchCenter.y;
      trackVelocityY = 0;
    } else {
      toRenderPositionInto(snapshot.target.position, scratchCenter);
      trackX = scratchCenter.x;
      trackY = scratchCenter.y;
      trackZ = scratchCenter.z;
      toRenderPositionInto(snapshot.target.velocity, scratchDesired);
      trackVelocityX = scratchDesired.x;
      trackVelocityY = scratchDesired.y;
      trackVelocityZ = scratchDesired.z;
    }

    const targetFutureX = trackX + trackVelocityX * time;
    const targetFutureY = trackY + trackVelocityY * time;
    const targetFutureZ = trackZ + trackVelocityZ * time;
    this.cpaPoints[0] = ownFutureX;
    this.cpaPoints[1] = ownFutureY;
    this.cpaPoints[2] = ownFutureZ;
    this.cpaPoints[3] = targetFutureX;
    this.cpaPoints[4] = targetFutureY;
    this.cpaPoints[5] = targetFutureZ;
    const cpaLength = Math.hypot(
      targetFutureX - ownFutureX,
      targetFutureY - ownFutureY,
      targetFutureZ - ownFutureZ,
    );
    this.cpaDistances[0] = 0;
    this.cpaDistances[1] = cpaLength;
    (this.cpaLine.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.cpaLine.geometry.getAttribute("lineDistance") as THREE.BufferAttribute).needsUpdate = true;

    const vectorScale = 8;
    const observerSpeed = Math.hypot(
      scratchToPosition.x,
      scratchToPosition.y,
      scratchToPosition.z,
    );
    const trackSpeed = Math.hypot(trackVelocityX, trackVelocityY, trackVelocityZ);
    const observerLength = Math.max(0.01, observerSpeed * vectorScale);
    const trackLength = Math.max(0.01, trackSpeed * vectorScale);
    this.observerVelocity.position.copy(scratchFromPosition);
    scratchForward.copy(scratchToPosition).normalize();
    this.observerVelocity.setDirection(scratchForward);
    this.observerVelocity.setLength(
      observerLength,
      Math.min(18, observerLength * 0.18),
      Math.min(8, observerLength * 0.08),
    );
    scratchDesired.set(trackVelocityX, trackVelocityY, trackVelocityZ);
    scratchCenter.set(trackX, trackY, trackZ);
    this.trackVelocity.position.copy(scratchCenter);
    this.trackVelocity.setDirection(scratchDesired.normalize());
    this.trackVelocity.setLength(
      trackLength,
      Math.min(18, trackLength * 0.18),
      Math.min(8, trackLength * 0.08),
    );
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
    if (this.options.cameraMode === "orbit") {
      if (!this.orbitControls.enabled) {
        this.orbitControls.enabled = true;
        this.focusOrbit();
      }
      this.orbitControls.update();
      return this.orbitCamera;
    }
    this.orbitControls.enabled = false;

    if (this.options.cameraMode === "tactical") {
      scratchCenter.copy(ownPosition).lerp(targetPosition, 0.5);
      const separation = Math.max(700, ownPosition.distanceTo(targetPosition) * 0.72);
      const aspect = Math.max(0.5, this.host.clientWidth / Math.max(1, this.host.clientHeight));
      this.tactical.left = -separation * aspect;
      this.tactical.right = separation * aspect;
      this.tactical.top = separation;
      this.tactical.bottom = -separation;
      this.tactical.position.set(scratchCenter.x, Math.max(1200, separation * 1.9), scratchCenter.z);
      this.tactical.up.set(0, 0, -1);
      this.tactical.lookAt(scratchCenter);
      this.tactical.updateProjectionMatrix();
      return this.tactical;
    }

    scratchForward.set(1, 0, 0).applyQuaternion(orientation).normalize();
    if (this.options.cameraMode === "seeker") {
      this.perspective.position.copy(ownPosition).addScaledVector(scratchForward, 18);
      this.perspective.position.y += 1.4;
      this.perspective.up.set(0, 1, 0);
      this.perspective.lookAt(
        scratchCenter.copy(this.perspective.position).addScaledVector(scratchForward, 800),
      );
      this.target.visible = snapshot.seekerStatus === "locked" || this.options.showTruth;
      return this.perspective;
    }

    // Chase: follow the observer from behind and above with smooth
    // interpolation that never feeds back into simulation state.
    scratchDesired
      .copy(ownPosition)
      .addScaledVector(scratchForward, -85);
    scratchDesired.y += 36;
    this.perspective.position.lerp(scratchDesired, 0.12);
    this.perspective.up.set(0, 1, 0);
    this.perspective.lookAt(
      scratchCenter.copy(ownPosition).addScaledVector(scratchForward, 110),
    );
    return this.perspective;
  }

  private animate(now: number): void {
    this.animationFrame = requestAnimationFrame(this.animate);
    if (!this.current || !this.previous) {
      this.renderer.render(this.scene, this.perspective);
      return;
    }
    const alpha = clamp((now - this.arrivedAt) / SNAPSHOT_INTERVAL_MS, 0, 1);
    const own = interpolateVehicleInto(this.previous.torpedo, this.current.torpedo, alpha, ownInterpolated);
    const contact = interpolateVehicleInto(this.previous.target, this.current.target, alpha, contactInterpolated);
    this.torpedo.position.copy(own.position);
    this.torpedo.quaternion.copy(own.orientation);
    const truthContacts = this.current.contacts;
    if (truthContacts && truthContacts.length > 0) {
      this.target.visible = false;
    } else {
      this.target.position.copy(contact.position);
      this.target.quaternion.copy(contact.orientation);
      this.target.visible = this.options.showTruth;
    }
    this.seeker.position.copy(own.position);
    this.seeker.position.y += 0.2;
    this.seeker.rotation.y = -own.heading;

    const estimate = this.current.estimate;
    this.estimate.visible = Boolean(estimate);
    if (estimate) {
      toRenderHorizontalInto(estimate.position, contact.position.y, scratchDesired);
      this.estimate.position.copy(scratchDesired);
    }
    // Frozen fire-control solution symbology (estimate data, not truth).
    const weapon = this.current.weapon;
    if (weapon?.enablePoint) {
      this.enablePoint.visible = true;
      toRenderHorizontalInto(weapon.enablePoint, own.position.y, scratchDesired);
      this.enablePoint.position.copy(scratchDesired);
    } else {
      this.enablePoint.visible = false;
    }
    if (weapon?.interceptPoint) {
      this.interceptPoint.visible = true;
      toRenderHorizontalInto(weapon.interceptPoint, own.position.y, scratchDesired);
      this.interceptPoint.position.copy(scratchDesired);
    } else {
      this.interceptPoint.visible = false;
    }
    const observation = this.current.observation;
    this.observation.visible = Boolean(observation);
    if (observation) {
      const bearing = observation.sensorHeading + observation.bearing;
      this.observation.position.set(
        observation.sensorPosition.x + Math.cos(bearing) * observation.range,
        contact.position.y,
        observation.sensorPosition.y + Math.sin(bearing) * observation.range,
      );
    }

    this.targetTrail.line.visible = this.options.showTruth;
    this.estimateTrail.line.visible = true;
    this.observation.visible = this.observation.visible && this.options.showDiagnostics;
    this.updateCovariance(this.current);
    this.updateDiagnostics(this.current);
    const camera = this.updateCamera(this.current, own.position, contact.position, own.orientation);
    this.contactMeshes.update(
      truthContacts ?? [],
      this.options.showTruth,
      scratchDesired,
      camera,
    );
    this.updateTorpedoMarker(camera, own.position);
    this.renderer.render(this.scene, camera);
  }

  private updateTorpedoMarker(camera: THREE.Camera, position: THREE.Vector3): void {
    this.torpedoMarker.position.copy(position);
    const worldHeight =
      camera instanceof THREE.OrthographicCamera
        ? Math.max(1, camera.top - camera.bottom)
        : Math.max(
            1,
            2 *
              camera.position.distanceTo(position) *
              Math.tan((((camera as THREE.PerspectiveCamera).fov ?? 50) * Math.PI) / 360),
          );
    const size = worldHeight * 0.03;
    this.torpedoMarker.scale.set(size, size, 1);
  }
}
