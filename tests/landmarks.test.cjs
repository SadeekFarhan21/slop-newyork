const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/landmarks.js'), 'utf8');

// ---------------------------------------------------------------------------------------------------------------------
// A stand-in for the parts of three.js the landmarks are modelled with: scene-graph transforms (column-major matrices,
// XYZ Euler rotations, decompose), the primitive geometries' vertex hulls (their bounding boxes come out as three.js's
// do), Box3 and placeholder materials & textures. Enough to run buildLandmarks unchanged and read back where each part
// stands and what blocks the player.
// ---------------------------------------------------------------------------------------------------------------------
class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
}

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  multiply(v) { return this.set(this.x * v.x, this.y * v.y, this.z * v.z); }
  applyMatrix4(m) {
    const e = m.elements;
    const { x, y, z } = this;
    return this.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
  }
}

class Euler {
  constructor() { this.x = 0; this.y = 0; this.z = 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
}

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  copy(m) { this.elements = m.elements.slice(); return this; }
  // T · R · S with R from an XYZ Euler (three.js makeRotationFromEuler)
  compose(p, r, s) {
    const a = Math.cos(r.x), b = Math.sin(r.x), c = Math.cos(r.y), d = Math.sin(r.y), e = Math.cos(r.z), f = Math.sin(r.z);
    const ae = a * e, af = a * f, be = b * e, bf = b * f;
    const cols = [[c * e, af + be * d, bf - ae * d], [-c * f, ae - bf * d, be + af * d], [d, -b * c, a * c]];
    const k = [s.x, s.y, s.z];
    const m = this.elements;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i * 4 + j] = cols[i][j] * k[i];
      m[i * 4 + 3] = 0;
    }
    m[12] = p.x; m[13] = p.y; m[14] = p.z; m[15] = 1;
    return this;
  }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements;
    const out = new Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += ae[k * 4 + row] * be[col * 4 + k];
        out[col * 4 + row] = v;
      }
    }
    this.elements = out;
    return this;
  }
  decompose(p, q, s) {
    const m = this.elements;
    const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    p.set(m[12], m[13], m[14]);
    s.set(sx, sy, sz);
    const m11 = m[0] / sx, m21 = m[1] / sx, m31 = m[2] / sx;
    const m12 = m[4] / sy, m22 = m[5] / sy, m32 = m[6] / sy;
    const m13 = m[8] / sz, m23 = m[9] / sz, m33 = m[10] / sz;
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const k = 0.5 / Math.sqrt(trace + 1);
      q.w = 0.25 / k; q.x = (m32 - m23) * k; q.y = (m13 - m31) * k; q.z = (m21 - m12) * k;
    } else if (m11 > m22 && m11 > m33) {
      const k = 2 * Math.sqrt(1 + m11 - m22 - m33);
      q.w = (m32 - m23) / k; q.x = 0.25 * k; q.y = (m12 + m21) / k; q.z = (m13 + m31) / k;
    } else if (m22 > m33) {
      const k = 2 * Math.sqrt(1 + m22 - m11 - m33);
      q.w = (m13 - m31) / k; q.x = (m12 + m21) / k; q.y = 0.25 * k; q.z = (m23 + m32) / k;
    } else {
      const k = 2 * Math.sqrt(1 + m33 - m11 - m22);
      q.w = (m21 - m12) / k; q.x = (m13 + m31) / k; q.y = (m23 + m32) / k; q.z = 0.25 * k;
    }
    return this;
  }
}

class Box2 {
  constructor() { this.min = new Vector2(Infinity, Infinity); this.max = new Vector2(-Infinity, -Infinity); }
  setFromPoints(points) {
    for (const p of points) {
      this.min.x = Math.min(this.min.x, p.x); this.min.y = Math.min(this.min.y, p.y);
      this.max.x = Math.max(this.max.x, p.x); this.max.y = Math.max(this.max.y, p.y);
    }
    return this;
  }
}

