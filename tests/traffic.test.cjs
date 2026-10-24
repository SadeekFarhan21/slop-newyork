const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');
// Exercise the production lane query and player snapshot without creating the WebGPU scene.
const laneQuery = source.match(/  function playerInLane\(lane, pl\) \{[\s\S]*?\n  \}/)?.[0];
const playerSnapshot = source.match(/    const pl = entity[\s\S]*?\n    \} : null;/)?.[0];
assert.ok(laneQuery, 'traffic lane query is present');
assert.ok(playerSnapshot, 'traffic player snapshot is present');
const { playerInLane, snapshot } = vm.runInNewContext(`
  ${laneQuery}
  function snapshot(entity, mode) {
    ${playerSnapshot}
    return pl;
  }
  ({ playerInLane, snapshot });
`);

function lane(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return {
    pts: points,
    cum,
    box: [Math.min(...points.map((p) => p.x)), Math.max(...points.map((p) => p.x)),
      Math.min(...points.map((p) => p.z)), Math.max(...points.map((p) => p.z))]
  };
}

function player(x, y, z, mode = 'car') {
  return snapshot({ position: { x, y, z }, heading: Math.PI / 2, speed: 10 }, mode);
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
}

test('street traffic recognizes players on its own road, including sidewalk height', () => {
  const road = lane([{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }]);
  for (const y of [0, 0.22]) {
    const result = playerInLane(road, player(50, y, 0));
    close(result.u, 50);
    close(result.v, 10);
  }
  assert.equal(playerInLane(road, player(50, 7.6, 0)), null);
  assert.equal(playerInLane(road, player(50, 0, 2.1)), null);
});

test('viaduct traffic ignores players below it and recognizes players at deck height', () => {
  const road = lane([{ x: 0, y: 7.6, z: 0 }, { x: 100, y: 7.6, z: 0 }]);
  assert.equal(playerInLane(road, player(50, 0, 0)), null);
  const result = playerInLane(road, player(50, 7.6, 0));
  close(result.u, 50);
  close(result.v, 10);
});

test('sloped lanes use horizontal projection and compare interpolated road height', () => {
  const road = lane([{ x: 0, y: 0, z: 0 }, { x: 100, y: 7.6, z: 0 }]);
  for (const t of [0, 0.5, 1]) {
    const result = playerInLane(road, player(100 * t, 7.6 * t, 0));
    close(result.u, road.cum[1] * t);
    close(result.v, road.cum[1] / 10);
  }
  assert.equal(playerInLane(road, player(50, 0, 0)), null);
  assert.equal(playerInLane(road, player(100.1, 7.6, 0)), null);
  assert.equal(playerInLane(road, player(50, 3.8, 2.001)), null);
});

