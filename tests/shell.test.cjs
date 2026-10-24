const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/main.js'), 'utf8');
const html = readFileSync(join(__dirname, '../index.html'), 'utf8');

const BUTTON_GROUPS = ['data-mode', 'data-camera', 'data-time'];
const FOLLOW_CAMERAS = ['chase', 'action', 'pov'];
const FAILED = 'Slop New York couldn’t start. Reload the page to try again.';

function attributesOf(text) {
  const attributes = text.matchAll(/([\w-]+)(?:="([^"]*)")?/g);
  return Object.fromEntries([...attributes].map(([, name, value = '']) => [name, value]));
}

// The elements of index.html that main.js reaches: by id, as a mode, camera, time or teleport button, and the loader
const markup = [...html.matchAll(/<([a-z]+)\s([^>]*)>/g)]
  .map(([, tagName, attributes]) => ({ tagName, attributes: attributesOf(attributes) }))
  .filter(({ attributes }) => attributes.id || /^loader(-track)?\b/.test(attributes.class || ''));

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.listeners = new Map();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.textContent = '';
    this.title = attributes.title || '';
    this.offsetLeft = 0;
    this.offsetWidth = 0;
    this.selectors = {};
    const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name);
        else classes.delete(name);
        return Boolean(force);
      }
    };
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: (value) => {
        classes.clear();
        for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name);
      }
    });
  }

  // Start-up errors and HUD text are written with textContent only
  get innerHTML() { throw new Error('innerHTML is not used by the HUD'); }
  set innerHTML(_value) { throw new Error('innerHTML is not used by the HUD'); }

  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  click() { this.dispatch('click', { detail: 0, target: this }); }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  after(...nodes) {
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, ...nodes);
    for (const node of nodes) node.parentNode = this.parentNode;
  }

  querySelector(selector) { return this.selectors[selector] || null; }
}

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

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Runs main.js's start-up for real, against index.html's elements and stand-ins for three.js and the city modules
async function startApp({ webgpu = true, webgl2 = true, initError = null, buildError = null, savedMode = null, lostDuringSetup = null } = {}) {
  const elements = markup.map(({ tagName, attributes }) => new FakeElement(tagName, attributes));
  const byId = new Map(elements.filter((el) => el.attributes.id).map((el) => [el.attributes.id, el]));
  const buttons = {};
  for (const attribute of [...BUTTON_GROUPS, 'data-teleport']) {
    buttons[attribute] = elements.filter((el) => el.tagName === 'BUTTON' && el.getAttribute(attribute) !== null);
  }
  const overlay = byId.get('loading-overlay');
  const status = byId.get('loading-status');
  const track = elements.find((el) => el.classList.contains('loader-track'));
  overlay.selectors['.loader-track'] = track;
  elements.find((el) => el.classList.contains('loader')).appendChild(status);
  byId.get('btn-sound').selectors.use = new FakeElement('use');
  byId.get('mode-switch').querySelector = (selector) => (selector === '.mode-btn.active'
    ? buttons['data-mode'].find((btn) => btn.classList.contains('active')) || null : null);

  const window = { ...eventTarget(), innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 };
  const lists = Object.fromEntries(Object.entries(buttons).map(([attribute, list]) => [`[${attribute}]`, list]));
  const document = {
    ...eventTarget(),
    hidden: false,
    body: new FakeElement('body'),
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (selector) => lists[selector] || [],
    querySelector: () => null,
    createElement(tagName) {
      const el = new FakeElement(tagName);
      if (tagName === 'canvas') el.getContext = (type) => (type === 'webgl2' && webgl2 ? {} : null);
      return el;
    }
  };
  const errors = [];
  const storage = new Map();
  if (savedMode) storage.set('nyc-player-state', JSON.stringify({ version: 1, activeMode: savedMode, entities: {} }));

  // TSL nodes, passes and their uniforms: any property or call chains on
  const node = new Proxy(function () {}, {
    get: (target, key) => (key === 'then' ? undefined : key in target ? target[key] : node),
    apply: () => node,
    set: () => true
  });
  const app = { byId, buttons, overlay, status, track, errors, document };
  const THREE = {
    REVISION: '187dev',
    MaterialBlending: 1,
    BlendMode: class {},
    StorageInstancedBufferAttribute: class {},
    Scene: class {
      getObjectByName() { return null; }
      traverse() {}
      traverseVisible() {}
    },
    RenderPipeline: class {
      constructor() { app.pipeline = this; }
      render() {}
    },
    WebGPURenderer: class {
      constructor() {
        this.domElement = new FakeElement('canvas');
        this.shadowMap = {};
        this.backend = { isWebGPUBackend: webgpu };
        this.loop = null;
        app.renderer = this;
      }
      setPixelRatio() {}
      setSize() {}
      init() { return initError ? Promise.reject(initError) : Promise.resolve(this); }
      setRenderTarget() {}
      setMRT() {}
      compileAsync() { return Promise.resolve(); }
      setAnimationLoop(callback) { this.loop = callback; }
      // three.js's own handling: it logs the loss and draws nothing more
      onDeviceLost(info) { this.lost = info; }
    }
  };
  const PRESETS = buttons['data-camera'].map((btn) => {
    const id = btn.getAttribute('data-camera');
    return { id, name: id, category: FOLLOW_CAMERAS.includes(id) ? 'follow' : 'scenic' };
  });
  const labels = { person: 'Pedestrian', car: 'NYC Yellow Taxi', cyclist: 'Cyclist', helicopter: 'Helicopter' };
  const imports = {
    'three/webgpu': THREE,
    'three/tsl': new Proxy({}, { get: () => node }),
    'three/addons/tsl/display/SSRNode.js': { ssr: () => node },
    'three/addons/lighting/ClusteredLighting.js': { ClusteredLighting: class {} },
    './post-processing.js': { createPostProcessing: () => ({ outputNode: node, applyPreset() {} }) },
    './city-config.js': {
      getLocationLabel: () => '5th Ave & W 37th St',
      isTypingInField: (e) => ['INPUT', 'SELECT'].includes(e.target?.tagName),
      ROADS: [],
      NYC_LANDMARKS: [],
      TELEPORT_LOCATIONS: {}
    },
    './city-grid.js': {
      buildCityGrid() {
        if (buildError) throw buildError;
        // like a WebGPU device's lost promise, the loss arrives at the start-up's next await
        if (lostDuringSetup) queueMicrotask(() => app.renderer.onDeviceLost(lostDuringSetup));
        return { sidewalks: [], colliders: [], footprints: [], highwayLanes: [] };
      }
    },
    './boroughs.js': { buildBoroughs: () => ({ colliders: [], update() {} }) },
    './landmarks.js': { buildLandmarks: () => ({ colliders: [] }) },
    './buildings.js': { buildCityBlocks: () => ({ colliders: [], allBlocks: [], update() {}, updateLights() {} }) },
    './street-details.js': { buildStreetDetails: () => ({ footprints: [], signalClock: { value: 0 }, update() {} }) },
    './traffic.js': {
      createTrafficSystem: () => ({ network: {}, update() {} }),
      createHighwayTraffic: () => ({ update() {} })
    },
    './road-paint.js': { buildRoadPaint() {} },
    './controllers.js': {
      ThirdPersonControllerManager: class {
        constructor() {
          this.entities = Object.fromEntries(Object.entries(labels).map(([mode, label]) => [mode, {
            label, position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0
          }]));
          this.activeMode = 'car';
          this.keys = { boost: false };
          this.keyboardEnabled = true;
          this.inputResets = 0;
          app.controllerManager = this;
        }
        setMode(mode) { if (this.entities[mode]) this.activeMode = mode; }
        getActiveEntity() { return this.entities[this.activeMode]; }
        teleportActiveTo(x, z) { return { x, z }; }
        resetInput() { this.inputResets++; }
        setKeyboardEnabled(enabled) { this.keyboardEnabled = enabled; }
        update() {}
      }
    },
    './touch-controls.js': {
      TouchControls: class {
        constructor() { this.enabled = true; this.available = false; app.touchControls = this; }
        setMode() {}
        reset() {}
        setEnabled(enabled) { this.enabled = enabled; }
      }
    },
    './gamepad-controls.js': {
      GamepadControls: class {
        constructor() { this.enabled = true; app.gamepadControls = this; }
        reset() {}
        setEnabled(enabled) { this.enabled = enabled; }
        update() {}
      }
    },
    './cameras.js': {
      CAMERA_PRESETS: PRESETS,
      CameraSystem: class {
        constructor() {
          this.activePresetId = 'chase';
          this.camera = { position: {} };
          this.currentPos = { x: 0, z: 0 };
          app.cameraSystem = this;
        }
        setCameraPreset(id) { if (PRESETS.some((preset) => preset.id === id)) this.activePresetId = id; }
        getActivePreset() { return PRESETS.find((preset) => preset.id === this.activePresetId); }
        resetForTeleport() {}
        onResize() {}
        update() {}
      }
    },
    './lighting.js': {
      LightingSystem: class {
        constructor() { this.sunLight = { shadow: {} }; this.activePresetId = 'golden'; }
        applyPreset(id) { this.activePresetId = id; }
        update() {}
      }
    },
    './nyc-map.js': {
      NYCMapSystem: class {
        constructor(options) { this.options = options; this.isFullMapOpen = false; app.map = this; }
        toggleFullMap(open) {
          this.isFullMapOpen = Boolean(open);
          this.options.onToggle(this.isFullMapOpen);
        }
        update() {}
        resizeFullCanvas() {}
        renderFullMap() {}
      }
    },
    './scene-culling.js': { setupSceneCulling() {}, updateSceneCulling() {} },
    './audio-system.js': {
      CityAudioSystem: class {
        constructor(_simulation, { onStateChange }) {
          this.supported = true;
          this.enabled = true;
          this.ready = false;
          this.honks = 0;
          this.onStateChange = onStateChange;
          app.audioSystem = this;
        }
        setEnabled(enabled) { this.enabled = enabled; this.onStateChange(); }
        honk() { this.honks++; }
        update() {}
        dispose() {}
      }
    }
  };
  loadModule(source, {
    filename: 'main.js',
    imports,
    globals: {
      window,
      document,
      console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
      localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      performance: { now: () => 0 },
      setTimeout,
      HTMLElement: class {},
      Element: FakeElement
    }
  });
  await settle();

  let time = 0;
  return Object.assign(app, {
    pressed: (attribute) => buttons[attribute].filter((btn) => btn.getAttribute('aria-pressed') === 'true')
      .map((btn) => btn.getAttribute(attribute)),
    key(code, modifiers = {}) {
      const event = { code, repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
      window.dispatch('keydown', { ...event, target: document.body, ...modifiers });
    },
    // One animation frame (a quarter second on, so the HUD telemetry updates too)
    frame() {
      time += 250;
      app.renderer.loop(time);
    },
    // The loading screen's status line and whatever was added after it
    loadingText() {
      const lines = status.parentNode.children;
      return lines.slice(lines.indexOf(status)).map((el) => el.textContent);
    }
  });
}

test('index.html marks the selected mode, camera and time of day with aria-pressed from the start', () => {
  for (const attribute of BUTTON_GROUPS) {
    const tags = [...html.matchAll(new RegExp(`<button ([^>]*\\b${attribute}="[^"]+"[^>]*)>`, 'g'))]
      .map(([, text]) => attributesOf(text));
    assert.ok(tags.length > 2);
    for (const tag of tags) {
      const active = tag.class.split(/\s+/).includes('active');
      assert.equal(tag['aria-pressed'], String(active), `${tag.id} states whether it is selected`);
    }
    assert.equal(tags.filter((tag) => tag['aria-pressed'] === 'true').length, 1, `one ${attribute} button is selected`);
  }
});

test('mode, camera and time buttons keep aria-pressed in step with the selection', async () => {
  const app = await startApp({ savedMode: 'cyclist' });
  // The restored player, not the markup's default taxi
  assert.deepEqual(app.pressed('data-mode'), ['cyclist']);
  assert.deepEqual(app.pressed('data-camera'), ['chase']);
  assert.deepEqual(app.pressed('data-time'), ['golden']);

  app.key('Digit4');
  assert.deepEqual(app.pressed('data-mode'), ['helicopter']);
  app.key('Digit9');
  assert.deepEqual(app.pressed('data-camera'), ['timesSquare']);
  // A scenic camera gives way to the chase camera when the mode changes
  app.buttons['data-mode'].find((btn) => btn.getAttribute('data-mode') === 'person').click();
  assert.deepEqual(app.pressed('data-mode'), ['person']);
  assert.deepEqual(app.pressed('data-camera'), ['chase']);
  app.buttons['data-camera'].find((btn) => btn.getAttribute('data-camera') === 'drone').click();
  assert.deepEqual(app.pressed('data-camera'), ['drone']);
  app.buttons['data-time'].find((btn) => btn.getAttribute('data-time') === 'midnight').click();
  assert.deepEqual(app.pressed('data-time'), ['midnight']);
  for (const btn of [...app.buttons['data-mode'], ...app.buttons['data-camera'], ...app.buttons['data-time']]) {
    assert.equal(btn.classList.contains('active'), btn.getAttribute('aria-pressed') === 'true');
  }
});

test('the HUD names the backend actually drawing the city', async () => {
  const subtitle = html.match(/<div class="brand-subtitle">.*<\/div>/)[0];
  assert.match(subtitle, /^<div class="brand-subtitle">three\.js · <span id="hud-backend">WebGPU<\/span> · TSL · /);
  assert.equal((await startApp({ webgpu: true })).byId.get('hud-backend').textContent, 'WebGPU');
  assert.equal((await startApp({ webgpu: false })).byId.get('hud-backend').textContent, 'WebGL 2');
});

test('the full-screen map takes the keyboard from the player until it closes', async () => {
  const app = await startApp();
  const { controllerManager, touchControls, gamepadControls } = app;
  app.map.toggleFullMap(true);
  assert.equal(controllerManager.keyboardEnabled, false, 'arrow keys, WASD, Space & Shift stop driving');
  assert.equal(controllerManager.inputResets, 1, 'held keys and sticks are let go');
  assert.equal(touchControls.enabled, false);
  assert.equal(gamepadControls.enabled, false);
  app.key('KeyB');
  assert.equal(app.audioSystem.honks, 0, 'no horn behind the map');

  app.map.toggleFullMap(false);
  assert.equal(controllerManager.keyboardEnabled, true);
  assert.equal(touchControls.enabled, true);
  assert.equal(gamepadControls.enabled, true);
  app.key('KeyB');
  assert.equal(app.audioSystem.honks, 1);
});

test('shortcuts act once per press, never on key repeat or as part of a Cmd, Ctrl or Alt combination', async () => {
  const app = await startApp();
  const hudHidden = () => app.document.body.classList.contains('hud-minimized');
  const camera = () => app.cameraSystem.activePresetId;

  app.key('KeyH');
  assert.equal(hudHidden(), true);
  assert.equal(app.byId.get('btn-toggle-hud').getAttribute('aria-pressed'), 'true');
  for (let i = 0; i < 5; i++) app.key('KeyH', { repeat: true });
  assert.equal(hudHidden(), true, 'holding H leaves the HUD as the press set it');
  app.key('KeyH');
  assert.equal(hudHidden(), false);

  for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
    for (const code of ['KeyV', 'Digit1', 'Digit7', 'KeyH', 'KeyN', 'KeyB']) app.key(code, { [modifier]: true });
  }
  assert.equal(camera(), 'chase', 'Cmd+V pastes, it does not cycle cameras');
  assert.equal(app.controllerManager.activeMode, 'car', 'Ctrl+1 / Cmd+1 / Alt+1 belong to the browser');
  assert.equal(hudHidden(), false);
  assert.equal(app.audioSystem.enabled, true);
  assert.equal(app.audioSystem.honks, 0);

  app.key('KeyV');
  assert.equal(camera(), 'action');
  app.key('KeyV', { repeat: true });
  assert.equal(camera(), 'action', 'holding V does not spin through the cameras');
  app.key('KeyV', { shiftKey: true });
  assert.equal(camera(), 'chase', 'Shift+V still steps back');
  app.key('Digit3', { repeat: true });
  assert.equal(app.controllerManager.activeMode, 'car');
  app.key('Digit3', { shiftKey: true });
  assert.equal(app.controllerManager.activeMode, 'cyclist', 'switching modes while boosting still works');
  app.key('KeyN', { repeat: true });
  assert.equal(app.audioSystem.enabled, true);
  app.key('KeyN');
  assert.equal(app.audioSystem.enabled, false);
  app.key('KeyB');
  app.key('KeyB', { repeat: true });
  assert.equal(app.audioSystem.honks, 1);
  app.key('Digit1', { target: { tagName: 'INPUT' } });
  assert.equal(app.controllerManager.activeMode, 'cyclist', 'typing a search does not switch modes');
});

