const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// The city's layout at its real places: the Manhattan seawall & its esplanade, the pier decks and Little Island.
// Production code runs unchanged: city-config.js as a module, the rest as functions taken from their sources and run
// against small stand-ins for Three.js.
const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const gridSource = read('js/city-grid.js');
let config, GEO;
test.before(async () => {
  config = await import('../js/city-config.js');
  ({ GEO } = await import('../js/nyc-geodata.js'));
});

// Source of the block that opens at the first `{` from `from` on (braces matched)
function braced(source, start, from) {
  let depth = 0;
  for (let k = source.indexOf('{', from); k < source.length; k++) {
    if (source[k] === '{') depth++;
    else if (source[k] === '}' && --depth === 0) return source.slice(start, k + 1);
  }
  throw new Error('unbalanced braces');
}
// A top-level function of city-grid.js
function gridFunction(name) {
  const start = gridSource.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `city-grid.js must define ${name}`);
  return braced(gridSource, start, gridSource.indexOf(')', start));
}

// ---- Plane geometry ------------------------------------------------------------------------------------------------
function inside(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}
function segmentDistance(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(a.x + t * dx - x, a.z + t * dz - z);
}
function outlineDistance(poly, x, z) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segmentDistance(x, z, poly[j], poly[i]));
  return d;
}
function selfCrossings(poly) {
  const n = poly.length;
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const found = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j], d = poly[(j + 1) % n];
      if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)) continue;
      if (Math.max(a.z, b.z) < Math.min(c.z, d.z) || Math.max(c.z, d.z) < Math.min(a.z, b.z)) continue;
      if ((cross(c, d, a) > 0) !== (cross(c, d, b) > 0) && (cross(a, b, c) > 0) !== (cross(a, b, d) > 0)) found.push([i, j]);
    }
  }
  return found;
}
// Points every `step` m along each edge of a polygon, pushed `out` m along the edge's outward normal
function edgeSamples(poly, out, step = 1) {
  let area = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  const s = area > 0 ? -1 : 1;
  const pts = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = (-(b.z - a.z) / len) * s, nz = ((b.x - a.x) / len) * s;
    for (let t = step / 2; t < len; t += step) pts.push({ x: a.x + ((b.x - a.x) * t) / len + nx * out, z: a.z + ((b.z - a.z) * t) / len + nz * out });
  }
  return pts;
}

// ---- The seawall & its esplanade -----------------------------------------------------------------------------------
let seawallCache;
function seawall() {
  if (!seawallCache) {
    const code = ['offsetPolygonInward', 'offsetPolygon', 'untangleOffset', 'polygonScan'].map(gridFunction).join('\n');
    const section = /const seawallPolygon = ([^;]+);/.exec(gridSource);
    assert.ok(section, 'city-grid.js builds seawallPolygon');
    const context = { MANHATTAN_COASTLINE: config.MANHATTAN_COASTLINE };
    vm.runInNewContext(`${code}\nthis.polygonScan = polygonScan; this.seawall = ${section[1]};`, context);
    seawallCache = context;
  }
  return seawallCache;
}

