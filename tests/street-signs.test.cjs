const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadModule } = require('./helpers/module.cjs');

// The blades are checked against the real city: js/nyc-geodata.js through js/city-config.js, with only the renderer
// side of js/street-details.js stubbed out (the naming & atlas helpers need no canvas or GPU).
const read = (file) => readFileSync(join(__dirname, '../js', file), 'utf8');
const geo = loadModule(read('nyc-geodata.js'), { filename: 'nyc-geodata.js' });
const config = loadModule(read('city-config.js'), { imports: { './nyc-geodata.js': geo }, filename: 'city-config.js' });
const source = read('street-details.js');
const signs = loadModule(source, {
  imports: {
    'three/webgpu': {},
    'three/tsl': {},
    'three/addons/utils/BufferGeometryUtils.js': {},
    './city-config.js': config,
    './tsl-materials.js': {},
    './trees.js': {},
    './city-grid.js': {},
    './landmarks.js': {}
  },
  filename: 'street-details.js'
});
const { streetSignText, streetSignLength, cornerSignBlades, planStreetSignAtlas, drawStreetSignAtlas } = signs;
const { AVENUES, ALL_AVENUES, STREETS, avenueX, avenueNameAt, getBroadwayX, nearestRoads } = config;

const BLADE_H = 0.34;
const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} should equal ${expected}`);

// Every corner the signal masts stand on (street-details.js section 1): NE & SW of each AVENUES x STREETS crossing
const CORNERS = [{ sx: 1, sz: -1, armDir: -1 }, { sx: -1, sz: 1, armDir: 1 }];
const masts = [];
for (const ave of AVENUES) {
  for (const st of STREETS) {
    for (const corner of CORNERS) {
      const px = ave.x + corner.sx * (ave.width * 0.5 + 1.25);
      const pz = st.z + corner.sz * (st.width * 0.5 + 1.25);
      masts.push({ ave, st, corner, px, pz, blades: cornerSignBlades(ave, st, px, pz, corner) });
    }
  }
}
const allTexts = masts.flatMap((m) => m.blades.map((b) => b.text));
const crossesBroadway = (m) => (m.ave.x === avenueX('7') && m.st.number === 45) || (m.ave.x === avenueX('6') && m.st.number === 34);

test('legends are lettered like NYC DOT blades: capitals, AV, no ordinals, named streets as they are', () => {
  const cases = {
    '5th Ave': '5 AV',
    'Park Ave S': 'PARK AV S',
    'Lexington Ave': 'LEXINGTON AV',
    'W 34th St': 'W 34 ST',
    'E 1st St': 'E 1 ST',
    'East 42nd Street': 'E 42 ST',
    'Broadway': 'BROADWAY',
    'Wall St': 'WALL ST',
    'E Houston St': 'E HOUSTON ST',
    'Avenue of the Americas': 'AV OF THE AMERICAS',
    'East End Ave': 'EAST END AV',
    'St Nicholas Ave': 'ST NICHOLAS AV',
    'Frederick Douglass Blvd': 'FREDERICK DOUGLASS BLVD',
    'Ave A': 'AV A'
  };
  for (const [name, text] of Object.entries(cases)) assert.equal(streetSignText(name), text, name);
});

test('every signal mast names its own cross street, East or West of 5th Ave, as the real street centreline does', () => {
  const fifth = avenueX('5');
  for (const m of masts) {
    const street = m.blades[0];
    assert.equal(street.text, `${m.px < fifth ? 'W' : 'E'} ${m.st.number} ST`);
    // The nearest street centreline at the mast (NYC CSCL names, East / West split at 5th Ave) reads the same
    const road = nearestRoads(m.px, m.pz, 40).find((r) => r.horizontal);
    assert.equal(streetSignText(road.road.name), street.text, `${m.ave.name} & ${m.st.name}`);
  }
  const at = (aveName, n, sx) => masts.find((m) => m.ave.name === aveName && m.st.number === n && m.corner.sx === sx);
  assert.equal(at('5th Ave', 42, 1).blades[0].text, 'E 42 ST');
  assert.equal(at('5th Ave', 42, -1).blades[0].text, 'W 42 ST');
  assert.equal(at('5th Ave', 34, -1).blades[0].text, 'W 34 ST');
  assert.equal(at('Lexington Ave', 53, 1).blades[0].text, 'E 53 ST');
  assert.ok(!allTexts.some((t) => t.includes('·') || t.includes('5TH AVE')), 'no placeholder legend is left');
});

test('every signal mast names the avenue it stands on, by its name at that street', () => {
  let checked = 0;
  for (const m of masts) {
    const named = ALL_AVENUES.find((a) => a.segs && Math.abs(a.x - m.ave.x) < 1);
    assert.equal(m.blades[1].text, streetSignText(avenueNameAt(named, m.st.z)));
    // Wherever the avenue's own centreline is in reach (all but Park Ave on the Grand Central viaduct at 45th St), its
    // real name agrees
    const road = nearestRoads(m.px, m.pz, 20).find((r) => / AV( |$)/.test(streetSignText(r.road.name)));
    if (!road) continue;
    assert.equal(streetSignText(road.road.name), m.blades[1].text, `${m.ave.name} & ${m.st.name}`);
    checked++;
  }
  assert.ok(checked >= masts.length - 4, `${checked} of ${masts.length} corners checked against the centreline`);
  const avenueAt = (aveName, n) => masts.find((m) => m.ave.name === aveName && m.st.number === n).blades[1].text;
  assert.equal(avenueAt('5th Ave', 42), '5 AV');
  assert.equal(avenueAt('6th Ave', 42), '6 AV');
  assert.equal(avenueAt('7th Ave / Broadway', 53), '7 AV');
  assert.equal(avenueAt('Park Ave', 42), 'PARK AV');
  assert.equal(avenueAt('Park Ave', 28), 'PARK AV S', 'Park Avenue South below 32nd St');
  assert.equal(avenueAt('Lexington Ave', 23), 'LEXINGTON AV');
});

test('two perpendicular blades per mast, each parallel to the street it names and fixed to the mast', () => {
  for (const m of masts) {
    const [street, avenue] = m.blades;
    close(Math.sin(street.yaw), 0); // long axis along x, like the cross street
    close(Math.cos(avenue.yaw), 0); // long axis along z, like the avenue
    for (const b of m.blades) {
      // the long axis runs through the mast, the inner end flush with it, the outer end over the corner
      const ux = Math.cos(b.yaw);
      const uz = -Math.sin(b.yaw);
      close((b.x - m.px) * uz - (b.z - m.pz) * ux, 0);
      const along = (b.x - m.px) * ux + (b.z - m.pz) * uz;
      close(along - b.length * 0.5, 0.12, 1e-9);
      close(b.length, streetSignLength(b.text));
    }
    assert.ok(street.x * m.corner.armDir > m.px * m.corner.armDir, 'the street blade reaches toward the avenue');
    assert.ok((avenue.z - m.pz) * m.corner.sz < 0, 'the avenue blade reaches toward the cross street');
    for (let i = 1; i < m.blades.length; i++) assert.ok(m.blades[i].y - m.blades[i - 1].y > BLADE_H, 'stacked blades do not overlap');
  }
});

test('Broadway gets a blade along its own diagonal where it crosses the intersection (Times & Herald Squares)', () => {
  for (const m of masts) {
    assert.equal(m.blades.length, crossesBroadway(m) ? 3 : 2, `${m.ave.name} & ${m.st.name}`);
    if (!crossesBroadway(m)) continue;
    const b = m.blades[2];
    assert.equal(b.text, 'BROADWAY');
    const dx = getBroadwayX(m.st.z + 5) - getBroadwayX(m.st.z - 5);
    const len = Math.hypot(dx, 10);
    const ux = Math.cos(b.yaw);
    const uz = -Math.sin(b.yaw);
    assert.ok(Math.abs(ux * (10 / len) - uz * (dx / len)) < Math.sin((2 * Math.PI) / 180), 'parallel to the centreline');
    assert.ok(ux * (m.ave.x - m.px) + uz * (m.st.z - m.pz) > 0, 'reaching into the intersection');
  }
});

test('blades are cut to their names, within the atlas cell', () => {
  const short = streetSignLength('5 AV');
  const street = streetSignLength('W 42 ST');
  const long = streetSignLength('LEXINGTON AV');
  assert.ok(short < street && street < long, `${short} < ${street} < ${long}`);
  assert.ok(short >= 0.6 && long <= 1.7);
  close(streetSignLength('ADAM CLAYTON POWELL JR BLVD'), 1.7, 1e-12); // the longest names condense onto the longest blade
  assert.equal(streetSignLength('I'), 0.6);
});

function assertAtlas(texts, plan) {
  const names = [...new Set(texts)];
  assert.equal(plan.cells.size, names.length, 'one cell per distinct name');
  assert.ok(plan.width <= 4096 && plan.height <= 4096, `${plan.width}x${plan.height} fits a 4096 texture`);
  const taken = new Set();
  for (const name of names) {
    const c = plan.cells.get(name);
    assert.equal(c.text, name);
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + plan.cellW <= plan.width && c.y + plan.cellH <= plan.height, 'inside the atlas');
    assert.equal(c.x % plan.cellW, 0);
    assert.equal(c.y % plan.cellH, 0);
    const key = `${c.x},${c.y}`;
    assert.ok(!taken.has(key), 'cells never overlap');
    taken.add(key);
    assert.ok(c.w > 0 && c.w <= plan.cellW + 1e-9 && c.h === plan.cellH);
    close(c.w / c.length, plan.cellH / BLADE_H, 1e-6); // square texels at the blade's length
  }
  assert.equal(plan.rects.length, texts.length * 4);
  texts.forEach((text, i) => {
    const c = plan.cells.get(text);
    const [u, v, du, dv] = plan.rects.subarray(i * 4, i * 4 + 4);
    // the blade's uv 0..1 lands exactly on its name's art: v counts up from the bottom, canvas rows down from the top
    close(u * plan.width, c.x, 1e-3);
    close((u + du) * plan.width, c.x + c.w, 1e-3);
    close((1 - v - dv) * plan.height, c.y, 1e-3);
    close((1 - v) * plan.height, c.y + c.h, 1e-3);
    assert.ok(u >= 0 && v >= 0 && u + du <= 1 + 1e-6 && v + dv <= 1 + 1e-6);
  });
}

test('one atlas cell per distinct name, and each blade instance points at its own name', () => {
  const plan = planStreetSignAtlas(allTexts);
  assertAtlas(allTexts, plan);
  assert.equal(plan.cellW, 640, 'the city keeps full-resolution cells');
  assert.equal(plan.cellH, 128);
  assert.ok(plan.cells.size >= 25 && plan.cells.size <= 30, `${plan.cells.size} names`);
  // single-channel coverage plus mipmaps
  assert.ok((plan.width * plan.height * 4) / 3 < 4 * 1024 * 1024, 'the atlas stays a few megabytes');
  assert.deepEqual(planStreetSignAtlas(allTexts).rects, plan.rects, 'the layout is deterministic');
});

test('a city of names still fits the atlas, on smaller cells', () => {
  const texts = Array.from({ length: 3000 }, (_, i) => `W ${i} ST`);
  texts.push('W 7 ST', 'W 7 ST');
  const plan = planStreetSignAtlas(texts);
  assert.ok(plan.cellH < 128);
  assertAtlas(texts, plan);
  assertAtlas(['BROADWAY'], planStreetSignAtlas(['BROADWAY']));
});

// A 2D context that records the lettering (a font whose capitals are 0.7 em and whose advance is `em` per character)
function recordingContext(em) {
  const fills = [];
  let strokes = 0;
  let transform = [1, 0, 0, 1, 0, 0];
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    size: () => Number(/([\d.]+)px/.exec(ctx.font)[1]),
    setTransform: (...m) => { transform = m; },
    fillRect() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    closePath() {},
    stroke: () => { strokes++; },
    measureText: (text) => ({ width: text.length * em * ctx.size(), actualBoundingBoxAscent: 0.7 * ctx.size() }),
    fillText: (text, x, y) => fills.push({ text, x, y, transform, size: ctx.size(), align: ctx.textAlign, baseline: ctx.textBaseline })
  };
  return { ctx, fills, strokes: () => strokes };
}

for (const em of [0.6, 1.3]) {
  test(`each legend is lettered inside its own blade's border (${em} em per character)`, () => {
    const plan = planStreetSignAtlas(allTexts);
    const { ctx, fills, strokes } = recordingContext(em);
    drawStreetSignAtlas(ctx, plan);
    assert.equal(fills.length, plan.cells.size);
    assert.equal(strokes(), plan.cells.size, 'a border per blade');
    const clear = 12; // the white border takes the outer 9 px
    for (const f of fills) {
      const c = plan.cells.get(f.text);
      assert.equal(f.align, 'center');
      assert.equal(f.baseline, 'alphabetic');
      const [condense, , , scaleY, tx, ty] = f.transform;
      assert.ok(condense > 0 && condense <= 0.76, 'condensed capitals');
      assert.equal(scaleY, 1);
      const cx = tx + f.x * condense;
      const half = (f.text.length * em * f.size * condense) / 2;
      assert.ok(cx - half >= c.x + clear && cx + half <= c.x + c.w - clear, `${f.text} fits its blade`);
      const baseline = ty + f.y;
      const capTop = baseline - 0.7 * f.size; // (the font size is given to 0.01 px)
      close(baseline - capTop, c.h / 2, 0.01); // capitals half the blade's height
      assert.ok(capTop >= c.y + clear && baseline <= c.y + c.h - clear, `${f.text} sits inside the border`);
      close(capTop - c.y, c.y + c.h - baseline, 0.01); // centred
    }
  });
}