test('the loading screen gives way to the city once its first frame is on screen', async () => {
  const app = await startApp();
  assert.equal(app.overlay.classList.contains('hidden'), false);
  app.frame();
  await settle();
  assert.equal(app.overlay.classList.contains('hidden'), true);
  assert.equal(app.overlay.classList.contains('is-error'), false);
  assert.equal(app.audioSystem.ready, true);
  assert.deepEqual(app.errors, []);

  // Once the city runs, a failing frame surfaces as usual instead of being swallowed
  const failure = new Error('lost uniform');
  app.pipeline.render = () => { throw failure; };
  assert.throws(() => app.frame(), failure);
  assert.equal(app.overlay.classList.contains('is-error'), false);
  assert.notEqual(app.renderer.loop, null);
});

test('a browser with neither WebGPU nor WebGL 2 is told so on the loading screen', async () => {
  const cause = new TypeError("Cannot read properties of null (reading 'getSupportedExtensions')");
  const app = await startApp({ initError: cause, webgl2: false });
  assert.equal(app.overlay.classList.contains('is-error'), true);
  assert.equal(app.overlay.classList.contains('hidden'), false);
  assert.equal(app.track.classList.contains('is-indeterminate'), false, 'the progress stops');
  const [title, detail] = app.loadingText();
  assert.equal(title, 'This browser can’t run Slop New York');
  assert.match(detail, /WebGPU or WebGL 2/);
  assert.match(detail, /hardware acceleration/);
  assert.equal(app.errors.length, 1);
  assert.equal(app.errors[0].at(-1), cause, 'the console keeps the error itself');
  assert.equal(app.renderer.loop, null, 'nothing else starts');
});

