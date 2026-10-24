const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function keyboardHarness(nyc = {}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const config = {
    streetZ: () => 0,
    isTypingInField: (event) => ['INPUT', 'SELECT'].includes(event.target?.tagName),
    ...nyc
  };
  const { ThirdPersonControllerManager } = loadModule(source, {
    globals: { window, document },
    imports: {
      'three/webgpu': {},
      './city-config.js': config,
      './tsl-materials.js': {},
      './actor-models.js': {},
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './landmarks.js': {}
    }
  });
  // Exercise the production event handlers without constructing the scene's 3D models.
  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down', 'boost'].map((action) => [action, false]));
  controller.bindKeyboard();
  return {
    controller,
    window,
    document,
    key(type, code, tagName = 'BODY', event = {}) {
      window.dispatch(type, { code, target: { tagName }, ...event });
    }
  };
}

test('releasing a movement key after focusing search stops movement', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false);

  key('keydown', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false, 'typing in search does not move the player');
});

test('releasing one movement binding preserves another held binding', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  key('keydown', 'ArrowUp');
  key('keyup', 'ArrowUp');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('either Shift key keeps boost active until both are released', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'ShiftLeft');
  key('keydown', 'ShiftRight');
  key('keyup', 'ShiftLeft');
  assert.equal(controller.keys.boost, true);
  key('keyup', 'ShiftRight');
  assert.equal(controller.keys.boost, false);
});

test('keyboard and touch input remain active independently', () => {
  const { controller, key } = keyboardHarness();
  controller.setTouchInput('forward', 0.35);
  assert.equal(controller.keys.forward, 0.35);
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  controller.setTouchInput('forward', 0.6);
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, 0.6);
  controller.setTouchInput('forward', 0);
  assert.equal(controller.keys.forward, false);
});

test('clearing touch input preserves held keyboard controls', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  controller.setTouchInput('forward', 0.4);
  controller.setTouchInput('left', 0.7);
  controller.setTouchInput('boost', true);
  controller.clearTouchInput();
  assert.equal(controller.keys.forward, true);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.boost, false);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('touch strengths are clamped and unknown actions are ignored', () => {
  const { controller } = keyboardHarness();
  controller.setTouchInput('forward', 2);
  controller.setTouchInput('left', -0.5);
  controller.setTouchInput('up', true);
  controller.setTouchInput('unknown', 1);
  assert.equal(controller.keys.forward, 1);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.up, true);
  assert.equal(Object.hasOwn(controller.keys, 'unknown'), false);
});

for (const interruption of ['blur', 'hidden', 'reset']) {
  test(`${interruption} clears held controls and their physical key state`, () => {
    const { controller, window, document, key } = keyboardHarness();
    key('keydown', 'KeyW');
    key('keydown', 'KeyA');
    key('keydown', 'Space');
    key('keydown', 'ShiftLeft');
    controller.setTouchInput('forward', 0.4);
    controller.setTouchInput('backward', 0.8);
    controller.setTouchInput('down', true);
    if (interruption === 'blur') {
      window.dispatch('blur');
    } else if (interruption === 'hidden') {
      document.hidden = true;
      document.dispatch('visibilitychange');
    } else {
      controller.resetInput();
    }
    assert.equal(Object.values(controller.keys).some(Boolean), false);

    // A fresh use of the alias must not revive the old key whose keyup was lost.
    key('keydown', 'ArrowUp');
    key('keyup', 'ArrowUp');
    assert.equal(controller.keys.forward, false);
  });
}

test('Cmd and Ctrl shortcuts never move the player', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'MetaLeft', 'BODY', { key: 'Meta', metaKey: true });
  for (const code of ['KeyA', 'KeyE', 'ArrowUp', 'ShiftLeft']) key('keydown', code, 'BODY', { metaKey: true });
  assert.equal(Object.values(controller.keys).some(Boolean), false, 'Cmd+A, Cmd+E, Cmd+Up and Cmd+Shift are shortcuts');
  // macOS sends no keyup for A, E or Up let go while Cmd is down.
  key('keyup', 'MetaLeft', 'BODY', { key: 'Meta' });
  assert.equal(Object.values(controller.keys).some(Boolean), false);

  key('keydown', 'ControlLeft', 'BODY', { key: 'Control', ctrlKey: true });
  key('keydown', 'KeyW', 'BODY', { ctrlKey: true });
  assert.equal(controller.keys.forward, false);
  key('keyup', 'KeyW', 'BODY', { ctrlKey: true });
  key('keyup', 'ControlLeft', 'BODY', { key: 'Control' });
  key('keydown', 'KeyA');
  assert.equal(controller.keys.left, true, 'plain presses still steer');
});

