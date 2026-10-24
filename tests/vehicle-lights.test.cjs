const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadModule } = require('./helpers/module.cjs');

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  applyMatrix4({ elements: e }) {
    const { x, y, z } = this;
    return this.set(e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14]);
  }
}
class SpotLight {
  constructor(color, intensity, distance, angle, penumbra, decay) {
    Object.assign(this, { color, intensity, distance, angle, penumbra, decay });
    this.position = new Vector3();
    this.target = { position: new Vector3() };
    this.map = null;
    this.colorNode = null;
    this.castShadow = false;
  }
}
const { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } = loadModule(
  readFileSync(join(__dirname, '../js/vehicle-lights.js'), 'utf8'),
  { imports: { 'three/webgpu': { SpotLight } } }
);
const specs = {
  sedan: { headlight: [0.56, 0.705], zFront: 2.25 },
  suv: { headlight: [0.6, 0.9], zFront: 2.3 },
  bus: { headlight: [0.79, 0.8], zFront: 5.78 }
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} should equal ${b}`);

test('the shared profile creates ordinary unshadowed spots with no cookie or custom light node', () => {
  const spot = createVehicleHeadlight();
  assert.equal(spot.intensity, 0, 'pool lights remain off until assigned');
  for (const key of ['color', 'distance', 'angle', 'penumbra', 'decay']) assert.equal(spot[key], HEADLIGHTS[key]);
  assert.equal(spot.decay, 2);
  assert.ok(spot.penumbra >= 0 && spot.penumbra <= 1);
  placeVehicleHeadlight(spot, specs.sedan, 1);
  assert.equal(spot.map, null);
  assert.equal(spot.colorNode, null);
  assert.equal(spot.castShadow, false);
});

for (const [name, spec] of Object.entries(specs)) {
  test(`${name} beams originate at the modeled lamps and stay below the chassis horizon`, () => {
    for (const side of [-1, 1]) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      close(spot.position.x, side * spec.headlight[0]);
      close(spot.position.y, spec.headlight[1]);
      close(spot.position.z, spec.zFront + HEADLIGHTS.noseOffset);
      const dx = spot.target.position.x - spot.position.x;
      const dy = spot.target.position.y - spot.position.y;
      const dz = spot.target.position.z - spot.position.z;
      assert.ok(dz > 0 && dx * side > 0, 'the beam points forward with a slight outward angle');
      close(dx / dz, side * HEADLIGHTS.toeOut);
      close(-dy / dz, Math.tan(HEADLIGHTS.pitch));
      const downwardAngle = Math.atan2(-dy, Math.hypot(dx, dz));
      assert.ok(downwardAngle > spot.angle, 'the entire cone stays below the local horizon, including toe-out');
    }
  });
}

test('lamp and target follow both yaw and slope at elevated road height', () => {
  // A road climbing at 10%, facing +X: yaw = pi/2, pitch = -atan(.1), translated onto the viaduct.
  const pitch = -Math.atan(0.1), s = Math.sin(pitch), c = Math.cos(pitch);
  const matrix = { elements: [0, 0, -1, 0, s, c, 0, 0, c, -s, 0, 0, 30, 7.6, -10, 1] };
  const local = createVehicleHeadlight(), world = createVehicleHeadlight();
  placeVehicleHeadlight(local, specs.suv, -1);
  placeVehicleHeadlight(world, specs.suv, -1, matrix);
  for (const [a, b] of [[local.position, world.position], [local.target.position, world.target.position]]) {
    close(b.x, 30 + s * a.y + c * a.z);
    close(b.y, 7.6 + c * a.y - s * a.z);
    close(b.z, -10 - a.x);
  }
  const dx = world.target.position.x - world.position.x;
  const dy = world.target.position.y - world.position.y;
  const dz = world.target.position.z - world.position.z;
  const vertical = dx * s + dy * c; // dot with the elevated road's up vector
  const horizontal = Math.sqrt(dx * dx + dy * dy + dz * dz - vertical * vertical);
  assert.ok(Math.atan2(-vertical, horizontal) > world.angle, 'the transformed cone stays below the road-relative horizon');
  // Reusing a pooled light must reset local coordinates instead of accumulating the prior matrix transform.
  placeVehicleHeadlight(world, specs.suv, -1);
  assert.deepEqual(world.position, local.position);
  assert.deepEqual(world.target.position, local.target.position);
});

// NYPD light bars: the lenses (actor-models.js, a TSL material) and the red & blue lights they cast on the street
// (traffic.js) must flash together, each car on its own steady phase
const actorSource = readFileSync(join(__dirname, '../js/actor-models.js'), 'utf8');
const trafficSource = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');
function excerpt(text, pattern, name) {
  const match = text.match(pattern);
  assert.ok(match, `${name} is present`);
  return match[0];
}

// A tiny interpreter for the TSL the lens material is written in: nodes evaluate against per-fragment inputs
function miniTSL() {
  const value = (b, env) => (typeof b === 'number' ? b : b.eval(env));
  const zip = (x, y, f) => (Array.isArray(x) || Array.isArray(y)
    ? [0, 1, 2].map((i) => f(Array.isArray(x) ? x[i] : x, Array.isArray(y) ? y[i] : y))
    : f(x, y));
  const node = (fn) => {
    const n = { eval: fn, toVar: () => n };
    n.add = (b) => node((env) => zip(n.eval(env), value(b, env), (p, q) => p + q));
    n.sub = (b) => node((env) => zip(n.eval(env), value(b, env), (p, q) => p - q));
    n.mul = (b) => node((env) => zip(n.eval(env), value(b, env), (p, q) => p * q));
    Object.defineProperty(n, 'x', { get: () => node((env) => n.eval(env)[0]) });
    return n;
  };
  return {
    Fn: (build) => () => build(),
    uniform: (initial) => {
      const u = node(() => u.value);
      u.value = initial;
      return u;
    },
    attribute: (name) => node((env) => env[name]),
    color: (hex) => node(() => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]),
    step: (edge, x) => node((env) => (value(x, env) < value(edge, env) ? 0 : 1)),
    fract: (x) => node((env) => value(x, env) - Math.floor(value(x, env))),
    abs: (x) => node((env) => Math.abs(value(x, env))),
    mix: (a, b, t) => node((env) => zip(value(a, env), value(b, env), (p, q) => p + (q - p) * value(t, env)))
  };
}

function lightbarModule() {
  const context = {
    ...miniTSL(),
    THREE: { MeshStandardNodeMaterial: class { constructor(options) { Object.assign(this, options, { userData: {} }); } } },
    CAR_PARTS: vm.runInNewContext(`(${excerpt(actorSource, /^const CAR_PARTS = (\{[\s\S]*?\n\});/m, 'CAR_PARTS').slice(18, -1)})`)
  };
  const code = excerpt(actorSource, /^\/\/ Light bar timing[\s\S]*?\nfunction createLightbarMaterial\(\) \{[\s\S]*?\n\}/m, 'the light bar timing and material');
  return vm.runInNewContext(`${code}\n({ LIGHTBAR_RATE, lightbarFlash, createLightbarMaterial })`, context);
}

// Which lens halves the material lights `cycle` into the cycle for an instance of phase `phase`
function litLenses(material, cycle, phase) {
  material.userData.cycle.value = cycle;
  const lens = (x) => material.emissiveNode.eval({ position: [x, 0, 0], partId: 6, strobePhase: phase });
  return { red: lens(-0.3)[0] > 0, blue: lens(0.3)[2] > 0 };
}

test('light bars flash each half three times a cycle, in turn, every car offset by its own phase', () => {
  const { LIGHTBAR_RATE, lightbarFlash } = lightbarModule();
  assert.ok(LIGHTBAR_RATE > 1 && LIGHTBAR_RATE < 3, 'a cycle or two a second');
  const flashes = (phase, from, to) => {
    let count = 0;
    let lit = 0;
    let previous = 0;
    for (let k = 0; k < 1200; k++) {
      const flash = lightbarFlash((from + ((to - from) * k) / 1200) % 1, phase);
      if (flash !== 0 && previous === 0) count++;
      if (flash !== 0) lit++;
      previous = flash;
    }
    return { count, lit: lit / 1200 };
  };
  const red = flashes(0, 0, 0.5);
  const blue = flashes(0, 0.5, 1);
  assert.equal(red.count, 3);
  assert.equal(blue.count, 3);
  assert.ok(Math.abs(red.lit - 0.5) < 0.01 && Math.abs(blue.lit - 0.5) < 0.01, 'lit half the time');
  for (let k = 0; k < 1000; k++) {
    const cycle = k / 1000;
    if (cycle < 0.5) assert.notEqual(lightbarFlash(cycle, 0), 1, 'only red in the first half');
    else assert.notEqual(lightbarFlash(cycle, 0), -1, 'only blue in the second half');
    assert.equal(lightbarFlash(cycle, 0.37), lightbarFlash((cycle + 0.37) % 1, 0), 'a phase shifts the same pattern');
  }
});

test('the lenses light exactly as lightbarFlash() says, from the shared cycle and the instance phase', () => {
  const { lightbarFlash, createLightbarMaterial } = lightbarModule();
  const material = createLightbarMaterial();
  assert.equal(createLightbarMaterial(), material, 'one material for every light bar');
  assert.ok(material.userData.cycle, 'its cycle is a uniform the traffic advances');
  for (const phase of [0, 0.236, 0.618, 0.9]) {
    for (let k = 0; k < 480; k++) {
      const cycle = (k + 0.5) / 480;
      const flash = lightbarFlash(cycle, phase);
      const lit = litLenses(material, cycle, phase);
      assert.equal(lit.red, flash === -1, `red at ${cycle}, phase ${phase}`);
      assert.equal(lit.blue, flash === 1, `blue at ${cycle}, phase ${phase}`);
    }
  }
});

function trafficFunction(name, context) {
  return vm.runInNewContext(`(${excerpt(trafficSource, new RegExp(`  function ${name}\\([^]*?\\n  \\}`), name).trim()})`, context);
}

test('the red & blue lights a patrol car casts flash with its lenses', () => {
  const { lightbarFlash, createLightbarMaterial } = lightbarModule();
  const material = createLightbarMaterial();
  const light = { color: { setHex(hex) { this.hex = hex; } }, position: { set(x, y, z) { Object.assign(this, { x, y, z }); } } };
  const spot = { position: { set() {} } };
  const car = { isPolice: true, _effDist: 20, x: 0, z: 0, _sinY: 0, _cosY: 1, strobePhase: 0.618 };
  const context = {
    litVehicles: [car], litVehicleCount: 1, lightbarCycle: 0, lightbarFlash,
    cityUniforms: { uInteriorGlow: { value: 1.55 } }, clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
    HEADLIGHT_POOL_SIZE: 2, headlightPool: [spot, spot], MAX_LIGHT_DIST: 115,
    POLICE_LIGHT_POOL_SIZE: 1, policeLightPool: [light],
    BODY_SPECS: { sedan: {} }, HEADLIGHTS: { distance: 36, intensity: 700 }, player: { active: false },
    dummy: { position: { set() {} }, rotation: { set() {} }, scale: { set() {} }, updateMatrix() {}, matrix: {} },
    placeVehicleHeadlight: () => {}
  };
  context.smoothDistFade = trafficFunction('smoothDistFade', context);
  const updateTrafficLights = trafficFunction('updateTrafficLights', context);
  car.bodyType = 'sedan';
  for (let k = 0; k < 480; k++) {
    context.lightbarCycle = (k + 0.5) / 480;
    updateTrafficLights();
    const lit = litLenses(material, context.lightbarCycle, car.strobePhase);
    assert.equal(light.intensity > 0, lit.red || lit.blue, `lit together at ${context.lightbarCycle}`);
    if (lit.red) assert.ok(light.color.hex === 0xff1828 && light.position.x < 0, 'red, from the red (-x) half');
    if (lit.blue) assert.ok(light.color.hex === 0x1868ff && light.position.x > 0, 'blue, from the blue (+x) half');
  }
});

test('a light bar instance takes the phase of whichever patrol car is drawn in it, uploading it only on a change', () => {
  const instance = () => ({ count: 0, setMatrixAt() {}, geometry: { attributes: { paintColor: { array: new Float32Array(9) }, carState: { array: new Float32Array(12) } } } });
  const context = {
    Math, BODY_SPECS: { sedan: { wheelRadius: 0.35, wheelX: 0.8, wheelZ: 1.4 } }, hasView: false, visible: () => true,
    focusX: 0, focusZ: 0, CAR_PROXY_DISTANCE: 90, bodies: { sedan: { near: instance(), far: instance() } },
    dummy: { position: { set() {} }, rotation: { set() {} }, scale: { set() {} }, updateMatrix() {}, matrix: {} },
    policeDrawn: 0, policeLightbarInst: { setMatrixAt() {} }, strobePhases: { array: new Float32Array(2) }, strobeDirty: false,
    dirtyPaint: new Set(), dirtyState: new Set(), clock: 0, visibleCars: 0, carShadowInst: { setMatrixAt() {} },
    camX: 0, camY: 1000, camZ: 0, camFwdX: 0, camFwdZ: 1, MAX_LIGHT_DIST_SQ: 115 * 115, MAX_LIGHT_DIST: 115,
    litVehicles: [], litVehicleCount: 0, placeWheels: () => {}, wheelCars: 0, carWheelLeftInst: {}, carWheelRightInst: {}
  };
  const renderCar = trafficFunction('renderCar', context);
  const patrol = (strobePhase) => ({ x: 0, z: 0, prevX: 0, prevZ: 0, yaw: 0, yawOffset: 0, pitch: 0, roll: 0, bodyType: 'sedan',
    wheelSpin: 0, paint: [1, 1, 1], blink: 0, blinkPhase: 0, acc: 0, speed: 5, isPolice: true, strobePhase: Math.fround(strobePhase) });
  const a = patrol(0.618034);
  const b = patrol(0.236068);
  const frame = (...order) => {
    context.policeDrawn = 0;
    context.strobeDirty = false;
    context.bodies.sedan.near.count = 0;
    for (const car of order) renderCar(car);
    return [...context.strobePhases.array];
  };
  assert.deepEqual(frame(a, b), [a.strobePhase, b.strobePhase]);
  assert.equal(context.strobeDirty, true);
  assert.deepEqual(frame(a, b), [a.strobePhase, b.strobePhase]);
  assert.equal(context.strobeDirty, false, 'nothing to upload while the same cars keep their slots');
  assert.deepEqual(frame(b, a), [b.strobePhase, a.strobePhase], 'a car keeps its timing when it changes slot');
  assert.equal(context.strobeDirty, true);
});
