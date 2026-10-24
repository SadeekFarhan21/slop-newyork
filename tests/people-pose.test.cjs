const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// The crowds' pose pipeline without a browser: PersonCrowd stores each person's bone transforms on the CPU, and its
// material's TSL graph is evaluated numerically, one vertex of one instance at a time, the way three.js's node builders
// compile it on WebGPU (storage buffers) and on the WebGL2 fallback (no storage buffers: there an indexed storage read
// builds as a plain vertex attribute, read at the vertex's own index).
const env = { storage: true, instance: 0, vertex: null, vertexIndex: 0, normal: null, reads: new Set() };
const builder = { isAvailable: (name) => name === 'storageBuffer' && env.storage };

const value = (v) => (v instanceof Node ? v.evaluate() : Array.isArray(v) ? v : [v]);
const isInt = (v) => (v instanceof Node ? v.int : Number.isInteger(v));
class Node {
  constructor(evaluate, int = false) {
    this.evaluate = evaluate;
    this.int = int;
  }
  get x() { return this.part(0, 1); }
  get y() { return this.part(1, 2); }
  get z() { return this.part(2, 3); }
  get w() { return this.part(3, 4); }
  get xyz() { return this.part(0, 3); }
  part(start, end) { return new Node(() => value(this).slice(start, end), this.int); }
  add(b) { return zip(this, b, (p, q) => p + q); }
  sub(b) { return zip(this, b, (p, q) => p - q); }
  mul(b) { return zip(this, b, (p, q) => p * q); }
  div(b) { return zip(this, b, isInt(this) && isInt(b) ? (p, q) => Math.trunc(p / q) : (p, q) => p / q); }
  mod(b) { return zip(this, b, (p, q) => p % q); }
  toVar() { return this; }
}
function zip(a, b, op) {
  return new Node(() => {
    const p = value(a);
    const q = value(b);
    return Array.from({ length: Math.max(p.length, q.length) }, (_, i) => op(p[i % p.length], q[i % q.length]));
  }, isInt(a) && isInt(b));
}
const each = (op) => (...args) => new Node(() => {
  const vs = args.map(value);
  return Array.from({ length: Math.max(...vs.map((v) => v.length)) }, (_, i) => op(...vs.map((v) => v[i % v.length])));
});

function storageBuffer(count) {
  const attribute = {
    array: new Float32Array(count * 4),
    count,
    version: 0,
    updateRanges: [],
    addUpdateRange(start, n) { this.updateRanges.push({ start, count: n }); },
    clearUpdateRanges() { this.updateRanges.length = 0; },
    set needsUpdate(v) { if (v) this.version++; }
  };
  const read = (i) => {
    assert.ok(Number.isInteger(i) && i >= 0 && i < count, `storage element ${i} outside the buffer`);
    return Array.from(attribute.array.subarray(i * 4, i * 4 + 4));
  };
  return {
    value: attribute,
    toReadOnly() { return this; },
    element: (index) => new Node(() => {
      env.reads.add('storage');
      if (env.storage) return read(value(index)[0]);
      // StorageArrayElementNode without storage buffers (and not a PBO): the buffer is bound as a vertex attribute
      if (env.vertexIndex >= count) throw new Error('GL_INVALID_OPERATION: Vertex buffer is not big enough for the draw call');
      return read(env.vertexIndex);
    })
  };
}

function texel(texture, uv, layer = null) {
  const node = new Node(() => {
    env.reads.add('texture');
    const [x, y] = value(uv);
    const z = layer === null ? 0 : value(layer)[0];
    const { width, height, depth = 1, data } = texture.image;
    for (const [c, size] of [[x, width], [y, height], [z, depth]]) {
      assert.ok(Number.isInteger(c) && c >= 0 && c < size, `texel (${x}, ${y}, ${z}) outside the ${width}x${height}x${depth} texture`);
    }
    const i = ((z * height + y) * width + x) * 4;
    return Array.from(data.subarray(i, i + 4));
  });
  node.depth = (l) => texel(texture, uv, l);
  return node;
}