test('the seawall is the coastline pushed 6 m out along its normals, as one simple outline', () => {
  const coast = config.MANHATTAN_COASTLINE;
  const wall = seawall().seawall;
  assert.deepEqual(selfCrossings(wall), [], 'no loops left for the extrusion to triangulate');
  // its face stands 6 m off the shore, further only round mitred corners
  let near = Infinity, far = 0;
  for (let i = 0, j = wall.length - 1; i < wall.length; j = i++) {
    const a = wall[j], b = wall[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    for (let t = 0; t < len; t += 2) {
      const d = outlineDistance(coast, a.x + ((b.x - a.x) * t) / len, a.z + ((b.z - a.z) * t) / len);
      near = Math.min(near, d);
      far = Math.max(far, d);
    }
  }
  assert.ok(near > 5.99 && far < 18, `face 6 m out (${near.toFixed(2)}..${far.toFixed(2)} m)`);
  // the coping carries on beyond the road deck along every stretch of shore, whichever way it faces
  for (const out of [0.5, 5.9]) {
    const off = edgeSamples(coast, out).filter((p) => !inside(wall, p.x, p.z));
    assert.equal(off.length, 0, `${off.length} points ${out} m off the deck's edge over open water, e.g. ${JSON.stringify(off[0])}`);
  }
});

test('the seawall scanlines agree with the plain point-in-polygon test', () => {
  const { seawall: wall, polygonScan } = seawall();
  const scan = polygonScan(wall);
  let x = 0.37, z = 0.71;
  for (let i = 0; i < 4000; i++) {
    x = (x * 9301 + 49297) % 233280;
    z = (z * 7919 + 104729) % 233280;
    const px = -2300 + (x / 233280) * 4400, pz = -7000 + (z / 233280) * 13600;
    assert.equal(scan.inside(px, pz), inside(wall, px, pz), `at ${px.toFixed(1)}, ${pz.toFixed(1)}`);
    const cs = scan.crossings(pz);
    assert.equal(cs.filter((c) => c < px).length % 2 === 1, inside(wall, px, pz));
  }
});

// The production waterfront edge, its viaduct & underpass portal stood in for; returns the pieces on the coping
let waterfrontCache;
function waterfront() {
  if (!waterfrontCache) waterfrontCache = buildWaterfront();
  return waterfrontCache;
}
function buildWaterfront() {
  const { seawall: wall } = seawall();
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    setY(y) { this.y = y; return this; }
    subVectors(a, b) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
    crossVectors(a, b) { return this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
    normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; return this.set(this.x / l, this.y / l, this.z / l); }
    negate() { return this.set(-this.x, -this.y, -this.z); }
    multiplyScalar(s) { return this.set(this.x * s, this.y * s, this.z * s); }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    lerpVectors(a, b, t) { return this.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
  }
  const meshes = [];
  const instances = [];
  const geometry = () => ({ attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, setIndex() {}, translate() { return this; }, rotateX() { return this; } });
  const material = (name) => () => ({ name });
  const THREE = {
    Vector3,
    Color: class { constructor(c) { this.r = (c >> 16) / 255; this.g = ((c >> 8) & 255) / 255; this.b = (c & 255) / 255; } },
    BufferGeometry: function () { return geometry(); },
    Float32BufferAttribute: class { constructor(array) { this.array = array; } },
    BufferAttribute: class { constructor(array) { this.array = array; } },
    Mesh: class { constructor(g, m) { this.geometry = g; this.material = m; meshes.push(this); } },
    InstancedMesh: class {
      constructor(g, m) { this.material = m; this.spots = []; this.instanceMatrix = {}; instances.push(this); }
      setMatrixAt(i, m) { this.spots[i] = m; }
      computeBoundingSphere() {}
    },
    MeshStandardNodeMaterial: class { constructor(o) { Object.assign(this, o); } },
    CylinderGeometry: function () { return geometry(); },
    BoxGeometry: function () { return geometry(); },
    SphereGeometry: function () { return geometry(); },
    PlaneGeometry: function () { return geometry(); },
    Object3D: class {
      constructor() { this.position = new Vector3(); this.rotation = new Vector3(); }
      updateMatrix() { this.matrix = this.position.clone(); }
    },
    Matrix4: class { makeTranslation(x, y, z) { return new Vector3(x, y, z); } }
  };
  const context = {
    THREE, GEO, Math, fdrViaduct: null,
    getIslandBoundsAtZ: config.getIslandBoundsAtZ, streetZ: config.streetZ, CUT_Z: config.CUT_Z,
    EAST_RIVER_BRIDGES: config.EAST_RIVER_BRIDGES, WATERFRONT_PIERS: config.WATERFRONT_PIERS,
    MANHATTAN_COASTLINE: config.MANHATTAN_COASTLINE,
    mergeGeometries: geometry,
    createParkWallMaterial: material('wall'), createIronFenceMaterial: material('railing'),
    createParkLampGlobeMaterial: material('globe'), createParkLampPoolMaterial: material('pool'),
    createRoadPaintMaterial: material('paint'),
    buildSouthStreetViaduct: () => ({ keepOut: () => false, colliders: [], portalMats: {}, lane: () => [] }),
    buildUnderpassPortal: () => {}
  };
  vm.runInNewContext(['polygonScan', 'coastlineScan', 'waterfrontPierLayout', 'buildManhattanWaterfrontEdge'].map(gridFunction).join('\n'), context);
  // The raised sidewalk slabs it measures the shore strip to, as section 4 of buildCityGrid lays them
  const slab = (x0, x1, z0, z1, block) => ({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, block });
  const blockSidewalks = config.BLOCKS.filter((b) => !(b.park > 0.6 && !b.median && b.parkName !== 'Bryant Park'))
    .flatMap((b) => (b.rect ? [slab(b.minX, b.maxX, b.minZ, b.maxZ, b)] : b.rects.map(([x0, x1, z0, z1]) => slab(x0 - 4.4, x1 + 4.4, z0 - 4.4, z1 + 4.4, b))));
  const treeSites = [];
  context.buildManhattanWaterfrontEdge({ add() {} }, { blockSidewalks, treeSites, lawnMat: {}, curbMat: {}, roadMat: {}, seawall: wall });
  const positions = (name) => meshes.find((m) => m.material.name === name).geometry.attributes.position.array;
  const points = (array, keep) => {
    const out = [];
    for (let i = 0; i < array.length; i += 3) if (keep(array[i + 1])) out.push({ x: array[i], y: array[i + 1], z: array[i + 2] });
    return out;
  };
  return {
    wall,
    railingFeet: points(positions('railing'), (y) => y < 0),
    copingPaint: points(positions('paint'), (y) => y < 0),
    lamps: instances.find((m) => m.material.name === 'globe' && m.spots[0].y < 0).spots,
    copingTrees: treeSites.filter((t) => t.y < 0)
  };
}

test('the esplanade on the coping stands on the seawall, its railing along the seawall\'s face', () => {
  const { wall, railingFeet, copingPaint, lamps, copingTrees } = waterfront();
  for (const [name, pts, least] of [['railing', railingFeet, 10000], ['greenway paint', copingPaint, 50000], ['lamp', lamps, 500], ['tree', copingTrees, 500]]) {
    assert.ok(pts.length > least, `the esplanade has its ${name}s (${pts.length})`);
    const off = pts.filter((p) => !inside(wall, p.x, p.z));
    assert.equal(off.length, 0, `${off.length} ${name} points over the water, e.g. ${JSON.stringify(off[0])}`);
  }
  // 0.2 m in from the face wherever the coping runs straight, so the railing follows the seawall round every bend
  const gaps = railingFeet.filter((_, i) => i % 5 === 0).map((p) => outlineDistance(wall, p.x, p.z)).sort((a, b) => a - b);
  assert.ok(gaps[Math.floor(gaps.length * 0.5)] < 0.3, `median ${gaps[Math.floor(gaps.length * 0.5)].toFixed(2)} m from the face`);
  assert.ok(gaps[Math.floor(gaps.length * 0.95)] < 0.5, `95% within ${gaps[Math.floor(gaps.length * 0.95)].toFixed(2)} m of the face`);
});

// ---- The waterfront piers' decks -----------------------------------------------------------------------------------
// The production pier layouts (waterfrontPierLayout): each pier's body deck and the root slabs beside it
let layoutsCache;
function pierLayouts() {
  if (!layoutsCache) {
    const context = { getIslandBoundsAtZ: config.getIslandBoundsAtZ, MANHATTAN_COASTLINE: config.MANHATTAN_COASTLINE, Math };
    const code = ['polygonScan', 'coastlineScan', 'waterfrontPierLayout'].map(gridFunction).join('\n');
    vm.runInNewContext(`${code}\nthis.layout = waterfrontPierLayout;`, context);
    layoutsCache = config.WATERFRONT_PIERS.map((p) => ({ p, ...context.layout(p) }));
  }
  return layoutsCache;
}
const onAnyDeck = (x, z) => pierLayouts().some((l) => l.footprints.some((poly) => inside(poly, x, z)));
function boundsOf(pts) {
  const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const q of pts) { b.x0 = Math.min(b.x0, q.x); b.x1 = Math.max(b.x1, q.x); b.z0 = Math.min(b.z0, q.z); b.z1 = Math.max(b.z1, q.z); }
  return b;
}