test('overlapping road segments select the matching elevation', () => {
  const road = lane([{ x: 0, y: 7.6, z: 0 }, { x: 100, y: 7.6, z: 0 },
    { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]);
  const result = playerInLane(road, player(50, 0, 0));
  close(result.u, 157.6);
  close(result.v, 0);
});

test('underground lanes and helicopters remain excluded', () => {
  const road = lane([{ x: 0, y: -4.5, z: 0 }, { x: 100, y: -4.5, z: 0 }]);
  assert.equal(playerInLane(road, player(50, -4.5, 0)), null);
  assert.equal(player(50, 0, 0, 'helicopter'), null);
  assert.equal(snapshot(null, 'car'), null);
});

function trafficFunction(name, context) {
  const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[0].trim()})`, context);
}

function intersectionHarness() {
  const n = { signal: true, in: [] };
  const exit = { lanes: [0], outSide: 1 };
  const edge = { to: n, axisIndex: 0, occ: [[]], opposite: null, inSide: 0, len: 100 };
  const car = { edge, move: { to: exit, out: [0], turn: 'S' }, lane: 0, s: 80, speed: 4,
    driver: { b: 3 }, half: 2.25, wait: 0, commit: null, isPolice: false };
  const state = { phase: 'red', occupied: false, pedestrians: false, space: true, conflict: false };
  const context = {
    LOOKAHEAD: 70,
    phaseOf: () => state.phase,
    canStopBefore: () => true,
    stopAt: () => -3,
    boxBusy: () => state.occupied,
    ahead: () => null,
    connector: () => ({ len: 20 }),
    yieldToCrossTraffic: () => state.conflict,
    pedestrianOn: () => state.pedestrians,
    laneCoord: () => 0,
    timeTo: () => 1,
    room: () => state.space,
    alongside: () => false,
    mergingAhead: () => null,
    canGiveWay: () => true,
    waitedLonger: () => false
  };
  return { car, state, mayEnter: trafficFunction('mayEnter', context), signalAhead: trafficFunction('signalAhead', context) };
}

test('police pass red and amber signals while ordinary cars stop', () => {
  const { car, state, mayEnter, signalAhead } = intersectionHarness();
  for (const phase of ['red', 'amber']) {
    state.phase = phase;
    car.isPolice = false;
    assert.equal(mayEnter(car, 18), false);
    assert.equal(signalAhead(car, car.edge, 18), -3);
    car.isPolice = true;
    assert.equal(mayEnter(car, 18), true);
    assert.equal(signalAhead(car, car.edge, 18), 0);
  }
});

test('police still wait for crossing traffic, pedestrians and a blocked exit', () => {
  const { car, state, mayEnter } = intersectionHarness();
  car.isPolice = true;
  for (const [key, blocked] of [['occupied', true], ['pedestrians', true], ['space', false], ['conflict', true]]) {
    const initial = state[key];
    state[key] = blocked;
    assert.equal(mayEnter(car, 18), false, key);
    state[key] = initial;
  }
  assert.equal(mayEnter(car, 18), true);
});

test('police running a red yield to fast cross traffic regardless of how long they waited', () => {
  const car = { edge: { axisIndex: 0 }, wait: 20 };
  const lead = { s: 85, v: { speed: 10 } };
  const side = { axisIndex: 1, occ: [[lead]], len: 100 };
  const node = { signal: true, in: [{ axisIndex: 0, occ: [[lead]] }, side] };
  const context = {
    leadOf: (list) => list.at(-1),
    canStopBefore: () => true
  };
  lead.v.half = 2.25;
  context.canStop = trafficFunction('canStop', context);
  const yieldToCrossTraffic = trafficFunction('yieldToCrossTraffic', context);
  assert.equal(yieldToCrossTraffic(car, node), true);
  lead.v.speed = 0;
  assert.equal(yieldToCrossTraffic(car, node), false);
  lead.v.speed = 10;
  lead.s = 10;
  assert.equal(yieldToCrossTraffic(car, node), false);
});

test('left turns account for oncoming police even when their signal is red', () => {
  const edge = { to: { signal: true }, through: 0, len: 100, occ: [] };
  const car = { edge, move: { turn: 'S', out: [0] }, lane: 0, speed: 10, half: 2.25, isPolice: false };
  edge.occ.push([{ v: car, s: 85 }]);
  const context = { phaseOf: () => 'red', leadOf: (list) => list.at(-1) };
  context.canStop = trafficFunction('canStop', context);
  const yieldOncoming = trafficFunction('yieldOncoming', context);
  assert.equal(yieldOncoming(edge, false), false);
  car.isPolice = true;
  assert.equal(yieldOncoming(edge, false), true);
  car.speed = 0;
  assert.equal(yieldOncoming(edge, false), false);
});

function populationContext() {
  const context = {
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
    hasView: true, camX: 0, camY: 10, camZ: 0, visible: () => true,
    focusX: 0, focusZ: 0, player: { active: false },
    clock: 0,
    VEHICLE_SPAWN_DISTANCE: 250, PED_SPAWN_DISTANCE: 150, NEAR_RADIUS: 350,
    nearEdges: [], nearSignals: [], track: {}, KERB: 1.6, QUEUE_GAP: 0.62,
    atCurb: () => {}, laneClear: () => true,
    place: (v, e, lane, s) => Object.assign(v, { edge: e, lane, s })
  };
  context.nearView = trafficFunction('nearView', context);
  return context;
}

function straightEdge(z, len = 20) {
  return { sx: 0, sz: z, dx: 0, dz: 1, rx: -1, rz: 0, len, lanes: [0], occ: [[]] };
}

test('cars replenish the road ahead while nearby visible spawning stays blocked', () => {
  const context = populationContext();
  const edge = straightEdge(140);
  context.nearEdges.push(edge);
  const spawnVehicle = trafficFunction('spawnVehicle', context);
  const car = { half: 2.25 };
  assert.equal(spawnVehicle(car, 100, 350, true), false);
  edge.sz = 290;
  assert.equal(spawnVehicle(car, 100, 350, true), true);
  assert.equal(edge.sz + car.s, 300);
  edge.sz = 140;
  context.visible = () => false;
  assert.equal(spawnVehicle(car, 100, 350, true), true);
});

test('pedestrians replenish visible sidewalks ahead without appearing nearby', () => {
  const context = populationContext();
  context.nearEdges.push(straightEdge(0));
  let z = 100;
  context.sidewalkTrack = () => {
    Object.assign(context.track, { ax: 0, az: z - 10, ux: 0, uz: 1, len: 20, node: null });
    return true;
  };
  const spawnPed = trafficFunction('spawnPed', context);
  const ped = { crossesStreets: false, speed: 1.4, rig: {} };
  assert.equal(spawnPed(ped, 60, 280, true), false);
  z = 220;
  assert.equal(spawnPed(ped, 60, 280, true), true);
  assert.equal(ped.z, 220);
  assert.equal(ped.v, ped.speed);
});

test('long roads are available near their ends and spawn only in the local section', () => {
  const context = populationContext();
  const edge = straightEdge(100, 2000);
  Object.assign(context, { edges: [edge, straightEdge(2000)], nodes: [], nearX: Infinity, nearZ: Infinity });
  trafficFunction('refreshNear', context)();
  assert.deepEqual(context.nearEdges, [edge]);
  const car = { half: 2.25 };
  assert.equal(trafficFunction('spawnVehicle', context)(car, 0, 350, false), true);
  assert.ok(edge.sz + car.s <= 350);
  assert.ok(car.s >= car.half + 5);
});

test('crossing pedestrians fall back to a sidewalk when nearby crosswalks are unusable', () => {
  const context = populationContext();
  context.nearSignals.push({});
  context.nearEdges.push(straightEdge(200));
  let crossings = 0;
  context.crosswalkTrack = () => { crossings++; return false; };
  context.sidewalkTrack = () => {
    Object.assign(context.track, { ax: 0, az: 200, ux: 0, uz: 1, len: 20, node: null });
    return true;
  };
  const ped = { crossesStreets: true, speed: 1.4, rig: {} };
  assert.equal(trafficFunction('spawnPed', context)(ped, 60, 280, true), true);
  assert.equal(crossings, 5);
  assert.equal(ped.node, null);
  assert.equal(ped.z, 210);
});

// A production one-line `const name = ...;` of traffic.js, evaluated in the context
function trafficConst(name, context) {
  const match = source.match(new RegExp(`^  const ${name} = (.*);$`, 'm'));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[1]})`, context);
}