class Box3 {
  constructor(min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)) {
    this.min = min;
    this.max = max;
  }
  makeEmpty() { this.min.set(Infinity, Infinity, Infinity); this.max.set(-Infinity, -Infinity, -Infinity); return this; }
  isEmpty() { return this.max.x < this.min.x; }
  copy(b) { this.min.copy(b.min); this.max.copy(b.max); return this; }
  expandByPoint(p) {
    this.min.set(Math.min(this.min.x, p.x), Math.min(this.min.y, p.y), Math.min(this.min.z, p.z));
    this.max.set(Math.max(this.max.x, p.x), Math.max(this.max.y, p.y), Math.max(this.max.z, p.z));
    return this;
  }
  union(b) { if (!b.isEmpty()) { this.expandByPoint(b.min); this.expandByPoint(b.max); } return this; }
  applyMatrix4(m) {
    if (this.isEmpty()) return this;
    const { min, max } = this;
    const corners = [];
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) corners.push(new Vector3(x, y, z).applyMatrix4(m));
    }
    this.makeEmpty();
    for (const c of corners) this.expandByPoint(c);
    return this;
  }
  getSize(target) { return target.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }
  getCenter(target) { return target.set((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2); }
  expandByObject(object) {
    object.updateWorldMatrix(false, false);
    if (object.geometry) {
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      this.union(new Box3().copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld));
    }
    for (const child of object.children) this.expandByObject(child);
    return this;
  }
  setFromObject(object) { return this.makeEmpty().expandByObject(object); }
}

class Object3D {
  constructor() {
    this.position = new Vector3();
    this.rotation = new Euler();
    this.scale = new Vector3(1, 1, 1);
    this.matrix = new Matrix4();
    this.matrixWorld = new Matrix4();
    this.parent = null;
    this.children = [];
    this.userData = {};
    this.name = '';
    this.castShadow = false;
    this.receiveShadow = false;
  }
  add(...objects) {
    for (const o of objects) {
      if (o.parent) o.parent.remove(o);
      o.parent = this;
      this.children.push(o);
    }
    return this;
  }
  remove(o) {
    const i = this.children.indexOf(o);
    if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
    return this;
  }
  removeFromParent() { if (this.parent) this.parent.remove(this); return this; }
  traverse(fn) { fn(this); for (const c of this.children.slice()) c.traverse(fn); }
  updateMatrix() { this.matrix.compose(this.position, this.rotation, this.scale); }
  updateWorld() {
    if (this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
    else this.matrixWorld.copy(this.matrix);
  }
  updateMatrixWorld() {
    this.updateMatrix();
    this.updateWorld();
    for (const c of this.children) c.updateMatrixWorld();
  }
  updateWorldMatrix(updateParents, updateChildren) {
    if (updateParents && this.parent) this.parent.updateWorldMatrix(true, false);
    this.updateMatrix();
    this.updateWorld();
    if (updateChildren) for (const c of this.children) c.updateWorldMatrix(false, true);
  }
}
class Group extends Object3D {}
class Scene extends Object3D {}
class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isMesh = true; }
}

