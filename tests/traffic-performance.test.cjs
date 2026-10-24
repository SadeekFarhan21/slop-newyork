const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');
function productionFunction(name, context) {
  const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[0].trim()})`, context);
}

for (const [hasView, inView, draw] of [[true, false, false], [true, true, true], [false, false, true]]) {
  test(`pedestrian gait always advances; pose generation follows drawing (${hasView}, ${inView})`, () => {
    let args, drawn = 0;
    const ped = { x: 10, z: 20, ux: 0, uz: 1, dir: 1, rig: { update(...values) { args = values; } } };
    const renderPed = productionFunction('renderPed', {
      hasView, visible: () => inView, pedGround: () => 0, focusX: 0, focusZ: 0,
      pedCrowd: { add(rig) { assert.equal(rig, ped.rig); drawn++; } }
    });
    renderPed(ped, 1 / 60);
    assert.equal(args[0], 1 / 60);
    assert.equal(args[1], ped.x);
    assert.equal(args[2], ped.z);
    assert.equal(args[5], ped);
    assert.equal(args[7], draw);
    assert.equal(drawn, draw ? 1 : 0);
  });
}

function sparkHarness(updates = 3) {
  const sparks = Array.from({ length: 120 }, () => ({ life: 0 }));
  const writes = [];
  const zero = { zero: true };
  const dummy = { matrix: {} };
  for (const key of ['position', 'rotation', 'scale']) dummy[key] = { set(...values) { dummy.matrix[key] = values; } };
  dummy.updateMatrix = () => {};
  let uploads = 0, range = 0;
  const attr = {
    itemSize: 16,
    clearUpdateRanges() { range = 0; },
    addUpdateRange(offset, count) { assert.equal(offset, 0); range = count; },
    set needsUpdate(value) { if (value) uploads++; }
  };
  const sparkInst = {
    instanceMatrix: attr,
    setMatrixAt(index, matrix) { writes.push({ index, matrix: JSON.parse(JSON.stringify(matrix)) }); }
  };
  const context = { MAX_SPARKS: 120, sparks, sparkInst, dummy, zero, updates };
  const flag = productionFunction('flagRange', {});
  context.flagRange = flag;
  return {
    sparks, writes, sparkInst,
    update: productionFunction('updateSparks', context),
    uploads: () => uploads,
    range: () => range
  };
}

test('idle collision sparks write and upload nothing after warm-up', () => {
  const h = sparkHarness();
  for (let frame = 0; frame < 60; frame++) h.update(1 / 60);
  assert.equal(h.writes.length, 0);
  assert.equal(h.uploads(), 0);
  assert.equal(h.sparkInst.count, 0);
  assert.equal(h.sparkInst.visible, false);
});

for (const frame of [1, 2]) {
  test(`spark shader warm-up keeps one degenerate visible instance on frame ${frame}`, () => {
    const h = sparkHarness(frame);
    h.update(1 / 60);
    assert.deepEqual(h.writes, [{ index: 0, matrix: { zero: true } }]);
    assert.equal(h.sparkInst.count, 1);
    assert.equal(h.sparkInst.visible, true);
    assert.equal(h.range(), 16);
  });
}

test('live sparks preserve motion, bounce and fade while packing only live matrices', () => {
  const h = sparkHarness();
  h.sparks[13] = { x: 2, y: 0.04, z: 3, vx: 1, vy: -2, vz: 4, life: 0.1, maxLife: 0.4 };
  h.sparks[80] = { x: 0, y: 2, z: 0, vx: 0, vy: 3, vz: 0, life: 0.2, maxLife: 0.4 };
  h.update(0.05);
  const bounced = h.sparks[13];
  assert.equal(bounced.x, 2.05);
  assert.equal(bounced.y, 0.03);
  assert.equal(bounced.z, 3.2);
  assert.equal(bounced.vx, 0.78);
  assert.equal(bounced.vz, 3.12);
  assert.ok(Math.abs(bounced.vy - 1.395) < 1e-12);
  assert.ok(Math.abs(h.sparks[80].y - 2.095) < 1e-12);
  assert.deepEqual(h.writes.map((write) => write.index), [0, 1]);
  assert.deepEqual(h.writes[0].matrix.position, [2.05, 0.03, 3.2]);
  assert.equal(h.writes[0].matrix.scale[0], 0.125);
  assert.equal(h.writes[0].matrix.scale[1], 0.125);
  assert.equal(h.sparkInst.count, 2);
  assert.equal(h.range(), 32);
  assert.equal(h.uploads(), 1);
  // An expiring particle retains the original zero-life fade on its last simulated frame, then disappears.
  h.update(0.2);
  assert.equal(h.sparkInst.count, 2);
  assert.equal(h.writes.at(-1).matrix.scale[0], 0);
  const uploads = h.uploads();
  h.update(1 / 60);
  assert.equal(h.sparkInst.count, 0);
  assert.equal(h.sparkInst.visible, false);
  assert.equal(h.uploads(), uploads);
});

// The highway lamp flares (createHighwayTraffic) as built, with a recording attribute in place of the GPU buffer
function flareHarness() {
  const block = source.match(/^ {2}const flarePos = new Float32Array[\s\S]*?^ {2}showFlares\(true\);$/m)?.[0];
  assert.ok(block, 'the flare setup is present');
  const uploads = [];
  class InstancedBufferAttribute {
    constructor(array, itemSize) { Object.assign(this, { array, itemSize, range: 0 }); }
    clearUpdateRanges() { this.range = 0; }
    addUpdateRange(offset, count) { assert.equal(offset, 0); this.range = count; }
    set needsUpdate(value) { if (value) uploads.push({ attribute: this, range: this.range }); }
  }
  const THREE = {
    InstancedBufferAttribute,
    PlaneGeometry: class { constructor() { this.attributes = {}; } setAttribute(name, a) { this.attributes[name] = a; } },
    Mesh: class { constructor(geometry, material) { Object.assign(this, { geometry, material, visible: true }); } }
  };
  const context = {
    THREE, cars: [{}, {}, {}], group: { add() {} }, createCarFlareMaterial: () => ({}),
    flagRange: productionFunction('flagRange', {})
  };
  const h = vm.runInNewContext(`(() => {\n${block}\nreturn { flares, flarePos, flareCol, addFlare, showFlares, reset: () => { flareCount = 0; } };\n})()`, context);
  return { ...h, uploads };
}

test('highway lamp flares are drawn from the start, empty, so the shader warm-up compiles them', () => {
  const h = flareHarness();
  assert.equal(h.flares.visible, true);
  assert.equal(h.flares.count, 1);
  assert.deepEqual([...h.flarePos.slice(0, 4)], [0, 0, 0, 0], 'a zero-size flare');
  assert.deepEqual([...h.flareCol.slice(0, 3)], [0, 0, 0], 'adding no light');
  assert.deepEqual(h.uploads.map((u) => u.range), [4, 4]);
});

test('by day the flares stay drawn through the warm-up frames, then hide and upload nothing', () => {
  const h = flareHarness();
  h.flarePos.fill(7); // whatever earlier nights left behind
  for (const warming of [true, true]) {
    h.reset();
    h.showFlares(warming);
    assert.equal(h.flares.visible, true);
    assert.equal(h.flares.count, 1);
    assert.equal(h.flarePos[3], 0, 'the stand-in is always empty');
  }
  const uploads = h.uploads.length;
  for (let frame = 0; frame < 30; frame++) {
    h.reset();
    h.showFlares(false);
  }
  assert.equal(h.flares.visible, false);
  assert.equal(h.flares.count, 0);
  assert.equal(h.uploads.length, uploads);
});

test('at night every flare added is drawn and uploaded, with no stand-in', () => {
  const h = flareHarness();
  for (const warming of [true, false]) {
    h.reset();
    h.addFlare(1, 2, 3, 0.8, 4, 4, 3);
    h.addFlare(5, 6, 7, 0.8, 3, 0.2, 0.1);
    h.showFlares(warming);
    assert.equal(h.flares.visible, true);
    assert.equal(h.flares.count, 2);
    assert.deepEqual([...h.flarePos.slice(0, 4)], [1, 2, 3, Math.fround(0.8)]);
    assert.deepEqual(h.uploads.slice(-2).map((u) => u.range), [8, 8]);
  }
});

test('the highway traffic keeps the flares warming for exactly the frames its meshes stay drawn', () => {
  assert.match(source, /const hideEmpty = \+\+updates > 2;\n {4}for \(const kind of KINDS\) \{[^]*?\n {4}showFlares\(!hideEmpty\);\n/);
});