test('releasing Cmd drops held movement keys whose keyup macOS swallowed', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  key('keydown', 'KeyD');
  key('keydown', 'MetaLeft', 'BODY', { key: 'Meta', metaKey: true });
  // Auto-repeat of a key held through Cmd changes nothing either way.
  key('keydown', 'KeyW', 'BODY', { metaKey: true, repeat: true });
  assert.equal(controller.keys.forward, true);
  // W and D are let go while Cmd is down, so no keyup arrives for them.
  key('keyup', 'MetaRight', 'BODY', { key: 'Meta' });
  assert.equal(Object.values(controller.keys).some(Boolean), false);
  assert.equal(controller._pressedCodes.size, 0);
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true, 'a fresh press drives again');

  // Where the browser does deliver a release with Cmd held, it counts.
  key('keydown', 'MetaLeft', 'BODY', { key: 'Meta', metaKey: true });
  key('keyup', 'KeyW', 'BODY', { metaKey: true });
  assert.equal(controller.keys.forward, false);
});

function advanceWithTouch(mode, strength, reverse) {
  const { controller } = keyboardHarness();
  const entity = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0 };
  if (mode === 'Person') Object.assign(entity, { verticalVel: 0 });
  if (mode === 'Car') Object.assign(entity, {
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
    chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: []
  });
  if (mode === 'Cyclist') Object.assign(entity, {
    leanAngle: 0, leanPivot: { rotation: { z: 0 } },
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    pedalPhase: 0, crankPivot: { rotation: { x: 0 } }, pedals: []
  });
  if (mode === 'Helicopter') Object.assign(entity, {
    verticalSpeed: 0, pitchAngle: 0, rollAngle: 0,
    tiltPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }
  });
  // Airborne, so that descending is not cut short by the ground
  if (mode === 'Helicopter') entity.position.y = 100;
  controller.entities = { [mode.toLowerCase()]: entity };
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  controller.setTouchInput(reverse ? 'backward' : 'forward', strength);
  controller.setTouchInput(reverse ? 'right' : 'left', strength);
  if (mode === 'Helicopter') controller.setTouchInput(reverse ? 'down' : 'up', strength);
  controller[`update${mode}`](0.1, 0);
  return entity;
}

for (const mode of ['Person', 'Car', 'Cyclist', 'Helicopter']) {
  test(`analog ${mode.toLowerCase()} input proportionally scales movement and turning`, () => {
    for (const reverse of [false, true]) {
      const full = advanceWithTouch(mode, 1, reverse);
      const partial = advanceWithTouch(mode, 0.4, reverse);
      assert.ok(Math.abs(partial.speed - full.speed * 0.4) < 1e-10, 'movement should scale with joystick strength');
      const turn = mode === 'Car' ? 'steerAngle' : 'heading';
      assert.ok(Math.abs(partial[turn] - full[turn] * 0.4) < 1e-10, 'turning should scale with joystick strength');
      if (mode === 'Helicopter') {
        assert.ok(Math.abs(partial.verticalSpeed - full.verticalSpeed * 0.4) < 1e-10);
      }
    }
  });
}

function teleportHarness(mode, colliders = [], shore = () => ({ westX: -500, eastX: 500 })) {
  const harness = keyboardHarness({
    ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 1000, maxX: 1100, minZ: 1000, maxZ: 1100 },
    getIslandBoundsAtZ: shore,
    blockAt: () => null
  });
  const { controller } = harness;
  const position = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const pivot = () => ({ position: position(), rotation: { x: 0.1, y: 0, z: -0.2 } });
  const chase = { person: [4.3, 1.95], car: [6.9, 2.12], cyclist: [4.8, 2.05], helicopter: [11.4, 3.3] };
  const ent = {
    type: mode, chaseDistance: chase[mode][0], chaseHeight: chase[mode][1],
    position: position(400, mode === 'helicopter' ? 120 : 0, 400), heading: 1, speed: 20,
    mesh: pivot(),
    verticalVel: 5, vx: 3, vz: -4, angularVel: 2, steerAngle: 0.4,
    pitchVel: 3, rollVel: 4, heaveY: 0.1, heaveVel: 2, chassisPivot: pivot(),
    lastCollisionSpark: { speed: 5 }, carState: { value: { x: 0 } }, wheelSpin: 1,
    wheels: [{ isFront: true, steerPivot: { rotation: { y: 0.4 } }, tire: { rotation: { x: 0 } } }],
    leanAngle: 0.3, leanPivot: pivot(), pedalPhase: 0.7,
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    crankPivot: { rotation: { x: 0 } }, pedals: [],
    verticalSpeed: -8, pitchAngle: 0.2, rollAngle: -0.2, tiltPivot: pivot(),
    rig: { reset(...args) { this.resetArgs = args; } },
    crowd: { begin() {}, add() {}, end() {} }
  };
  controller.activeMode = mode;
  controller.entities = { [mode]: ent };
  controller.colliders = colliders;
  controller._colliderCells = null;
  controller.getGroundHeight = (x, z, mode) => mode === 'person' ? (x < 0 ? 1.24 : 0.22) : 0;
  return { ...harness, ent };
}