class BufferGeometry {
  constructor(type = 'BufferGeometry', parameters = {}, points = []) {
    this.type = type;
    this.parameters = parameters;
    this.points = points;
    this.boundingBox = null;
  }
  computeBoundingBox() {
    this.boundingBox = new Box3();
    for (const p of this.points) this.boundingBox.expandByPoint(p);
  }
  transformPoints(fn) { for (const p of this.points) fn(p); this.boundingBox = null; return this; }
  translate(x, y, z) { return this.transformPoints((p) => p.set(p.x + x, p.y + y, p.z + z)); }
  rotateX(a) { const c = Math.cos(a), s = Math.sin(a); return this.transformPoints((p) => p.set(p.x, c * p.y - s * p.z, s * p.y + c * p.z)); }
  rotateY(a) { const c = Math.cos(a), s = Math.sin(a); return this.transformPoints((p) => p.set(c * p.x + s * p.z, p.y, -s * p.x + c * p.z)); }
  toNonIndexed() { return new BufferGeometry('BufferGeometry', {}, this.points.map((p) => p.clone())); }
  computeVertexNormals() {}
}
class BoxGeometry extends BufferGeometry {
  constructor(width = 1, height = 1, depth = 1) {
    const points = [];
    for (const x of [-width / 2, width / 2]) {
      for (const y of [-height / 2, height / 2]) for (const z of [-depth / 2, depth / 2]) points.push(new Vector3(x, y, z));
    }
    super('BoxGeometry', { width, height, depth }, points);
  }
}
class CylinderGeometry extends BufferGeometry {
  constructor(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 32, _heightSegments = 1, _openEnded = false, thetaStart = 0,
    thetaLength = Math.PI * 2) {
    const points = [];
    for (const [r, y] of [[radiusTop, height / 2], [radiusBottom, -height / 2]]) {
      for (let i = 0; i <= radialSegments; i++) {
        const t = thetaStart + (i / radialSegments) * thetaLength;
        points.push(new Vector3(r * Math.sin(t), y, r * Math.cos(t)));
      }
    }
    super('CylinderGeometry', { radiusTop, radiusBottom, height, radialSegments }, points);
  }
}
class ConeGeometry extends CylinderGeometry {
  constructor(radius = 1, height = 1, radialSegments = 32) { super(0, radius, height, radialSegments); this.type = 'ConeGeometry'; }
}
class SphereGeometry extends BufferGeometry {
  constructor(radius = 1, widthSegments = 32, heightSegments = 16) {
    const points = [];
    for (let iy = 0; iy <= heightSegments; iy++) {
      const v = (iy / heightSegments) * Math.PI;
      for (let ix = 0; ix <= widthSegments; ix++) {
        const u = (ix / widthSegments) * Math.PI * 2;
        points.push(new Vector3(-radius * Math.cos(u) * Math.sin(v), radius * Math.cos(v), radius * Math.sin(u) * Math.sin(v)));
      }
    }
    super('SphereGeometry', { radius }, points);
  }
}
class TorusGeometry extends BufferGeometry {
  constructor(radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48) {
    const points = [];
    for (let j = 0; j <= radialSegments; j++) {
      for (let i = 0; i <= tubularSegments; i++) {
        const u = (i / tubularSegments) * Math.PI * 2, v = (j / radialSegments) * Math.PI * 2;
        points.push(new Vector3((radius + tube * Math.cos(v)) * Math.cos(u), (radius + tube * Math.cos(v)) * Math.sin(u), tube * Math.sin(v)));
      }
    }
    super('TorusGeometry', { radius, tube }, points);
  }
}
class PlaneGeometry extends BufferGeometry {
  constructor(width = 1, height = 1) {
    const points = [];
    for (const x of [-width / 2, width / 2]) for (const y of [-height / 2, height / 2]) points.push(new Vector3(x, y, 0));
    super('PlaneGeometry', { width, height }, points);
  }
}
class Shape {
  constructor() { this.start = null; this.current = null; this.segments = []; }
  moveTo(x, y) { this.start = this.current = new Vector2(x, y); return this; }
  lineTo(x, y) { const p = new Vector2(x, y); this.segments.push([this.current, null, p]); this.current = p; return this; }
  quadraticCurveTo(cx, cy, x, y) {
    const p = new Vector2(x, y);
    this.segments.push([this.current, new Vector2(cx, cy), p]);
    this.current = p;
    return this;
  }
  closePath() { if (this.current.x !== this.start.x || this.current.y !== this.start.y) this.lineTo(this.start.x, this.start.y); return this; }
  extractPoints(divisions = 12) {
    const points = [new Vector2(this.start.x, this.start.y)];
    for (const [a, c, b] of this.segments) {
      if (!c) { points.push(b); continue; }
      for (let k = 1; k <= divisions; k++) {
        const t = k / divisions, u = 1 - t;
        points.push(new Vector2(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y));
      }
    }
    const last = points[points.length - 1];
    if (points.length > 1 && Math.hypot(last.x - points[0].x, last.y - points[0].y) < 1e-9) points.pop();
    return { shape: points, holes: [] };
  }
}
// The extruded outline from z = 0 to depth; a bevel thickens it by bevelThickness either side and grows it by up to √2
// bevelSize (three.js moves a sharp corner out that far, an edge by bevelSize)
class ExtrudeGeometry extends BufferGeometry {
  constructor(shape, { depth = 1, bevelEnabled = true, bevelThickness = 0.2, bevelSize = bevelThickness - 0.1, curveSegments = 12 } = {}) {
    const outline = new Box2().setFromPoints(shape.extractPoints(curveSegments).shape);
    const grow = bevelEnabled ? bevelSize * Math.SQRT2 : 0;
    const thick = bevelEnabled ? bevelThickness : 0;
    const points = [];
    for (const x of [outline.min.x - grow, outline.max.x + grow]) {
      for (const y of [outline.min.y - grow, outline.max.y + grow]) for (const z of [-thick, depth + thick]) points.push(new Vector3(x, y, z));
    }
    super('ExtrudeGeometry', { depth }, points);
  }
}
class Material {
  constructor(parameters = {}) { Object.assign(this, parameters); }
}
class CanvasTexture {
  constructor(image) { this.image = image; }
}