for (const [name, options] of [
  ['the renderer fails although WebGL 2 is available', { initError: new Error('THREE.WebGLBackend: bad context') }],
  ['an incompatible three.js build breaks the city build', { buildError: new TypeError('scene.foo is not a function') }]
]) {
  test(`a start-up that fails because ${name} shows its error instead of a stalled loading screen`, async () => {
    const app = await startApp(options);
    const error = options.initError || options.buildError;
    assert.equal(app.overlay.classList.contains('is-error'), true);
    assert.equal(app.overlay.classList.contains('hidden'), false);
    assert.equal(app.track.classList.contains('is-indeterminate'), false);
    assert.deepEqual(app.loadingText(), [FAILED, `${error.name}: ${error.message}`]);
    assert.equal(app.errors.length, 1);
    assert.equal(app.errors[0].at(-1), error);
    assert.equal(app.renderer.loop, null);
  });
}

test('a frame that fails before the city is on screen ends the start-up with its error', async () => {
  const app = await startApp();
  assert.equal(typeof app.renderer.loop, 'function');
  const failure = new Error('Pipeline creation failed:\n  shader stage: fragment\n  at line 1024');
  // The warm-up frame compiles what precompileShaders() couldn't
  app.pipeline.render = () => { throw failure; };
  app.frame();
  await settle();
  assert.equal(app.renderer.loop, null, 'the loop stops instead of throwing every frame behind the loading screen');
  assert.equal(app.overlay.classList.contains('hidden'), false);
  assert.equal(app.overlay.classList.contains('is-error'), true);
  assert.deepEqual(app.loadingText(), [FAILED, 'Error: Pipeline creation failed:']);
  assert.equal(app.errors.length, 1);
  assert.equal(app.errors[0].at(-1), failure);
});