for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
  test(`${mode} teleport stops carried motion and updates its arrival pose immediately`, () => {
    const { controller, ent, key } = teleportHarness(mode);
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    controller.setTouchInput('left', 0.8);
    const result = controller.teleportActiveTo(30, 20, 0.7);
    assert.deepEqual({ ...result }, { x: 30, z: 20 }, 'an open destination is kept exactly');
    assert.equal(ent.heading, 0.7);
    assert.equal(ent.speed, 0);
    assert.equal(Object.values(controller.keys).some(Boolean), false);
    assert.equal(controller._pressedCodes.size, 0);
    assert.deepEqual([ent.mesh.position.x, ent.mesh.position.y, ent.mesh.position.z], [ent.position.x, ent.position.y, ent.position.z]);
    assert.equal(ent.mesh.rotation.y, 0.7);
    if (mode === 'person') {
      assert.equal(ent.verticalVel, 0);
      assert.equal(ent.position.y, 0.22);
      assert.deepEqual(ent.rig.resetArgs.slice(0, 3), [30, 20, 0.7]);
      assert.equal(ent.rig.resetArgs[3](ent.rig.resetArgs[4], 30, 20), 0.22);
    } else if (mode === 'car') {
      for (const field of ['vx', 'vz', 'angularVel', 'steerAngle', 'pitchVel', 'rollVel', 'heaveY', 'heaveVel']) assert.equal(ent[field], 0, field);
      assert.equal(ent.chassisPivot.rotation.x, 0);
      assert.equal(ent.chassisPivot.rotation.z, 0);
      assert.equal(ent.chassisPivot.position.y, 0);
      assert.equal(ent.wheels[0].steerPivot.rotation.y, 0);
      assert.equal(ent.lastCollisionSpark, null);
    } else if (mode === 'cyclist') {
      assert.equal(ent.leanAngle, 0);
      assert.equal(ent.leanPivot.rotation.z, 0);
    } else {
      for (const field of ['verticalSpeed', 'pitchAngle', 'rollAngle']) assert.equal(ent[field], 0, field);
      assert.equal(ent.tiltPivot.rotation.x, 0);
      assert.equal(ent.tiltPivot.rotation.z, 0);
      assert.equal(ent.tiltPivot.position.y, 0);
      assert.equal(ent.position.y, 120, 'keep the helicopter altitude when already above the minimum');
    }
    const before = [ent.position.x, ent.position.y, ent.position.z, ent.heading];
    controller[`update${mode[0].toUpperCase()}${mode.slice(1)}`](0.1, 0);
    assert.deepEqual([ent.position.x, ent.position.y, ent.position.z, ent.heading], before, 'the first neutral frame stays at the arrival');
  });
}

test('teleport checks all overlapping buildings instead of leaving a sequential push trap', () => {
  const colliders = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 200 },
    { minX: 9, maxX: 20, minZ: 0, maxZ: 10, maxY: 200 }
  ];
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    // Reverse order as well: a valid arrival must not rely on collider traversal order.
    for (const list of [colliders, colliders.slice().reverse()]) {
      const { controller, ent } = teleportHarness(mode, list.map(c => ({ ...c })));
      const result = controller.teleportActiveTo(11, 5, 0);
      assert.notDeepEqual({ ...result }, { x: 11, z: 5 });
      const before = [ent.position.x, ent.position.z];
      const radius = mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65;
      controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
      assert.deepEqual([ent.position.x, ent.position.z], before, `${mode} must already be collision-free`);
      assert.equal(ent.position.y, mode === 'helicopter' ? 120 : controller.getGroundHeight(result.x, result.z, mode));
    }
  }
});

test('teleports use oriented building footprints without rejecting clear corners of their bounds', () => {
  const cs = Math.SQRT1_2;
  const box = { minX: -8, maxX: 8, minZ: -8, maxZ: 8, maxY: 200, obb: { cx: 0, cz: 0, hx: 8, hz: 2, cs, sn: cs } };
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ ...box }]);
    assert.deepEqual({ ...controller.teleportActiveTo(7, 7, 0.6) }, { x: 7, z: 7 });
    const actual = controller.teleportActiveTo(0, 0, 0.6);
    const before = [actual.x, actual.z];
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65,
      mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], before);
  }
});

test('pedestrians pass clear building corners and resolve real corner hits radially', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.position.x = ent.position.z = -0.4;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [-0.4, -0.4], 'distance to the corner exceeds the body radius');

  ent.position.x = ent.position.z = -0.2;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(Math.hypot(ent.position.x, ent.position.z) - 0.48) < 1e-6);
  assert.ok(Math.abs(ent.position.x - ent.position.z) < 1e-6, 'a diagonal contact pushes along the corner normal');
});

test('corner collision normals follow an oriented building footprint', () => {
  const cs = Math.SQRT1_2;
  const { controller, ent } = teleportHarness('person', [{
    minX: -10 * cs, maxX: 10 * cs, minZ: -10 * cs, maxZ: 10 * cs, maxY: 30,
    obb: { cx: 0, cz: 0, hx: 5, hz: 5, cs, sn: cs }
  }]);
  // Local (-5.2, -5.2) lies just outside the rotated square's leftmost corner.
  ent.position.x = -10.4 * cs;
  ent.position.z = 0;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(ent.position.x - (-10 * cs - 0.48)) < 1e-6);
  assert.ok(Math.abs(ent.position.z) < 1e-6, 'the correction must not slide sideways along the corner');
});

