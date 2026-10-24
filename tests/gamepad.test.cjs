const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/gamepad-controls.js'), 'utf8');
const controllersSource = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
const isTypingInField = (event) => ['INPUT', 'SELECT'].includes(event.target?.tagName);

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

// The production controller's input blending and physics, without its 3D models
function playerController(window, document) {
  const { ThirdPersonControllerManager } = loadModule(controllersSource, {
    globals: { window, document },
    imports: {
      'three/webgpu': {},
      './city-config.js': { streetZ: () => 0, isTypingInField },
      './tsl-materials.js': {},
      './actor-models.js': {},
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './landmarks.js': {}
    }
  });
  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down', 'boost'].map((action) => [action, false]));
  controller.bindKeyboard();
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  return controller;
}

function harness({ mode = 'car', player = false } = {}) {
  const pad = {
    connected: true, mapping: 'standard', index: 0, id: 'Standard Gamepad',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  };
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false, hasFocus: () => true, activeElement: { tagName: 'BODY' } };
  const navigator = { getGamepads: () => [pad] };
  const input = {};
  const controller = player ? playerController(window, document) : {
    setGamepadInput(action, value) { input[action] = value; },
    clearGamepadInput() { for (const action of Object.keys(input)) input[action] = 0; }
  };
  controller.activeMode = mode;
  const camera = { resetOrbit() {}, applyGamepadInput() {} };
  const { GamepadControls } = loadModule(source, {
    globals: { window, document, navigator },
    imports: { './city-config.js': { isTypingInField } }
  });
  const controls = new GamepadControls(controller, camera);
  const triggers = (left, right) => {
    pad.buttons[6].value = left;
    pad.buttons[7].value = right;
  };
  return { controls, controller, pad, input, triggers };
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} should be close to ${expected}`);
}

test('triggers resting a little above zero neither drive, brake nor change altitude', () => {
  for (const mode of ['car', 'cyclist', 'helicopter']) {
    for (const rest of [0.004, 0.02, 0.06, 0.1]) {
      for (const [left, right] of [[rest, 0], [0, rest], [rest, rest]]) {
        const { controls, input, triggers } = harness({ mode });
        triggers(left, right);
        controls.update(1 / 60);
        for (const action of ['forward', 'backward', 'up', 'down']) {
          assert.equal(input[action], 0, `${mode} ${action} with triggers at ${left} / ${right}`);
        }
      }
    }
  }
});

test('trigger travel past the deadzone is rescaled to the full range', () => {
  const { controls, controller, input, triggers } = harness({ mode: 'car' });
  triggers(0, 0.55);
  controls.update(1 / 60);
  near(input.forward, 0.5);
  triggers(0, 1);
  controls.update(1 / 60);
  assert.equal(input.forward, 1);
  triggers(0.28, 0);
  controls.update(1 / 60);
  near(input.backward, 0.2);
  assert.equal(input.forward, 0);

  controller.activeMode = 'helicopter';
  triggers(0.02, 0.775);
  controls.update(1 / 60);
  near(input.up, 0.75);
  assert.equal(input.down, 0);
  assert.equal(input.forward, 0, 'the helicopter pitches with the stick, not the triggers');
  triggers(1, 0.05);
  controls.update(1 / 60);
  assert.equal(input.down, 1);
  assert.equal(input.up, 0);
});

test('a resting accelerator lets the taxi stand and coast instead of creeping', () => {
  const run = (rest) => {
    const { controls, controller, triggers } = harness({ mode: 'car', player: true });
    const car = {
      position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0,
      pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
      chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: []
    };
    controller.entities = { car };
    const frames = (seconds, left, right) => {
      triggers(left, right);
      for (let i = 0; i < seconds * 60; i++) {
        controls.update(1 / 60);
        controller.updateCar(1 / 60);
      }
    };
    frames(30, 0, rest);
    const standing = car.speed;
    frames(3, 0, 1);
    frames(2, 0, rest);
    return { standing, coasted: car.speed, forward: controller.keys.forward };
  };
  const resting = run(0.02), released = run(0);
  assert.equal(resting.standing, 0, 'no creeping away from a standstill');
  assert.equal(resting.forward, false);
  assert.equal(resting.coasted, released.coasted, 'it coasts exactly as with the trigger fully released');
});

test('a resting trigger lets the helicopter settle after a descent', () => {
  const { controls, controller, triggers } = harness({ mode: 'helicopter', player: true });
  const heli = {
    position: { x: 0, y: 200, z: 0 }, heading: 0, speed: 0, verticalSpeed: 0, pitchAngle: 0, rollAngle: 0,
    tiltPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }
  };
  controller.entities = { helicopter: heli };
  const frames = (seconds, left) => {
    triggers(left, 0);
    for (let i = 0; i < seconds * 60; i++) {
      controls.update(1 / 60);
      controller.updateHelicopter(1 / 60, i / 60);
    }
  };
  frames(1.5, 1);
  assert.equal(heli.verticalSpeed, -16);
  frames(3, 0.02);
  assert.equal(controller.keys.down, false);
  assert.ok(Math.abs(heli.verticalSpeed) < 0.01, `still descending at ${heli.verticalSpeed} m/s`);
});