const THREE = {
  Vector2, Vector3, Quaternion, Matrix4, Box2, Box3, Object3D, Group, Scene, Mesh,
  BoxGeometry, CylinderGeometry, ConeGeometry, SphereGeometry, TorusGeometry, PlaneGeometry, ExtrudeGeometry, Shape,
  MeshStandardNodeMaterial: class extends Material {}, MeshBasicNodeMaterial: class extends Material {},
  CanvasTexture, SRGBColorSpace: 'srgb', DoubleSide: 2
};
const WALL_KINDS = { shop: 0, entry: 1, rear: 2, lotLine: 3, blankStone: 4 };

// ---------------------------------------------------------------------------------------------------------------------
// The landmarks as built, read back: every drawn part as an oriented box (box-shaped parts, square or turned about +y)
// or its world bounds (anything else), and the player colliders
// ---------------------------------------------------------------------------------------------------------------------
let config;
let built;

function buildWorld() {
  const facadeBoxes = [];
  const context = new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : () => {}),
    set: (target, key, value) => { target[key] = value; return true; }
  });
  const document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  const material = (kind) => (options = {}) => new THREE.MeshStandardNodeMaterial({ kind, ...options });
  const { buildLandmarks } = loadModule(source, {
    globals: { document },
    imports: {
      'three/webgpu': THREE,
      './city-config.js': config,
      './tsl-materials.js': {
        createPreWarBuildingMaterial: material('prewar'),
        createCurtainWallMaterial: material('curtain'),
        createChryslerCrownMaterial: material('crown'),
        createBillboardMaterial: material('billboard'),
        createFacadeBoxes: (_material, boxes) => { facadeBoxes.push(...boxes); return new Group(); },
        WALL_KINDS
      },
      './city-grid.js': { batchStaticGroupMeshes: () => {} }
    },
    filename: 'landmarks.js'
  });
  const { group, colliders } = buildLandmarks(new Scene());
  group.updateMatrixWorld(true);

  const parts = facadeBoxes.map((b) => ({
    facade: b, box: true, cx: b.x, cy: b.y, cz: b.z, hx: b.w / 2, hy: b.h / 2, hz: b.d / 2, cs: Math.cos(b.ry || 0), sn: Math.sin(b.ry || 0)
  }));
  const pos = new Vector3(), rot = new Quaternion(), scale = new Vector3();
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.matrixWorld.decompose(pos, rot, scale);
    const upright = Math.abs(rot.x) < 1e-9 && Math.abs(rot.z) < 1e-9;
    const bounds = new Box3().setFromObject(o);
    const part = {
      mesh: o, type: o.geometry.type, upright,
      minX: bounds.min.x, maxX: bounds.max.x, minY: bounds.min.y, maxY: bounds.max.y, minZ: bounds.min.z, maxZ: bounds.max.z
    };
    if (o.geometry.type === 'BoxGeometry' && upright) {
      const { width, height, depth } = o.geometry.parameters;
      const turn = 2 * Math.atan2(rot.y, rot.w);
      Object.assign(part, {
        box: true, cx: pos.x, cy: pos.y, cz: pos.z, cs: Math.cos(turn), sn: Math.sin(turn),
        hx: (width * scale.x) / 2, hy: (height * scale.y) / 2, hz: (depth * scale.z) / 2
      });
    }
    parts.push(part);
  });
  for (const p of parts) {
    if (!p.box) continue;
    // world bounds of an oriented box
    const ex = Math.abs(p.cs) * p.hx + Math.abs(p.sn) * p.hz, ez = Math.abs(p.sn) * p.hx + Math.abs(p.cs) * p.hz;
    Object.assign(p, { minX: p.cx - ex, maxX: p.cx + ex, minZ: p.cz - ez, maxZ: p.cz + ez, minY: p.cy - p.hy, maxY: p.cy + p.hy });
  }
  return { colliders, parts, facadeBoxes };
}