test('rotated cars use their own separating axes at building corners', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.heading = -Math.PI / 4;
  ent.speed = 0;
  ent.vx = ent.vz = 0;
  ent.position.x = ent.position.z = -1.8;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.deepEqual([ent.position.x, ent.position.z], [-1.8, -1.8], 'the projected bounds overlap, but the actual car does not');

  ent.position.x = ent.position.z = -0.3;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.ok(Math.abs(ent.position.x + 0.86 * Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(ent.position.z + 0.86 * Math.SQRT1_2) < 1e-6, 'the shortest correction is perpendicular to the car side');
});

test('teleports preserve clear rounded corners and separated rotated cars', () => {
  for (const [mode, coordinate, heading] of [['person', -0.45, 0], ['car', -1.8, -Math.PI / 4]]) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
    const arrival = controller.teleportActiveTo(coordinate, coordinate, heading);
    assert.deepEqual({ ...arrival }, { x: coordinate, z: coordinate }, `${mode} has room including the arrival margin`);
    controller.resolveHorizontalCollision(ent.position, mode === 'person' ? 0.48 : 1.35, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [coordinate, coordinate], 'teleport clearance agrees with movement');

    const blocked = controller.teleportActiveTo(-0.2, -0.2, heading);
    assert.notDeepEqual({ ...blocked }, { x: -0.2, z: -0.2 }, 'a real corner overlap still needs a different arrival');
  }
});