// An unsignalized corner: a two-way main road (group 0, approaches north and south) and a side street (group 1), with
// the production give-way, turn-taking and stopping rules; nothing else gets in the way
function cornerHarness() {
  const n = { signal: false, in: [] };
  const approach = (axisIndex) => ({ to: n, axisIndex, occ: [[], [], []], opposite: null, inSide: 0, len: 100, lefts: 0 });
  const north = approach(0);
  const south = approach(0);
  const side = approach(1);
  north.opposite = south;
  south.opposite = north;
  n.in.push(north, south, side);
  const exit = { lanes: [0], outSide: 1 };
  const stuck = new Set(); // vehicles whose way on is full
  const driver = { a: 2, b: 3, T: 1.2, s0: 2 };
  // a car `d` metres before the line of approach e, at `speed`, having stood there `wait` seconds
  const car = (e, d, speed, wait = 0, turn = 'S', lane = 0) => {
    const v = { edge: e, lane, s: 0, speed, wait, half: 2.25, driver, v0: 11, commit: null,
      isPolice: false, bus: false, move: { to: exit, out: [0, 0, 0], turn } };
    v.entry = { v, s: 0 };
    e.occ[lane].push(v.entry);
    move(v, d, speed);
    return v;
  };
  const move = (v, d, speed) => {
    v.s = v.entry.s = v.edge.len - v.half - d;
    v.speed = speed;
  };
  const context = {
    LOOKAHEAD: 70,
    PATIENCE: Number(/^const PATIENCE = (\d+);/m.exec(source)[1]),
    phaseOf: () => 'green',
    boxBusy: () => false,
    ahead: () => null,
    connector: () => ({ len: 20 }),
    yieldToCrossTraffic: () => false,
    yieldOncoming: () => false,
    pedestrianOn: () => false,
    laneCoord: () => 0,
    timeTo: () => 1,
    room: (f, j, v) => !stuck.has(v),
    alongside: () => false,
    mergingAhead: () => null,
    claim: () => {},
    leadOf: (list) => list.at(-1) || null
  };
  context.freeAcc = trafficConst('freeAcc', context);
  context.brake = trafficFunction('brake', context);
  context.stopAt = trafficConst('stopAt', context);
  context.canStopBefore = trafficConst('canStopBefore', context);
  context.canGiveWay = trafficConst('canGiveWay', context);
  context.frontWaiting = trafficFunction('frontWaiting', context);
  context.waitedLonger = trafficFunction('waitedLonger', context);
  const mayEnter = trafficFunction('mayEnter', context);
  const enter = (v) => mayEnter(v, v.edge.len - v.s - v.half);
  return { n, north, south, side, stuck, car, move, enter, waitedLonger: context.waitedLonger };
}