test('tree grates keep their own unit scale and turn after narrowed, turned tree pits', () => {
  const start = source.indexOf('  const gratedTrees = sidewalkTreePositions.filter(');
  const end = source.indexOf('  pitCurbInst.instanceMatrix.needsUpdate = true;', start);
  assert.ok(start > 0 && end > start, 'the tree pit & grate placement is present');
  class InstancedMesh {
    constructor(geometry, material, count) {
      Object.assign(this, { geometry, material, count, matrices: [] });
    }
    setMatrixAt(i, m) { this.matrices[i] = m; }
  }
  const vector = () => ({ set(x, y, z) { Object.assign(this, { x, y, z }); return this; } });
  const dummy = {
    position: vector(), rotation: vector(), scale: vector(), matrix: null,
    updateMatrix() {
      const copy = (v) => ({ x: v.x, y: v.y, z: v.z });
      this.matrix = { position: copy(this.position), rotation: copy(this.rotation), scale: copy(this.scale) };
    }
  };
  const sidewalkTreePositions = [
    { x: 10, z: 20 }, // an avenue tree: full pit with a grate
    { x: 30, z: 40, pitRot: Math.PI / 2, grate: false, pitS: 0.7 } // a narrow side street's: turned & narrowed, no grate
  ];
  const parts = { pitCurbGeo: {}, pitSoilGeo: {}, pitGrateGeo: {}, pitCurbMat: {}, pitSoilMat: {}, grateMat: {} };
  const run = vm.runInNewContext(`(function () {
    ${source.slice(start, end)}
    return { pitCurbInst, pitSoilInst, pitGrateInst };
  })`, { THREE: { InstancedMesh }, dummy, sidewalkTreePositions, ...parts });
  const { pitCurbInst, pitSoilInst, pitGrateInst } = run();
  for (const pits of [pitCurbInst, pitSoilInst]) {
    assert.deepEqual(pits.matrices[0].scale, { x: 1, y: 1, z: 1 });
    assert.deepEqual(pits.matrices[1].scale, { x: 0.7, y: 1, z: 1 });
    assert.equal(pits.matrices[1].rotation.y, Math.PI / 2);
  }
  assert.equal(pitGrateInst.count, 1);
  const grate = pitGrateInst.matrices[0];
  assert.deepEqual(grate.scale, { x: 1, y: 1, z: 1 }, 'the grate does not inherit the last pit\'s narrowing');
  assert.deepEqual(grate.rotation, { x: 0, y: 0, z: 0 });
  assert.deepEqual(grate.position, { x: 10, y: 0.225, z: 20 });
});