test('movement and teleports pass underneath elevated building sections', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 4, maxY: 30 }]);
    controller.getGroundHeight = () => 0;
    const y = mode === 'helicopter' ? 0.25 : 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} fits below the overhang`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('building clearance uses the full player height beneath an overhang', () => {
  for (const [mode, height] of [['person', 1.9], ['car', 1.8], ['cyclist', 1.9], ['helicopter', 3.2]]) {
    const y = mode === 'helicopter' ? 0.25 : 0;
    const { controller, ent } = teleportHarness(mode, [{
      minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: y + height - 0.1, maxY: 30
    }]);
    controller.getGroundHeight = () => 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} intersects the underside`);
    assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('players above a roof are clear once their body bottoms clear it', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
    controller.getGroundHeight = () => 10.1;
    const y = mode === 'helicopter' ? 10.35 : 10.1;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} clears the visible roof`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('helicopter skids cannot pass through a roof below the body origin', () => {
  const { controller, ent } = teleportHarness('helicopter', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
  Object.assign(ent.position, { x: 5, y: 10.2, z: 5 });
  controller.resolveHorizontalCollision(ent.position, 4.5);
  assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5]);
  assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, 10.2) }, { x: 5, z: 5 });
});

test('ground arrivals share movement shoreline limits while helicopters may remain above lower buildings', () => {
  const shore = z => ({ westX: -40 + z * 0.05, eastX: 40 + z * 0.05 });
  const { controller, ent } = teleportHarness('person', [], shore);
  const result = controller.teleportActiveTo(1000, -1000);
  assert.deepEqual({ ...result }, { x: 8.5, z: -470 });
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [result.x, result.z]);

  const heli = teleportHarness('helicopter', [{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, maxY: 50 }]);
  heli.ent.position.y = 10;
  assert.deepEqual({ ...heli.controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(heli.ent.position.y, 92);
});

test('a displaced pedestrian samples ground and resets its feet at the resolved destination', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: -4, maxX: 0, minZ: -10, maxZ: 10, maxY: 30 }]);
  assert.deepEqual({ ...controller.teleportActiveTo(-1, 0) }, { x: 3, z: 0 });
  assert.equal(ent.position.y, 0.22, 'the requested point was on the higher ground, but the clear arrival is lower');
  assert.deepEqual(ent.rig.resetArgs.slice(0, 2), [3, 0]);
});

test('failed or invalid teleports keep the current position and stop the player with bounded search', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: -300, maxX: 300, minZ: -300, maxZ: 300, maxY: 500 }]);
  let checks = 0;
  const near = controller.nearColliders;
  controller.nearColliders = function (...args) { checks++; return near.apply(this, args); };
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 400, z: 400 });
  assert.ok(checks <= 2049, 'the search must be bounded even inside an enormous obstacle');
  assert.equal(ent.speed, 0);
  assert.equal(ent.vx, 0);
  assert.equal(ent.angularVel, 0);
  assert.deepEqual({ ...controller.teleportActiveTo(NaN, Infinity) }, { x: 400, z: 400 });
});

test('successive mode teleports keep parked players out of the arrival and default chase view', () => {
  const { controller, ent: car } = teleportHarness('car');
  const person = teleportHarness('person').ent;
  const cyclist = teleportHarness('cyclist').ent;
  controller.entities = { car, person, cyclist };
  person.position.x = 300;
  cyclist.position.x = 200;
  const heading = Math.PI / 2; // The first radial candidate is +X: its rear camera would sit on the parked car.
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0, heading) }, { x: 0, z: 0 });
  const arrivals = [car];
  const radii = { car: 2.4, person: 0.48, cyclist: 1.0 };
  for (const mode of ['person', 'cyclist']) {
    controller.activeMode = mode;
    const ent = controller.entities[mode];
    const actual = controller.teleportActiveTo(0, 0, heading);
    assert.notDeepEqual({ ...actual }, { x: 0, z: 0 });
    for (const parked of arrivals) {
      const dx = parked.position.x - actual.x, dz = parked.position.z - actual.z;
      const cameraBack = Math.cos(0.09) * ent.chaseDistance;
      const along = Math.max(0, Math.min(cameraBack, -dx));
      assert.ok(Math.hypot(dx, dz) > radii[parked.type] + radii[mode], 'player bodies must not overlap');
      assert.ok(Math.hypot(dx + along, dz) > radii[parked.type] + 0.5, 'the complete default chase corridor must be clear');
    }
    assert.deepEqual([car.position.x, car.position.z], [0, 0], 'switching modes leaves the parked car in place');
    arrivals.push(ent);
  }
});

test('player clearance respects altitude and permits a ground arrival under an airborne helicopter', () => {
  const { controller, ent } = teleportHarness('person');
  const helicopter = teleportHarness('helicopter').ent;
  helicopter.position.x = helicopter.position.z = 0;
  helicopter.position.y = 120;
  controller.entities.helicopter = helicopter;
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(ent.position.y, 0.22);
  helicopter.position.y = 1;
  assert.notDeepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 }, 'a helicopter parked at street level must be avoided');
});

// All four players in a small world: sidewalks west of x = 0, Central Park's raised lawn around (-350, -350)
function worldHarness(colliders = [], shore = () => ({ westX: -500, eastX: 500 })) {
  const harness = keyboardHarness({
    ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: -400, maxX: -300, minZ: -400, maxZ: -300 },
    getIslandBoundsAtZ: shore,
    blockAt: (x) => (x < 0 ? { park: 0 } : null)
  });
  const { controller } = harness;
  const position = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const pivot = () => ({ position: position(), rotation: { x: 0, y: 0, z: 0 } });
  const crowd = () => ({ begin() {}, add() {}, end() {} });
  const chain = { set: () => chain, applyQuaternion: () => chain, add: () => chain };
  controller.entities = {
    person: {
      type: 'person', mesh: pivot(), crowd: crowd(), position: position(-5, 0.22, 0), heading: 0, speed: 0, verticalVel: 0,
      chaseDistance: 4.3, chaseHeight: 1.95,
      rig: { airs: [], reset() {}, update(...args) { this.airs.push(args[6]); } }
    },
    car: {
      type: 'car', mesh: pivot(), chassisPivot: pivot(), carState: { value: { x: 0 } }, headLights: [],
      wheels: [true, true, false, false].map((isFront) => ({ isFront, steerPivot: pivot(), tire: pivot() })),
      position: position(5, 0, 0), heading: 0, speed: 0, vx: 0, vz: 0, angularVel: 0, pitchVel: 0, rollVel: 0,
      heaveY: 0, heaveVel: 0, lastCollisionSpark: null, steerAngle: 0, wheelSpin: 0, chaseDistance: 6.9, chaseHeight: 2.12
    },
    cyclist: {
      type: 'cyclist', mesh: pivot(), leanPivot: pivot(), frontWheel: pivot(), rearWheel: pivot(), crankPivot: pivot(),
      pedals: [pivot(), pivot()], bikeFrame: {}, riderCrowd: crowd(), riderRig: { ride() {} },
      helmet: { quaternion: { copy() {} }, position: chain }, headLight: { intensity: 0 },
      position: position(10, 0, 20), heading: 0, speed: 0, leanAngle: 0, pedalPhase: 0, chaseDistance: 4.8, chaseHeight: 2.05
    },
    helicopter: {
      type: 'helicopter', mesh: pivot(), tiltPivot: pivot(), mainRotorPivot: pivot(), tailRotorPivot: pivot(),
      position: position(0, 100, -100), heading: 0, speed: 0, verticalSpeed: 0, pitchAngle: 0, rollAngle: 0,
      chaseDistance: 11.4, chaseHeight: 3.3
    }
  };
  controller.activeMode = 'car';
  controller.colliders = colliders;
  controller._colliderCells = null;
  const run = (seconds, fps = 60) => {
    for (let i = 0; i < Math.round(seconds * fps); i++) controller.update(1 / fps, i / fps);
  };
  return { ...harness, run };
}

test('the parked pedestrian stands where it was left instead of wandering off or hovering', () => {
  const { controller, run } = worldHarness();
  const person = controller.entities.person;
  // At the curb, facing the roadway: walking on would leave it hovering at sidewalk height over the street.
  Object.assign(person.position, { x: -0.3, y: 0.22, z: 0 });
  person.heading = Math.PI / 2;
  run(30);
  assert.deepEqual([person.position.x, person.position.y, person.position.z], [-0.3, 0.22, 0]);
  assert.equal(person.speed, 0);
  assert.ok(person.rig.airs.every((air) => air === 0), 'the rig never takes the airborne pose');
});

test('a pedestrian left in mid-jump finishes the jump and lands where it is', () => {
  const { controller, run } = worldHarness();
  const person = controller.entities.person;
  controller.activeMode = 'person';
  controller.keys.up = true;
  run(0.1);
  controller.keys.up = false;
  const [x, z, y] = [person.position.x, person.position.z, person.position.y];
  assert.ok(person.verticalVel > 0 && y > 0.5, 'rising');
  controller.setMode('car');
  let peak = y;
  for (let i = 0; i < 60; i++) {
    controller.update(1 / 60, i / 60);
    peak = Math.max(peak, person.position.y);
  }
  assert.ok(peak > y, 'the jump carries on to its top rather than stopping in mid-air');
  assert.deepEqual([person.position.x, person.position.y, person.position.z], [x, 0.22, z]);
  assert.equal(person.verticalVel, 0);
  assert.equal(person.rig.airs.at(-1), 0, 'standing again once landed');
});

test('switching modes parks the player being left at rest where it is', () => {
  const { controller, run } = worldHarness();
  const { car, cyclist, helicopter, person } = controller.entities;
  const drive = (mode) => {
    controller.setMode(mode);
    Object.assign(controller.keys, { forward: true, boost: true, left: true, up: mode === 'helicopter' });
    run(1.5);
    Object.assign(controller.keys, { forward: false, boost: false, left: false, up: false });
  };

  drive('car');
  assert.ok(car.speed > 20 && car.steerAngle > 0.3 && car.chassisPivot.rotation.z !== 0);
  car.lastCollisionSpark = { speed: 5 };
  const parked = [car.position.x, car.position.y, car.position.z, car.heading];
  controller.setMode('car');
  assert.ok(car.speed > 20, 'reselecting the active mode leaves it moving');
  drive('cyclist');
  for (const field of ['speed', 'vx', 'vz', 'angularVel', 'steerAngle', 'pitchVel', 'rollVel', 'heaveY', 'heaveVel']) {
    assert.equal(car[field], 0, field);
  }
  assert.deepEqual([car.chassisPivot.rotation.x, car.chassisPivot.rotation.z, car.chassisPivot.position.y], [0, 0, 0]);
  assert.ok(car.wheels.every((wheel) => wheel.steerPivot.rotation.y === 0));
  assert.equal(car.lastCollisionSpark, null, 'no stale crash sparks when the taxi is driven again');
  assert.equal(car.carState.value.x, 1, 'brake lights show it standing');
  assert.deepEqual([car.position.x, car.position.y, car.position.z, car.heading], parked);

  assert.ok(cyclist.speed > 10 && cyclist.leanAngle !== 0);
  drive('helicopter');
  assert.deepEqual([cyclist.speed, cyclist.leanAngle, cyclist.leanPivot.rotation.z], [0, 0, 0]);
  assert.ok(helicopter.speed > 20 && helicopter.verticalSpeed > 10 && helicopter.pitchAngle > 0);
  const altitude = helicopter.position.y;
  controller.setMode('person');
  for (const field of ['speed', 'verticalSpeed', 'pitchAngle', 'rollAngle']) assert.equal(helicopter[field], 0, field);
  assert.deepEqual([helicopter.tiltPivot.rotation.x, helicopter.tiltPivot.rotation.z], [0, 0]);
  assert.equal(helicopter.position.y, altitude, 'it hovers where it was left');

  Object.assign(controller.keys, { forward: true });
  run(1);
  controller.keys.forward = false;
  assert.ok(person.speed > 3);
  controller.setMode('car');
  assert.equal(person.speed, 0);

  // Coming back, the taxi waits where it was parked instead of lurching off at its old speed.
  run(1);
  assert.deepEqual([car.position.x, car.position.y, car.position.z, car.heading], parked);
  assert.equal(car.speed, 0);
});

test('restoring saved players still lands each at rest at its saved spot', () => {
  const { controller } = worldHarness();
  const saved = {
    person: { x: -40, y: 0.22, z: 60, heading: 1 },
    car: { x: 40, y: 0, z: 60, heading: 2 },
    cyclist: { x: 40, y: 0, z: -60, heading: 3 },
    helicopter: { x: -40, y: 140, z: -60, heading: 0.5 }
  };
  // As main.js does on load, from the default taxi
  for (const [mode, p] of Object.entries(saved)) {
    controller.setMode(mode);
    controller.teleportActiveTo(p.x, p.z, p.heading, p.y);
  }
  controller.setMode('cyclist');
  assert.equal(controller.activeMode, 'cyclist');
  for (const [mode, p] of Object.entries(saved)) {
    const ent = controller.entities[mode];
    assert.deepEqual([ent.position.x, ent.position.y, ent.position.z, ent.heading], [p.x, p.y, p.z, p.heading], mode);
    assert.equal(ent.speed, 0);
  }
});

for (const mode of ['cyclist', 'helicopter']) {
  test(`a ${mode} driven into a wall stops instead of staying pinned at full speed`, () => {
    for (const reverse of [false, true]) {
      const { controller, run } = worldHarness([{ minX: -60, maxX: 60, minZ: 40, maxZ: 80, maxY: 400 }]);
      controller.setMode(mode);
      const ent = controller.entities[mode];
      // Heading south from north of the wall, or backing north into it from the south
      Object.assign(ent.position, { x: 0, z: reverse ? 120 : 0 });
      ent.heading = 0;
      const reports = [];
      controller.setCollisionListener((event) => reports.push(event.speed));
      Object.assign(controller.keys, { [reverse ? 'backward' : 'forward']: true, boost: true });
      run(reverse ? 10 : 5);
      assert.ok(reports.length > 0 && reports[0] > 3, 'it hits the wall');
      assert.equal(Math.abs(ent.speed), 0, 'pinned against the wall the speed reads zero');
      assert.equal(reports.length, 1, 'one impact, not a crash every frame while pinned');
      if (mode === 'cyclist') {
        const spin = ent.frontWheel.rotation.x, pedals = ent.pedalPhase;
        run(0.5);
        assert.ok(Math.abs(ent.frontWheel.rotation.x - spin) < 0.1 && ent.pedalPhase - pedals < 0.05, 'wheels and pedals stop');
      }
      // Steering free does not launch it at the speed it had when it hit.
      Object.assign(controller.keys, { forward: false, backward: false, boost: false, left: true });
      run(1);
      assert.ok(Math.abs(ent.speed) < 0.5);
    }
  });

  test(`a ${mode} scraping along a wall keeps most of its speed, alike at any frame rate`, () => {
    const scrape = (degrees, fps) => {
      // A long wall to the east, the player heading south and turned toward it, starting 1.5 m clear of it
      const { controller } = worldHarness([{ minX: 8, maxX: 60, minZ: -450, maxZ: 450, maxY: 400 }]);
      controller.setMode(mode);
      const ent = controller.entities[mode];
      Object.assign(ent.position, { x: 8 - (mode === 'helicopter' ? 4.5 : 0.65) - 1.5, z: -440 });
      ent.heading = degrees * Math.PI / 180;
      let hit = false, contact = null, total = 0, frames = 0;
      controller.setCollisionListener(() => { hit = true; });
      controller.keys.forward = true;
      for (let i = 0; i < 8 * fps; i++) {
        const before = ent.speed;
        controller.update(1 / fps, i / fps);
        if (hit && !contact) contact = { before, after: ent.speed };
        if (i >= 7 * fps) { total += ent.speed; frames++; }
      }
      return { contact, steady: total / frames };
    };
    const glancing = scrape(3, 60);
    assert.ok(glancing.contact && glancing.contact.after > glancing.contact.before * 0.99, 'a glancing scrape barely slows it');
    const rates = [30, 60, 144].map((fps) => scrape(10, fps).steady);
    const top = mode === 'helicopter' ? 32 : 12.8;
    assert.ok(rates[1] > 3 && rates[1] < top * 0.6, 'pressing on into the wall drags it, but it still moves');
    for (const steady of rates) assert.ok(Math.abs(steady / rates[1] - 1) < 0.06, `${rates} differ with the frame rate`);
  });
}

test('a cyclist pedalling head-on against a wall steers away from it at any frame rate', () => {
  for (const fps of [60, 120, 144]) {
    for (const boost of [false, true]) {
      const { controller } = worldHarness([{ minX: -60, maxX: 60, minZ: 40, maxZ: 80, maxY: 400 }]);
      controller.setMode('cyclist');
      const bike = controller.entities.cyclist;
      Object.assign(bike.position, { x: 0, z: 0 });
      bike.heading = 0;
      Object.assign(controller.keys, { forward: true, boost });
      for (let i = 0; i < 5 * fps; i++) controller.update(1 / fps, i / fps);
      assert.ok(bike.speed < 0.2, 'held up against the wall');
      // Pedalling on with left held, as when riding into a building at the end of a street
      controller.keys.left = true;
      let frames = 0, fastest = 0;
      while (bike.heading < Math.PI / 2 && frames < fps) {
        controller.update(1 / fps, frames++ / fps);
        fastest = Math.max(fastest, bike.speed);
      }
      const label = `${fps} fps${boost ? ' with boost' : ''}`;
      assert.ok(bike.heading >= Math.PI / 2, `${label}: it turns away from the wall while pedalling`);
      assert.ok(fastest < 4, `${label}: it pulls away from rest instead of launching (${fastest} m/s)`);
      controller.keys.left = false;
      const x = bike.position.x;
      for (let i = 0; i < fps; i++) controller.update(1 / fps, i / fps);
      assert.ok(bike.speed > 6 && bike.position.x - x > 4, `${label}: and rides off along it`);
    }
  }
});

test('the shore pushes square to itself: a cyclist glances along a slanted shore and stops riding into it', () => {
  // The east shore turned 26.6° from the street grid
  const slanted = (z) => ({ westX: -500, eastX: 100 + 0.5 * z });
  const lineX = (z) => slanted(z).eastX - 8;
  const ride = (degrees) => {
    const { controller, run } = worldHarness([], slanted);
    controller.setMode('cyclist');
    const bike = controller.entities.cyclist;
    Object.assign(bike.position, { x: lineX(-300) - 0.5, z: -300 });
    bike.heading = Math.atan2(0.5, 1) + degrees * Math.PI / 180;
    bike.speed = 12.8;
    controller.keys.forward = true;
    run(3);
    return bike;
  };
  const glancing = ride(2);
  assert.ok(glancing.speed > 12.5, `2° into it, it keeps its speed (${glancing.speed} m/s)`);
  assert.ok(Math.abs(glancing.position.x - lineX(glancing.position.z)) < 1e-6, 'running along the shore');
  const headOn = ride(90);
  assert.ok(headOn.speed < 0.2, `square into it, it stops (${headOn.speed} m/s)`);
});

test('a cyclist riding along the side of a pier slides on along it instead of being held in place', () => {
  // A pier reaching 100 m further east for z >= 2: its side is a steep stretch of shore, almost along the cross street
  const pier = (z) => ({ westX: -500, eastX: z < 0 ? 100 : z < 2 ? 100 + 50 * z : 200 });
  const { controller, run } = worldHarness([], pier);
  controller.setMode('cyclist');
  const bike = controller.entities.cyclist;
  // Due east along z = 1, whose shore line is reached at x = 142
  Object.assign(bike.position, { x: 130, z: 1 });
  bike.heading = Math.PI / 2;
  bike.speed = 12.8;
  controller.keys.forward = true;
  run(1.5);
  assert.ok(bike.position.x > 142 + 6 && bike.speed > 12, `it carries on along the pier's side (x ${bike.position.x})`);
  run(5);
  assert.ok(Math.abs(bike.position.x - 192) < 0.5 && bike.position.z > 1 && bike.position.z < 2.5, 'up to the pier end');
  assert.ok(bike.speed < 0.2, 'where it stops, square against the shore');
});

