const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');
function pick(pattern, name) {
  const match = source.match(pattern);
  assert.ok(match, `${name} is present`);
  return match[0];
}

// The production pedestrian step on a crosswalk track, with the signal state and the vehicles holding the crosswalk
// under the test's control
const KERB = Number(/^ {2}const KERB = ([\d.]+);/m.exec(source)[1]);
function crosswalkHarness() {
  const context = {
    clock: 0,
    aveWalk: false,
    stWalk: false,
    nearEdges: [],
    walkedNodes: [],
    pedRoutes: { next: () => null },
    atCurb: () => {},
    leadOf: (list) => list.at(-1) || null,
    canStop: () => true
  };
  const code = [
    pick(/^ {2}const KERB = .*$/m, 'KERB'),
    pick(/^ {2}const QUEUE_GAP = .*$/m, 'QUEUE_GAP'),
    pick(/^ {2}const curbProgress = .*$/m, 'curbProgress'),
    pick(/^ {2}const beforeKerb = .*$/m, 'beforeKerb'),
    pick(/^ {2}const walkOn = .*$/m, 'walkOn'),
    pick(/^ {2}function mayCross\(p\) \{[\s\S]*?\n {2}\}/m, 'mayCross'),
    pick(/^ {2}const PED_ACCEL = .*$/m, 'PED_ACCEL'),
    pick(/^ {2}const PED_BRAKE = .*$/m, 'PED_BRAKE'),
    pick(/^ {2}const TURN_TIME = .*$/m, 'TURN_TIME'),
    pick(/^ {2}function walk\(p, dt\) \{[\s\S]*?\n {2}\}/m, 'walk')
  ].join('\n');
  const { walk, curbProgress } = vm.runInNewContext(`${code}\n({ walk, curbProgress });`, context);
  return { context, walk, curbProgress };
}

// A pedestrian stepping onto a crosswalk across the avenue (side 0) from the sidewalk at one end of its track
function crossingPedestrian(len, dir) {
  const node = { crossing: [0, 0, 0, 0], approach: [null, null, null, null], curb: [], walkers: [] };
  const p = {
    node, side: 0, line: 0, coord: 0, len, dir, t: dir > 0 ? 0 : len,
    ax: 0, az: 0, ux: 1, uz: 0, x: 0, z: 0,
    speed: 1.4, v: 1.4, pause: 0, waiting: false, conversation: null,
    route: null, nextRoute: null, nextLeg: 0, goalX: 0, goalZ: 0, goalTime: Infinity, restTime: Infinity
  };
  node.curb.push(p);
  return p;
}

function step(h, p, frames) {
  for (let f = 0; f < frames; f++) {
    p.node.walkers.length = 0;
    h.context.walkedNodes.length = 0;
    h.context.clock += 1 / 60;
    h.walk(p, 1 / 60);
  }
}

test('the lengths checked include ones where walking back from the far end overshoots the waiting line', () => {
  let overshoots = 0;
  for (let k = 80; k <= 400; k++) if (k / 10 - (k / 10 - KERB) > KERB) overshoots++;
  assert.ok(overshoots > 100, `${overshoots} lengths round past the line`);
});

for (const dir of [1, -1]) {
  test(`pedestrians walking ${dir > 0 ? 'from the near' : 'from the far'} end wait at the curb for the WALK on every crosswalk length`, () => {
    const h = crosswalkHarness();
    for (let k = 80; k <= 400; k++) {
      const p = crossingPedestrian(k / 10, dir);
      let onRoadway = false;
      for (let f = 0; f < 600; f++) {
        step(h, p, 1);
        assert.ok(Number.isFinite(p.t) && Number.isFinite(p.v), `finite state on a ${p.len} m crosswalk`);
        assert.ok(h.curbProgress(p) <= KERB + 1e-6, `${h.curbProgress(p)} m along a ${p.len} m crosswalk without the WALK`);
        onRoadway ||= p.node.walkers.includes(p);
      }
      assert.equal(p.waiting, true, `waiting at the curb of a ${p.len} m crosswalk`);
      assert.equal(p.v, 0);
      assert.equal(onRoadway, false, 'vehicles are never told someone is crossing');
    }
  });

  test(`pedestrians ${dir > 0 ? 'from the near' : 'from the far'} end cross once the WALK comes on and no vehicle holds the crosswalk`, () => {
    const h = crosswalkHarness();
    for (const len of [8.3, 12.3, 19.7, 27.1, 36.9]) {
      const p = crossingPedestrian(len, dir);
      step(h, p, 300);
      assert.equal(p.waiting, true);
      p.node.crossing[0] = 1; // a vehicle still crossing it: the WALK alone isn't enough
      h.context.aveWalk = true;
      step(h, p, 120);
      assert.ok(h.curbProgress(p) <= KERB + 1e-6);
      p.node.crossing[0] = 0;
      step(h, p, 60);
      assert.equal(p.waiting, false);
      assert.ok(h.curbProgress(p) > KERB + 0.1, `stepped off the curb of a ${len} m crosswalk`);
      assert.ok(p.node.walkers.includes(p), 'and vehicles know');
      h.context.aveWalk = false;
    }
  });
}