let material = null; // the material being built, collecting its varyings
const tsl = {
  Fn: (fn) => (...params) => new Node(() => value(params.length || fn.length > 1 ? fn(params, builder) : fn(builder))),
  float: (v) => new Node(() => value(v)),
  int: (v) => new Node(() => value(v).map(Math.trunc), true),
  ivec2: (x, y) => new Node(() => [...value(x), ...value(y)], true),
  vec2: (...v) => new Node(() => v.flatMap(value)),
  vec3: (...v) => new Node(() => v.flatMap(value)),
  color: (hex) => new Node(() => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => c / 255)),
  attribute: (name) => new Node(() => env.vertex[name]),
  instanceIndex: new Node(() => [env.instance], true),
  attributeArray: (count) => storageBuffer(count),
  textureLoad: (texture, uv) => texel(texture, uv),
  normalLocal: Object.assign(new Node(() => env.normal), { assign: (v) => { env.normal = value(v); } }),
  varying: (node, name) => (material.varyings[name] = node),
  cross: (a, b) => new Node(() => {
    const [ax, ay, az] = value(a);
    const [bx, by, bz] = value(b);
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  }),
  normalize: (v) => new Node(() => {
    const a = value(v);
    const length = Math.hypot(...a);
    return a.map((c) => c / length);
  }),
  sin: each(Math.sin),
  abs: each(Math.abs),
  fract: each((v) => v - Math.floor(v)),
  max: each(Math.max),
  clamp: each((v, lo, hi) => Math.min(Math.max(v, lo), hi)),
  mix: each((a, b, t) => a + (b - a) * t),
  step: each((edge, v) => (v < edge ? 0 : 1)),
  smoothstep: each((e0, e1, v) => {
    const t = Math.min(Math.max((v - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  })
};

const THREE = {
  RGBAFormat: 1023,
  UnsignedByteType: 1009,
  FloatType: 1015,
  Vector3: class {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  },
  Quaternion: class {},
  Matrix4: class {},
  Mesh: class {
    constructor(geometry, mat) { Object.assign(this, { geometry, material: mat }); }
  },
  MeshStandardNodeMaterial: class {
    constructor(parameters) {
      Object.assign(this, parameters, { varyings: {} });
      material = this;
    }
  },
  DataArrayTexture: class {
    constructor(data, width = 1, height = 1, depth = 1) {
      Object.assign(this, { image: { data, width, height, depth }, format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
      this.version = 0;
      this.layerUpdates = new Set();
    }
    addLayerUpdate(layer) { this.layerUpdates.add(layer); }
    clearLayerUpdates() { this.layerUpdates.clear(); }
    set needsUpdate(v) { if (v) this.version++; }
  }
};

// The body geometry isn't under test (and needs most of three.js): crowds get an empty stand-in
const source = readFileSync(join(__dirname, '../js/pedestrians.js'), 'utf8');
const patched = source.replace(/^function buildPersonGeometry\(detail = 1\) \{$/m, '$&\n  return { detail };');
assert.notEqual(patched, source, 'buildPersonGeometry is present');
const { PERSON_BONES, PersonCrowd } = loadModule(patched, {
  imports: {
    'three/webgpu': THREE,
    'three/tsl': tsl,
    'three/addons/utils/BufferGeometryUtils.js': { mergeGeometries() {} }
  }
});
const BONES = Object.keys(PERSON_BONES).length;
const STRIDE = BONES * 2 + 1; // vec4s per person: (quaternion) and (translation, scale) per bone, then the person's info
const LONG_HAIR = 7; // part id of the long hair (its length morph follows the upper half of `hair`)

function random(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

// A rig stand-in: distinct, arbitrary bone transforms and person info, in PersonRig.pose's layout
function fakeRig(rand) {
  const pose = new Float32Array(STRIDE * 4);
  for (let b = 0; b < BONES; b++) {
    const q = [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const length = Math.hypot(...q);
    pose.set([...q.map((c) => c / length), rand() * 80 - 40, rand() * 6, rand() * 80 - 40, 0.85 + rand() * 0.3], b * 8);
  }
  pose.set([rand() * 500, rand() < 0.5 ? 0 : 1, 0.9 + rand() * 0.25, rand()], (STRIDE - 1) * 4);
  return { pose };
}

// Vertices skinned to different bone pairs (the last bones' columns included), with every morph in play: [index in the
// near body, position, normal, skin (bone a, bone b, weight of b, part), extra, femaleDelta, hairDelta]
const VERTICES = [
  [0, [0.1, 1.2, 0.05], [0, 0, 1], [1, 2, 0.35, 0], [0.12, -0.03, 0.4], [0.01, -0.02, 0.005], [0.002, 0.004, -0.001]],
  [777, [-0.09, 0.45, 0.02], [-0.6, 0, 0.8], [11, 12, 0.5, 1], [-0.05, 0.02, 0.7], [0, 0.01, 0], [0, 0, 0]],
  [1500, [0, 1.66, -0.03], [0, 1, 0], [2, 1, 0.8, LONG_HAIR], [0, 0, 0.2], [0, -0.004, 0], [0, -0.2, -0.06]],
  [1999, [-0.09, 0.03, 0.15], [0, -1, 0], [13, 14, 0.55, 2], [0.03, 0.05, 0.9], [0.002, 0, -0.01], [0, 0, 0]]
].map(([index, position, normal, skin, extra, femaleDelta, hairDelta]) => ({
  index, position, normal, skin, extra, femaleDelta, hairDelta
}));

// Expected skinning, independently: rotation matrices from the quaternions
function rotate([x, y, z, w], [vx, vy, vz]) {
  return [
    (1 - 2 * (y * y + z * z)) * vx + 2 * (x * y - z * w) * vy + 2 * (x * z + y * w) * vz,
    2 * (x * y + z * w) * vx + (1 - 2 * (x * x + z * z)) * vy + 2 * (y * z - x * w) * vz,
    2 * (x * z - y * w) * vx + 2 * (y * z + x * w) * vy + (1 - 2 * (x * x + y * y)) * vz
  ];
}
function expected(pose, v) {
  const info = [...pose.subarray((STRIDE - 1) * 4)];
  const [, female, girth, hair] = info;
  const clamp01 = (t) => Math.min(Math.max(t, 0), 1);
  const hairAmount = v.skin[3] === LONG_HAIR ? clamp01(hair * 2 - 1) : clamp01(hair * 2);
  const girthOffset = [v.extra[0], 0, v.extra[1]];
  const p = v.position.map((c, i) => c + girthOffset[i] * (girth - 1) + v.femaleDelta[i] * female + v.hairDelta[i] * hairAmount);
  const bone = (b) => ({ q: [...pose.subarray(b * 8, b * 8 + 4)], t: pose.subarray(b * 8 + 4, b * 8 + 7), s: pose[b * 8 + 7] });
  const [a, b] = [bone(v.skin[0]), bone(v.skin[1])];
  const w = v.skin[2];
  const pa = rotate(a.q, p).map((c, i) => c * a.s + a.t[i]);
  const pb = rotate(b.q, p).map((c, i) => c * b.s + b.t[i]);
  const na = rotate(a.q, v.normal);
  const nb = rotate(b.q, v.normal);
  const n = na.map((c, i) => c + (nb[i] - c) * w);
  return { position: pa.map((c, i) => c + (pb[i] - c) * w), normal: n.map((c) => c / Math.hypot(...n)), info };
}

// One vertex of one instance of a crowd mesh, as the backend's vertex stage computes it
function draw(mesh, storage, instance, vertex) {
  Object.assign(env, { storage, instance, vertex, vertexIndex: vertex.index, normal: null, reads: new Set() });
  const position = value(mesh.material.positionNode);
  const info = value(mesh.material.varyings.vPersonInfo);
  return { position, normal: env.normal, info, reads: [...env.reads] };
}

function assertClose(actual, wanted, tolerance, message) {
  assert.equal(actual.length, wanted.length, message);
  actual.forEach((c, i) => assert.ok(Math.abs(c - wanted[i]) <= tolerance, `${message}: ${actual} should be ${[...wanted]}`));
}

// A frame's crowd: `near` and `far` people added interleaved, as traffic.js adds them by distance
function crowdFrame(maxCount, near, far, seed) {
  const crowd = new PersonCrowd(maxCount);
  const rand = random(seed);
  const rigs = [[], []];
  const add = (lod, distance) => {
    const rig = fakeRig(rand);
    rigs[lod].push(rig);
    crowd.add(rig, distance);
  };
  crowd.begin();
  for (let i = 0; i < Math.max(near, far); i++) {
    if (i < near) add(0, 3 + (i % 30));
    if (i < far) add(1, crowd.farDistance + 1 + i);
  }
  crowd.end();
  return { crowd, rigs };
}

const BACKENDS = [['WebGPU', true], ['WebGL2', false]];
const CROWDS = [['a one-person crowd (player, rider)', 1, 1, 0], ['a full sidewalk crowd', 340, 340, 37]];

for (const [backend, storage] of BACKENDS) {
  for (const [label, maxCount, near, far] of CROWDS) {
    test(`${backend}: every person in ${label} is skinned from their own pose`, () => {
      const { crowd, rigs } = crowdFrame(maxCount, near, far, maxCount * 7 + (storage ? 1 : 2));
      crowd.lods.forEach((lod, k) => {
        const people = rigs[k].length;
        assert.equal(lod.mesh.count, people);
        // both ends, and either side of the WebGL2 texture's layer boundaries
        const sample = new Set([0, 1, 15, 16, 17, 31, 32, people - 2, people - 1].filter((i) => i >= 0 && i < people));
        for (const instance of sample) {
          for (const vertex of VERTICES) {
            const want = expected(rigs[k][instance].pose, vertex);
            const got = draw(lod.mesh, storage, instance, vertex);
            const where = `${lod.mesh.name ?? `lod ${k}`} person ${instance}, vertex ${vertex.index}`;
            assertClose(got.position, want.position, 2e-4, `${where} position`);
            assertClose(got.normal, want.normal, 1e-5, `${where} normal`);
            assert.deepEqual(got.info, want.info, `${where} seed, female, girth & hair`);
            assert.deepEqual(got.reads, [storage ? 'storage' : 'texture'], `${where} reads its backend's copy only`);
          }
        }
      });
    });
  }
}

test('WebGL2: a huge crowd still fits the smallest texture limits WebGL2 guarantees', () => {
  const { crowd, rigs } = crowdFrame(5000, 5000, 0, 99);
  const lod = crowd.lods[0];
  const { width, height, depth } = lod.pose.texture.image;
  assert.ok(width <= 2048 && height <= 2048 && depth <= 256, `${width}x${height}x${depth} pose texture`);
  assert.equal(lod.pose.texture.type, THREE.FloatType);
  assert.equal(lod.pose.texture.format, THREE.RGBAFormat);
  for (const instance of [0, height - 1, height, 2500, 4096, 4999]) {
    const want = expected(rigs[0][instance].pose, VERTICES[3]);
    assertClose(draw(lod.mesh, false, instance, VERTICES[3]).position, want.position, 2e-4, `person ${instance}`);
  }
});

test('frames upload only the people drawn: buffer rows on WebGPU, texture layers on WebGL2', () => {
  const crowd = new PersonCrowd(340);
  const [nearLod, farLod] = crowd.lods;
  for (const lod of crowd.lods) {
    // before the first frame: one degenerate (zeroed) person compiles the pipelines, against an uploaded texture
    assert.equal(lod.mesh.count, 1);
    assert.equal(lod.pose.texture.version, 1);
    assert.deepEqual(draw(lod.mesh, false, 0, VERTICES[0]).position, [0, 0, 0]);
  }
  // as three.js's WebGL2 backend does after uploading the layers listed
  const uploadedLayers = (texture) => {
    const layers = [...texture.layerUpdates].sort((a, b) => a - b);
    texture.clearLayerUpdates();
    return layers;
  };
  for (const lod of crowd.lods) uploadedLayers(lod.pose.texture);

  const rand = random(5);
  const perLayer = nearLod.pose.texture.image.height;
  const frame = (count) => {
    crowd.begin();
    for (let i = 0; i < count; i++) crowd.add(fakeRig(rand), 1);
    crowd.end();
  };
  frame(20);
  const buffer = nearLod.pose.buffer.value;
  assert.equal(nearLod.mesh.count, 20);
  assert.deepEqual(buffer.updateRanges, [{ start: 0, count: 20 * STRIDE * 4 }]);
  assert.equal(buffer.version, 1);
  assert.equal(nearLod.pose.texture.version, 2);
  assert.deepEqual(uploadedLayers(nearLod.pose.texture), Array.from({ length: Math.ceil(20 / perLayer) }, (_, i) => i));

  frame(3);
  assert.equal(nearLod.mesh.count, 3);
  assert.deepEqual(buffer.updateRanges, [{ start: 0, count: 3 * STRIDE * 4 }]);
  assert.equal(buffer.version, 2);
  assert.equal(nearLod.pose.texture.version, 3);
  assert.deepEqual(uploadedLayers(nearLod.pose.texture), [0]);

  // nobody far away: nothing drawn, nothing uploaded
  assert.equal(farLod.mesh.count, 0);
  assert.equal(farLod.pose.buffer.value.version, 0);
  assert.deepEqual(farLod.pose.buffer.value.updateRanges, []);
  assert.equal(farLod.pose.texture.version, 1);
  assert.deepEqual(uploadedLayers(farLod.pose.texture), []);
});