test('the helicopter settles onto a raised park lawn and answers the collective at once at its limits', () => {
  for (const fps of [20, 30, 60]) {
    const { controller, run } = worldHarness();
    controller.setMode('helicopter');
    const heli = controller.entities.helicopter;
    Object.assign(heli.position, { x: -350, y: 6, z: -350 });
    const landings = [];
    controller.setCollisionListener((event) => { if (event.kind === 'ground') landings.push({ y: event.y, speed: event.speed }); });
    controller.keys.down = true;
    run(3, fps);
    assert.equal(heli.position.y, 1.24 + 0.25, 'the skids rest on the lawn, not a metre inside it');
    assert.equal(heli.verticalSpeed, 0);
    assert.equal(landings.length, 1, `one touchdown at ${fps} fps, however long descend is held`);
    assert.ok(landings[0].y === heli.position.y && landings[0].speed > 10);
    controller.keys.down = false;
    controller.keys.up = true;
    controller.update(1 / fps, 0);
    assert.ok(heli.verticalSpeed > 0 && heli.position.y > 1.49, 'it lifts off on the first frame');

    heli.position.y = 379;
    run(2, fps);
    assert.equal(heli.position.y, 380);
    assert.equal(heli.verticalSpeed, 0);
    controller.keys.up = false;
    controller.keys.down = true;
    controller.update(1 / fps, 0);
    assert.ok(heli.position.y < 380, 'it descends from the ceiling on the first frame');
  }
});