test('at an unsignalized corner the main road lets in a side-street driver kept waiting', () => {
  const h = cornerHarness();
  const waiting = h.car(h.side, 0.6, 0, 5);
  const main = h.car(h.north, 40, 10);
  assert.equal(h.enter(main), true, 'the main road has the right of way');
  waiting.wait = 9;
  assert.equal(h.enter(main), false, 'until the side street has waited longer than PATIENCE');
  h.stuck.add(waiting);
  assert.equal(h.enter(main), true, 'not for a driver with nowhere to go');
  h.stuck.clear();
  h.move(main, 6, 10);
  assert.equal(h.enter(main), true, 'not by braking hard: too close to stop, it goes');
});

test('giving way, a driver keeps giving way all the way to the line', () => {
  const h = cornerHarness();
  h.car(h.side, 0.6, 0, 9);
  const main = h.car(h.north, 30, 10);
  // the stop-line braking traffic.js applies (IDM, s0 = 1, T = 0), until it stands
  const { a, b } = main.driver;
  for (let k = 0; k < 600 && main.speed > 0; k++) {
    const d = main.edge.len - main.s - main.half;
    assert.equal(h.enter(main), false, `${d.toFixed(2)} m before the line at ${main.speed.toFixed(2)} m/s`);
    const desired = 1 + (main.speed * main.speed) / (2 * Math.sqrt(a * b));
    const acc = a * (1 - (main.speed / main.v0) ** 4) - a * (desired / Math.max(d, 0.1)) ** 2;
    const speed = Math.max(0, main.speed + Math.max(-9, acc) / 30);
    h.move(main, d - speed / 30, speed);
  }
  assert.equal(main.speed, 0);
  assert.equal(h.enter(main), false, 'and waits there');
});

test('a busy side street lets the main road go again in turn: whoever has waited longer goes first', () => {
  const h = cornerHarness();
  const main = h.car(h.north, 0.6, 0, 12);
  const next = h.car(h.side, 30, 6);
  assert.equal(h.enter(next), false, 'the next side-street car gives way to the main road waiting longer');
  h.move(next, 0.6, 0);
  next.wait = 15;
  assert.equal(h.enter(next), true, 'unless it has waited longer still');
  assert.equal(h.enter(main), false, 'and then the main road waits for it');
});

test('oncoming traffic lets a left turn kept waiting go, and only a left turn', () => {
  const h = cornerHarness();
  const turning = h.car(h.south, 0.6, 0, 10, 'L');
  const oncoming = h.car(h.north, 40, 10);
  assert.equal(h.enter(oncoming), false);
  turning.move.turn = 'S';
  assert.equal(h.enter(oncoming), true, 'straight on, it crosses nobody');
  turning.move.turn = 'L';
  oncoming.move.turn = 'L';
  assert.equal(h.enter(oncoming), true, 'two left turns pass each other');
});

test('turns go by each approach\'s longest wait, so merging lanes and left turns can\'t wait on each other in a ring', () => {
  const h = cornerHarness();
  // `first` merges in behind `second`, which is nearer the line in the next lane; the left turn opposite takes turns
  // with them by their waits (yieldOncoming)
  const first = h.car(h.north, 0.6, 0, 238, 'S', 0);
  const second = h.car(h.north, 0.5, 0, 236, 'S', 1);
  const turning = h.car(h.south, 0.6, 0, 237, 'L');
  assert.equal(h.waitedLonger(second, h.n), false, 'the north approach has waited longest, so it goes first');
  assert.equal(h.waitedLonger(first, h.n), false);
  turning.wait = 240;
  assert.equal(h.waitedLonger(second, h.n), true, 'until the left turn has waited longer than all of it');
  assert.equal(h.waitedLonger(first, h.n), true);
  h.stuck.add(first);
  turning.wait = 237;
  assert.equal(h.waitedLonger(second, h.n), true, 'a driver with nowhere to go doesn\'t hold up its approach\'s turn');
});