test('a GPU lost before the city is on screen ends the start-up with its error', async () => {
  const app = await startApp();
  const info = { api: 'WebGPU', message: 'Device was lost', reason: 'unknown' };
  app.renderer.onDeviceLost(info);
  assert.equal(app.renderer.lost, info, 'three.js still handles the loss itself');
  assert.equal(app.renderer.loop, null, 'nothing more is drawn');
  assert.equal(app.overlay.classList.contains('is-error'), true);
  assert.deepEqual(app.loadingText(), [FAILED, 'Error: WebGPU device lost: Device was lost']);
  await settle();
  assert.equal(app.overlay.classList.contains('hidden'), false, 'the loading screen stays up with the error');
  assert.equal(app.errors.length, 1);
});

test('a GPU lost while the city is being set up never starts it behind the loading screen', async () => {
  const app = await startApp({ lostDuringSetup: { api: 'WebGL', message: 'Unknown reason', reason: null } });
  assert.equal(app.renderer.loop, null);
  assert.equal(app.overlay.classList.contains('is-error'), true);
  assert.deepEqual(app.loadingText(), [FAILED, 'Error: WebGL device lost: Unknown reason']);
  assert.equal(app.errors.length, 1);
});

test('a GPU lost once the city runs is left to three.js', async () => {
  const app = await startApp();
  app.frame();
  await settle();
  assert.equal(app.overlay.classList.contains('hidden'), true);
  const info = { api: 'WebGPU', message: 'Device was lost', reason: 'unknown' };
  app.renderer.onDeviceLost(info);
  assert.equal(app.renderer.lost, info);
  assert.equal(app.overlay.classList.contains('is-error'), false);
  assert.equal(typeof app.renderer.loop, 'function');
  assert.deepEqual(app.errors, []);
});

test('a frame that fails while the GPU finishes the first one keeps its error on screen', async () => {
  const app = await startApp();
  app.frame(); // queues the loading screen's exit for when the GPU is done
  app.pipeline.render = () => { throw new RangeError('x'.repeat(500)); };
  app.frame();
  await settle();
  assert.equal(app.overlay.classList.contains('hidden'), false);
  assert.equal(app.overlay.classList.contains('is-error'), true);
  const [, detail] = app.loadingText();
  assert.ok(detail.startsWith('RangeError: xxx'));
  assert.equal(detail.length, 200, 'a long message is cut short');
  assert.ok(detail.endsWith('…'));
  assert.equal(app.audioSystem.ready, false);
});