test('a helicopter restored onto a park lawn arrives above it', () => {
  const { controller } = worldHarness();
  controller.setMode('helicopter');
  const heli = controller.entities.helicopter;
  // An altitude saved while the floor ignored the park
  assert.deepEqual({ ...controller.teleportActiveTo(-350, -350, 0, 0.25) }, { x: -350, z: -350 });
  assert.equal(heli.position.y, 1.49);
  controller.update(1 / 60, 0);
  assert.equal(heli.position.y, 1.49);
});

test('releasing helicopter boost bleeds off the extra speed instead of snapping to the normal limit', () => {
  for (const reverse of [false, true]) {
    const { controller, run } = worldHarness();
    controller.setMode('helicopter');
    const heli = controller.entities.helicopter;
    Object.assign(heli.position, { x: 0, y: 150, z: reverse ? 400 : -400 });
    Object.assign(controller.keys, { [reverse ? 'backward' : 'forward']: true, boost: true });
    run(3);
    const [boosted, normal] = reverse ? [-52 * 0.6, -32 * 0.6] : [52, 32];
    assert.ok(Math.abs(heli.speed - boosted) < 1e-9);
    controller.keys.boost = false;
    let previous = heli.speed;
    for (let i = 0; i < 90; i++) {
      controller.update(1 / 60, i / 60);
      const change = Math.abs(heli.speed - previous);
      assert.ok(change <= 24 / 60 + 1e-9, `one frame lost ${change} m/s`);
      assert.ok(Math.abs(heli.speed) >= Math.abs(normal) - 1e-9, 'never below the normal limit while thrusting');
      assert.ok(Math.abs(heli.pitchAngle) <= (reverse ? 0.6 : 1) * 0.24 + 1e-9, 'no extra nose-down (nose-up in reverse) while slowing');
      previous = heli.speed;
    }
    assert.ok(Math.abs(heli.speed - normal) < 1e-9, 'settled on the normal limit');
  }
});