test('an approach\'s turn counts its front drivers standing back to merge, not only those at the line', () => {
  const h = cornerHarness();
  h.car(h.side, 0.6, 0, 20);
  const merging = h.car(h.north, 15, 0, 30, 'S', 0);
  const main = h.car(h.north, 0.6, 0, 5, 'S', 1);
  assert.equal(h.waitedLonger(main, h.n), false, 'the north approach has kept a driver waiting longer');
  h.stuck.add(merging);
  assert.equal(h.waitedLonger(main, h.n), true, 'unless that driver has nowhere to go');
});

test('signalized corners keep to the lights', () => {
  const h = cornerHarness();
  h.n.signal = true;
  h.car(h.side, 0.6, 0, 30);
  assert.equal(h.enter(h.car(h.north, 40, 10)), true);
});

// Lane-to-lane curves as road-network.js builds them
const roadSource = readFileSync(join(__dirname, '../js/road-network.js'), 'utf8');
const makeCurve = vm.runInNewContext(`(${roadSource.match(/^function makeCurve\(e, i, f, j\) \{[\s\S]*?\n\}/m)[0]})`, {});

test('turning vehicles slow down for the sharp part of a bend only, never beyond the sideways grip they accept', () => {
  // southbound from the far lane of a wide avenue, left into a cross street: sharpest right at the stop line
  const e = { sx: 0, sz: 0, dx: 0, dz: 1, rx: -1, rz: 0, len: 50, lanes: [11.4] };
  const f = { sx: 19.5, sz: 59.3, dx: 1, dz: 0, rx: 0, rz: 1, lanes: [1.8] };
  const c = makeCurve(e, 0, f, 0);
  assert.equal(c.bend.length, 17);
  assert.equal(Math.max(...c.bend), c.bend[0]);
  assert.ok(Math.abs(c.curv - c.bend[0]) < 1e-6);
  const bendSpeed = trafficFunction('bendSpeed', {});
  const car = { axle: 1.38, driver: { aLat: 3.5 } };
  const sharpest = Math.sqrt(car.driver.aLat / c.curv);
  let slowest = Infinity;
  let previous = null;
  for (let cs = -20; cs <= c.len + 3; cs += 0.25) {
    const cap = bendSpeed(car, c, cs);
    slowest = Math.min(slowest, cap);
    for (let k = 0; k <= 16; k++) {
      if (Math.abs(c.lut[k] - cs) <= car.axle) assert.ok(cap * cap * c.bend[k] <= car.driver.aLat * (1 + 1e-9), `grip at ${cs} m`);
    }
    if (previous) assert.ok(cap * cap >= previous * previous - 5 * 0.25 - 1e-9, `no harder than 2.5 m/s² to slow down at ${cs} m`);
    previous = cap;
  }
  assert.ok(Math.abs(slowest - sharpest) < 1e-6, 'as slow as the old whole-curve limit at the sharp point');
  assert.ok(bendSpeed(car, c, c.len * 0.75) > 2.5 * sharpest, 'and much faster where the bend opens out');
});

test('two buses side by side turning away from each other take turns instead of waiting for each other for ever', () => {
  const e = { len: 100, lanes: [-1.8, 1.8], occ: [[], []] };
  const bus = (lane, turn) => {
    const v = { edge: e, lane, s: e.len - 6 - 0.6, half: 6, bus: true, move: { turn } };
    e.occ[lane].push({ v, s: v.s });
    return v;
  };
  const context = { leadOf: (list) => list.at(-1) || null };
  context.busOutside = trafficFunction('busOutside', context);
  const besideTail = trafficFunction('besideTail', context);
  const left = bus(0, 'L');
  const right = bus(1, 'R');
  assert.equal(besideTail(left), false, 'the left turn (the wider one) goes first');
  assert.equal(besideTail(right), true);
  right.move.turn = 'S';
  assert.equal(besideTail(left), true, 'a turning bus still waits for one beside its tail going straight on');
  assert.equal(besideTail(right), false);
  right.move.turn = 'L';
  assert.equal(besideTail(left), true, 'and for one turning the same way, which goes first');
  assert.equal(besideTail(right), false);
});