// Is the world point inside an oriented box { cx, cz, hx, hz, cs, sn } (controllers.js buildingContact's frame)?
const inOriented = (o, x, z, eps) => {
  const dx = x - o.cx, dz = z - o.cz;
  return Math.abs(dx * o.cs - dz * o.sn) <= o.hx + eps && Math.abs(dx * o.sn + dz * o.cs) <= o.hz + eps;
};
const inPlan = (p, x, z, eps = 1e-6) => (p.box || p.obb
  ? inOriented(p.box ? p : p.obb, x, z, eps)
  : x >= p.minX - eps && x <= p.maxX + eps && z >= p.minZ - eps && z <= p.maxZ + eps);
// (a collider without minY stands on the ground, as controllers.js reads it)
const inside = (p, x, y, z, eps = 1e-6) => y >= (p.minY ?? 0) - eps && y <= p.maxY + eps && inPlan(p, x, z, eps);
// World point at (lx, lz) in an oriented box's own frame
const fromLocal = (o, lx, lz) => [o.cx + lx * o.cs + lz * o.sn, o.cz - lx * o.sn + lz * o.cs];
// A 3 x 3 x 3 grid of points just inside a box (oriented or axis-aligned)
function samples(b) {
  const o = b.box ? b : b.obb || {
    cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, hx: (b.maxX - b.minX) / 2, hz: (b.maxZ - b.minZ) / 2, cs: 1, sn: 0
  };
  const y0 = b.minY ?? 0;
  const hy = (b.maxY - y0) / 2, cy = (y0 + b.maxY) / 2;
  const steps = (h) => { const i = Math.min(0.25, h * 0.4); return [-h + i, 0, h - i]; };
  const out = [];
  for (const lx of steps(o.hx)) for (const lz of steps(o.hz)) for (const ly of steps(hy)) out.push([...fromLocal(o, lx, lz), cy + ly]);
  return out.map(([x, z, y]) => [x, y, z]);
}
const at = (x, y, z) => `(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;
const corners = (c) => {
  if (!c.obb) return [[c.minX, c.minZ], [c.maxX, c.minZ], [c.minX, c.maxZ], [c.maxX, c.maxZ]];
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, k]) => fromLocal(c.obb, i * c.obb.hx, k * c.obb.hz));
};
const lotBox = (t) => ({ x0: t.x - t.w / 2, x1: t.x + t.w / 2, z0: t.z - t.d / 2, z1: t.z + t.d / 2 });
const overlapsLot = (p, l, m = 0) => p.maxX > l.x0 - m && p.minX < l.x1 + m && p.maxZ > l.z0 - m && p.minZ < l.z1 + m;
// Share of a lot's plan (1 m cells, inside its OpenStreetMap ring when one is given) under drawn parts at least minTop tall
function coverage(site, parts, minTop) {
  const l = lotBox(site);
  const ring = site.ring;
  const inRing = (x, z) => {
    let inPoly = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [xi, zi, xj, zj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inPoly = !inPoly;
    }
    return inPoly;
  };
  const tall = parts.filter((p) => p.maxY >= minTop && overlapsLot(p, l));
  let cells = 0, covered = 0;
  for (let x = Math.floor(l.x0) + 0.5; x < l.x1; x++) {
    for (let z = Math.floor(l.z0) + 0.5; z < l.z1; z++) {
      if (x < l.x0 || z < l.z0 || (ring && !inRing(x, z))) continue;
      cells++;
      if (tall.some((p) => inPlan(p, x, z))) covered++;
    }
  }
  return covered / cells;
}

test.before(async () => {
  config = await import('../js/city-config.js');
  built = buildWorld();
});

test('every collider is a well formed box, its oriented box inside its bounds', () => {
  assert.ok(built.colliders.length > 100, 'each solid part brings its own collider');
  for (const [i, c] of built.colliders.entries()) {
    for (const k of ['minX', 'maxX', 'maxY', 'minZ', 'maxZ']) assert.ok(Number.isFinite(c[k]), `collider ${i} ${k}`);
    assert.ok(c.minY === undefined || Number.isFinite(c.minY), `collider ${i} minY`);
    assert.ok(c.minX < c.maxX && c.minZ < c.maxZ && (c.minY ?? 0) < c.maxY, `collider ${i} has extent`);
    if (!c.obb) continue;
    assert.ok(Math.abs(c.obb.cs ** 2 + c.obb.sn ** 2 - 1) < 1e-9, `collider ${i} turns by a rotation`);
    for (const [x, z] of corners(c)) {
      assert.ok(x >= c.minX - 1e-6 && x <= c.maxX + 1e-6 && z >= c.minZ - 1e-6 && z <= c.maxZ + 1e-6, `collider ${i} bounds its oriented box`);
    }
  }
});

test('no collider blocks where nothing is drawn (no invisible walls round tiers, spires or open plazas)', () => {
  const misses = [];
  for (const [i, c] of built.colliders.entries()) {
    for (const [x, y, z] of samples(c)) {
      if (!built.parts.some((p) => inside(p, x, y, z, 0.02))) {
        misses.push(`collider ${i} at ${at(x, y, z)}`);
        break;
      }
    }
  }
  assert.deepEqual(misses, []);
});

test('every drawn building mass blocks the player (wings, piers, tiers, the Stock Exchange)', () => {
  const masses = built.parts.filter((p) => p.box && Math.min(p.hx, p.hy, p.hz) >= 1);
  // (standing cylinders: masts, domes, the carousel; not the window arches & clock faces)
  const cylinders = built.parts.filter((p) => p.type === 'CylinderGeometry' && p.upright && p.maxY - p.minY >= 2 &&
    Math.min(p.mesh.geometry.parameters.radiusTop, p.mesh.geometry.parameters.radiusBottom) >= 1);
  assert.ok(masses.length > 60 && cylinders.length > 3);
  const holes = [];
  for (const p of masses) {
    for (const [x, y, z] of samples(p)) {
      if (!built.colliders.some((c) => inside(c, x, y, z))) {
        holes.push(`${p.facade ? 'facade box' : p.type} at ${at(x, y, z)}`);
        break;
      }
    }
  }
  for (const p of cylinders) {
    const { radiusTop, radiusBottom, height } = p.mesh.geometry.parameters;
    const r = Math.min(radiusTop, radiusBottom) * 0.6;
    for (const ly of [-height * 0.4, 0, height * 0.4]) {
      const v = new Vector3(r, ly, -r).applyMatrix4(p.mesh.matrixWorld);
      if (!built.colliders.some((c) => inside(c, v.x, v.y, v.z))) {
        holes.push(`cylinder at ${at(v.x, v.y, v.z)}`);
        break;
      }
    }
  }
  assert.deepEqual(holes, []);
});

test('Grand Central fills its own lot, its 42nd St front on the street', () => {
  const gct = config.LANDMARK_SITES['Grand Central Terminal'];
  const lot = lotBox(gct);
  // (De Pew Pl and the Vanderbilt Ave sidewalk inside the OpenStreetMap outline stay streets)
  assert.ok(coverage({ ...gct, ring: null }, built.parts, 7) > 0.8, 'the terminal stands on the lot');
  for (let x = gct.x - 40; x <= gct.x + 40; x += 10) {
    assert.ok(built.parts.some((p) => p.maxY >= 7 && inPlan(p, x, lot.z1 - 1.5)), `the front reaches 42nd St at x ${x}`);
  }
  const centred = (p, l) => {
    const x = (p.minX + p.maxX) / 2, z = (p.minZ + p.maxZ) / 2;
    return x > l.x0 && x < l.x1 && z > l.z0 && z < l.z1;
  };
  const top = Math.max(...built.parts.filter((p) => centred(p, lot)).map((p) => p.maxY));
  assert.ok(Math.abs(top - gct.h) < 1, `the terminal is ${gct.h} m tall (${top.toFixed(1)})`);
  assert.ok(!built.parts.some((p) => p.maxY > 60 && overlapsLot(p, lot, -0.5)), 'no tower stands on the terminal');
});

test('the MetLife Building rises from its own lot behind the terminal', () => {
  const ml = config.LANDMARK_SITES['MetLife Building'];
  const lot = lotBox(ml);
  const terminal = lotBox(config.LANDMARK_SITES['Grand Central Terminal']);
  const both = { x0: Math.min(lot.x0, terminal.x0), x1: Math.max(lot.x1, terminal.x1), z0: lot.z0, z1: terminal.z1 };
  const tower = built.parts.filter((p) => p.maxY > 100 && overlapsLot(p, both));
  assert.ok(tower.length >= 3);
  for (const p of tower) {
    assert.ok(p.minX >= lot.x0 - 0.5 && p.maxX <= lot.x1 + 0.5 && p.minZ >= lot.z0 - 0.5 && p.maxZ <= lot.z1 + 0.5, 'the tower stays on its lot');
  }
  assert.ok(Math.abs(Math.max(...tower.map((p) => p.maxY)) - ml.h) < 1, `${ml.h} m tall`);
  const cx = (Math.min(...tower.map((p) => p.minX)) + Math.max(...tower.map((p) => p.maxX))) / 2;
  const cz = (Math.min(...tower.map((p) => p.minZ)) + Math.max(...tower.map((p) => p.maxZ))) / 2;
  assert.ok(Math.hypot(cx - ml.x, cz - ml.z) < 5, 'centred on its lot');
  assert.ok(coverage({ ...ml, ring: null }, built.parts, 30) > 0.95, 'its base fills the lot');
});

test('the Grand Central arrival looks up Park Ave at the terminal front', () => {
  const { x, z, heading } = config.TELEPORT_LOCATIONS.grandcentral;
  const lot = lotBox(config.LANDMARK_SITES['Grand Central Terminal']);
  let d = 0;
  for (; d < 400; d += 0.5) {
    const px = x + Math.sin(heading) * d, pz = z + Math.cos(heading) * d;
    if (built.colliders.some((c) => inside(c, px, 1.5, pz))) break;
  }
  const pz = z + Math.cos(heading) * d;
  assert.ok(d > 100 && d < 200, `the front ${d} m ahead`);
  assert.ok(pz <= lot.z1 + 0.5 && pz >= lot.z1 - 3, 'on the lot\'s 42nd St edge');
});

test('the New York Stock Exchange stands on its lot at Wall & Broad', () => {
  const nyse = config.LANDMARK_SITES['New York Stock Exchange'];
  const lot = lotBox(nyse);
  assert.ok(coverage(nyse, built.parts, 30) > 0.8, 'the exchange covers its real outline');
  const here = built.parts.filter((p) => overlapsLot(p, lot, -1));
  assert.ok(Math.abs(Math.max(...here.map((p) => p.maxY)) - 47) < 0.5, 'its real 47 m');
  const columns = here.filter((p) => p.type === 'CylinderGeometry' && p.maxY - p.minY > 10);
  assert.equal(columns.length, 6, 'six giant columns');
  for (const c of columns) assert.ok(lot.x1 - (c.minX + c.maxX) / 2 < 5, 'on the Broad St front');
  assert.ok(here.some((p) => p.type === 'ExtrudeGeometry'), 'under a pediment');
  assert.ok(here.some((p) => p.type === 'PlaneGeometry' && p.mesh.material.map && p.maxY - p.minY > 10), 'the flag across the colonnade');
  // its walls follow Broad St & Wall St, so their windows run along them
  const walls = built.facadeBoxes.filter((b) => overlapsLot({ minX: b.x, maxX: b.x, minZ: b.z, maxZ: b.z }, lot));
  assert.ok(walls.some((b) => Math.abs(b.ry - 0.0495) < 1e-6) && walls.some((b) => Math.abs(b.ry + 0.2148) < 1e-6));
  assert.ok(walls.every((b) => Math.abs(b.ry - 0.0495) < 1e-6 || Math.abs(b.ry + 0.2148) < 1e-6));
  const noShops = (b) => b.faces && b.faces.every((k) => k === WALL_KINDS.entry || k === WALL_KINDS.blankStone);
  assert.ok(walls.filter((b) => b.h > 40).every(noShops), 'no shop fronts');
});

test('landmarks laid out in place stand at street level inside their block\'s building line', () => {
  const line = (site) => {
    const b = config.blockAt(site.x, site.z);
    const side = (k, f) => f(...b.rects.map((r) => r[k]));
    return [side(0, Math.min), side(1, Math.max), side(2, Math.min), side(3, Math.max)];
  };
  const ground = built.colliders.filter((c) => (c.minY ?? 0) < 3.5);
  const gct = config.LANDMARK_SITES['Grand Central Terminal'];
  const ml = config.LANDMARK_SITES['MetLife Building'];
  const [x0, x1, z0, z1] = line(gct);
  const area = { x0: Math.min(lotBox(gct).x0, lotBox(ml).x0), x1: Math.max(lotBox(gct).x1, lotBox(ml).x1), z0: lotBox(ml).z0, z1: lotBox(gct).z1 };
  const midtown = ground.filter((c) => overlapsLot(c, area));
  assert.ok(midtown.length >= 3);
  for (const c of midtown) {
    for (const [x, z] of corners(c)) {
      assert.ok(x >= x0 - 1e-6 && x <= x1 + 1e-6 && z >= z0 - 1e-6 && z <= z1 + 1e-6, 'clear of De Pew Pl, Vanderbilt Ave & 42nd St');
    }
  }
  // the exchange keeps between the street trees of New St & Broad St
  const nyse = config.LANDMARK_SITES['New York Stock Exchange'];
  const [n0, n1] = line(nyse);
  const exchange = ground.filter((c) => overlapsLot(c, lotBox(nyse)));
  assert.ok(exchange.length >= 3);
  for (const c of exchange) for (const [x] of corners(c)) assert.ok(x >= n0 - 1e-6 && x <= n1 + 1e-6, 'clear of the street trees');
});