test('every pier\'s outline is decked: its body and the roots beside it (the Chelsea Piers headhouse band, Pier 26\'s wide root)', () => {
  const { seawall: wall, polygonScan } = seawall();
  const land = polygonScan(config.MANHATTAN_COASTLINE), coping = polygonScan(wall);
  let open = 0;
  for (const { p, footprints } of pierLayouts()) {
    if (p.kind === 'vent' || p.kind === 'littleIsland') continue; // Pier 34's twin walkways, Little Island's pots
    const b = boundsOf(p.ring);
    let area = 0, water = 0;
    for (let x = Math.floor(b.x0) + 0.5; x < b.x1; x++) {
      for (let z = Math.floor(b.z0) + 0.5; z < b.z1; z++) {
        if (!inside(p.ring, x, z)) continue;
        area++;
        if (!footprints.some((poly) => inside(poly, x, z)) && !land.inside(x, z) && !coping.inside(x, z)) water++;
      }
    }
    assert.ok(water <= area * 0.03, `${p.name}: ${water} of its ${area} m² left as open water`);
    open += water;
  }
  assert.ok(open < 1000, `${open} m² of the piers' outlines left as open water`);
});

test('the esplanade along the bulkhead breaks for every pier deck instead of running across it', () => {
  const { railingFeet, lamps, copingTrees } = waterfront();
  for (const [name, pts] of [['railing', railingFeet], ['lamp', lamps], ['tree', copingTrees]]) {
    const on = pts.filter((q) => onAnyDeck(q.x, q.z));
    assert.equal(on.length, 0, `${on.length} esplanade ${name} points on a pier deck, e.g. ${JSON.stringify(on[0])}`);
  }
});

test('Pier 62\'s deck ends along the shore its root runs beside instead of reaching over the land', () => {
  const pier = pierLayouts().find((l) => l.p.name.startsWith('Pier 62'));
  assert.ok(pier.lands, 'its landward end follows the coastline');
  const land = seawall().polygonScan(config.MANHATTAN_COASTLINE);
  const body = pier.footprints[0];
  const b = boundsOf(body);
  let over = 0;
  for (let x = Math.floor(b.x0) + 0.5; x < b.x1; x++) {
    for (let z = Math.floor(b.z0) + 0.5; z < b.z1; z++) if (inside(body, x, z) && land.inside(x, z)) over++;
  }
  assert.ok(over < 250, `${over} m² of its deck over the land`);
});

// ---- Little Island -------------------------------------------------------------------------------------------------
test('Little Island\'s concrete skirt faces out from the park all round', () => {
  const head = 'kinds.littleIsland = (F) => {';
  const start = gridSource.indexOf(head);
  assert.ok(start >= 0, 'city-grid.js builds Little Island');
  const code = braced(gridSource, start, start + head.length - 1);
  // PlaneGeometry's vertex order (row by row from -height/2, x from -width/2), rotated flat by rotateX(-PI / 2)
  class PlaneGeometry {
    constructor(w, h, nx, ny) {
      this.v = [];
      for (let iy = 0; iy <= ny; iy++) for (let ix = 0; ix <= nx; ix++) this.v.push([(ix * w) / nx - w / 2, -((iy * h) / ny - h / 2), 0]);
      const v = this.v;
      this.attributes = { position: { count: v.length, getX: (i) => v[i][0], getY: (i) => v[i][1], getZ: (i) => v[i][2], setXYZ: (i, x, y, z) => { v[i] = [x, y, z]; } } };
    }
    rotateX() { this.v.forEach((p, i) => { this.v[i] = [p[0], p[2], -p[1]]; }); return this; }
    computeVertexNormals() {}
  }
  class BufferGeometry {
    setAttribute(k, v) { this[k] = v; }
    computeVertexNormals() {}
  }
  const skirts = [];
  const pier = config.WATERFRONT_PIERS.find((p) => p.kind === 'littleIsland');
  assert.ok(pier, 'Little Island is one of the waterfront piers');
  const F = {
    L: pier.length, hw: pier.width / 2, u0: -2,
    geo: (mat, g) => { if (g instanceof BufferGeometry) skirts.push(g.position.array); },
    tree() {}, strut() {}
  };
  let seed = 7;
  vm.runInNewContext(`const kinds = {};\n${code}\nkinds.littleIsland(F);`, {
    F, GR: 0, BL: 1, PA: 2, DY: 0.12, rnd: () => (seed = (seed * 16807) % 2147483647) / 2147483647, Math,
    THREE: { PlaneGeometry, BufferGeometry, Float32BufferAttribute: class { constructor(a) { this.array = a; } }, LatheGeometry: class {}, Vector2: class {} }
  });
  assert.equal(skirts.length, 1);
  const p = skirts[0];
  let cx = 0, cz = 0;
  for (let i = 0; i < p.length; i += 3) { cx += p[i]; cz += p[i + 2]; }
  cx /= p.length / 3;
  cz /= p.length / 3;
  let outward = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    // front face normal (counter-clockwise winding), also what computeVertexNormals gives a non-indexed triangle
    const nx = ay * bz - az * by, nz = ax * by - ay * bx;
    const mx = (p[i] + p[i + 3] + p[i + 6]) / 3 - cx, mz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3 - cz;
    if (nx * mx + nz * mz > 0) outward++;
  }
  assert.equal(outward, p.length / 9, `${outward} of ${p.length / 9} skirt triangles face outward`);
});
