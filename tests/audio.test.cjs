const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/audio-system.js'), 'utf8');
const MASTER = 0.65;
const SILENT = MASTER * 0.01; // 40 dB below the master level: stopping a voice here cannot click
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Records automation the way an AudioParam schedules it, and evaluates the resulting curve at any time.
class FakeParam {
  constructor(context, value) {
    this.context = context;
    this.defaultValue = value;
    this.events = [];
    this.automationRate = 'a-rate';
  }

  get value() { return this.at(this.context.currentTime); }
  set value(value) { this.setValueAtTime(value, this.context.currentTime); }

  insert(event) {
    // Events at the same time keep their call order.
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > event.time) i--;
    this.events.splice(i, 0, event);
    return this;
  }

  setValueAtTime(value, time) { return this.insert({ type: 'set', value, time, rendering: this.context.state === 'running' }); }
  setTargetAtTime(value, time, constant) { return this.insert({ type: 'target', value, time, constant }); }
  cancelScheduledValues(time) {
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }

  at(time) {
    let value = this.defaultValue, curve = null;
    const follow = (t) => curve.constant > 0 ? curve.value + (curve.from - curve.value) * Math.exp(-(t - curve.time) / curve.constant) : curve.value;
    for (const event of this.events) {
      if (event.time > time) break;
      if (curve) value = follow(event.time);
      if (event.type === 'set') { value = event.value; curve = null; }
      else curve = { ...event, from: value };
    }
    return curve ? follow(time) : value;
  }

  // Largest instantaneous jump scheduled while audio rendered: a step in a gain is an audible click. A step set
  // while suspended lands across a gap in the output instead (initial values, or restarting from silence).
  maxStep() {
    let step = 0;
    for (const event of this.events) {
      if (event.type === 'set' && event.rendering) step = Math.max(step, Math.abs(this.at(event.time - 1e-9) - event.value));
    }
    return step;
  }
}

function audioNode(context, params = {}, properties = {}) {
  const node = { connect: (target) => target, disconnect() {}, ...properties };
  for (const [name, value] of Object.entries(params)) node[name] = new FakeParam(context, value);
  return node;
}

// Document listeners keyed like the DOM (type, listener, capture). dispatch() runs capture listeners, then the
// target's own handler, which may stop propagation like the touch controls do, then bubbling listeners.
function fakeDocument(env) {
  const listeners = [];
  const capture = (options) => typeof options === 'boolean' ? options : !!options?.capture;
  const find = (type, listener, options) => listeners.findIndex((entry) =>
    entry.type === type && entry.listener === listener && entry.capture === capture(options));
  return {
    hidden: false,
    listeners,
    addEventListener(type, listener, options) {
      if (find(type, listener, options) < 0) listeners.push({ type, listener, capture: capture(options), passive: !!options?.passive });
    },
    removeEventListener(type, listener, options) {
      const index = find(type, listener, options);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(type, init = {}, atTarget = () => {}) {
      let stopped = false;
      const event = { type, target: { tagName: 'CANVAS' }, stopPropagation() { stopped = true; }, preventDefault() {}, ...init };
      // HTML user activation: Escape-free keydown, mouse pointerdown, touch/pen pointerup and touchend. The click
      // that follows a tap still runs within that activation.
      env.activation = type === 'keydown' ? event.key !== 'Escape'
        : type === 'pointerdown' ? event.pointerType === 'mouse'
          : type === 'pointerup' ? event.pointerType !== 'mouse'
            : type === 'touchend' || type === 'click';
      if (env.activation) env.activated = true;
      try {
        for (const entry of listeners.filter((entry) => entry.type === type && entry.capture)) entry.listener(event);
        if (!stopped) atTarget(event);
        if (!stopped) for (const entry of listeners.filter((entry) => entry.type === type && !entry.capture)) entry.listener(event);
      } finally {
        env.activation = false;
      }
      return event;
    }
  };
}

function harness({ sticky = false } = {}) {
  const env = { activation: false, activated: false, sticky, wall: 0, timers: [], timerId: 0, contexts: [], voices: [], events: [], sources: null };

  class AudioContext {
    constructor(options) {
      this.options = options;
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.state = 'suspended';
      this.onstatechange = null;
      this.destination = audioNode(this);
      this.listener = audioNode(this, { positionX: 0, positionY: 0, positionZ: 0, forwardX: 0, forwardY: 0, forwardZ: -1, upX: 0, upY: 1, upZ: 0 });
      this.resumes = [];
      this.suspends = [];
      env.contexts.push(this);
    }

    createGain() { return audioNode(this, { gain: 1 }); }
    createBiquadFilter() { return audioNode(this, { frequency: 350, detune: 0, Q: 1, gain: 0 }, { type: 'lowpass' }); }
    createPanner() {
      return audioNode(this, { positionX: 0, positionY: 0, positionZ: 0, orientationX: 1, orientationY: 0, orientationZ: 0 },
        { coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 });
    }
    createDynamicsCompressor() { return audioNode(this, { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }); }
    createConvolver() { return audioNode(this, {}, { normalize: true, buffer: null }); }

    setState(state) {
      this.state = state;
      this.onstatechange?.();
    }

    // WebKit needs transient activation for every start; Chrome (sticky) allows it once the page has had any.
    resume() {
      this.resumes.push({ time: this.currentTime, activation: env.activation });
      if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError'));
      if (!env.activation && !(env.sticky && env.activated)) return Promise.reject(new Error('NotAllowedError'));
      return Promise.resolve().then(() => this.setState('running'));
    }

    suspend() {
      this.suspends.push({ time: this.currentTime });
      if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError'));
      return Promise.resolve().then(() => this.setState('suspended'));
    }

    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  const imports = {
    './audio-synthesis.js': {
      createSynthResources: () => ({}),
      setControlRate: () => {},
      createMotorVoice(context, resources, kind) {
        const voice = { kind, created: context.currentTime, disposed: null, state: null, updates: 0,
          update() { voice.updates++; },
          dispose() {
            if (voice.disposed !== null) return;
            voice.disposed = context.currentTime;
            voice.state = context.state;
          } };
        env.voices.push(voice);
        return voice;
      }
    },
    './audio-events.js': {
      createEventResources: (context, resources) => ({ ...resources, impulse: {} }),
      createWindVoice: () => ({ update() {}, dispose() {} }),
      playEvent(context, resources, kind) {
        const event = { kind, created: context.currentTime, endTime: context.currentTime + 2, disposed: null, state: null,
          dispose() {
            if (event.disposed !== null) return;
            event.disposed = context.currentTime;
            event.state = context.state;
          } };
        env.events.push(event);
        return event;
      }
    },
    './audio-sources.js': {
      CityAudioSources: class {
        constructor() {
          this.snapshot = { motors: [], sirens: [], people: [], signals: [], traffic: 0, motion: 0 };
          env.sources = this;
        }
        collect() { return this.snapshot; }
      }
    },
    './audio-acoustics.js': {
      CityAcoustics: class {
        constructor() { this.enclosure = 0; }
        update() {}
        obstruction() { return 0; }
      }
    }
  };

  const document = fakeDocument(env);
  const globals = {
    AudioContext,
    document,
    console,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { hardwareConcurrency: 8 },
    matchMedia: () => ({ matches: false }),
    setTimeout(callback, delay = 0) {
      env.timers.push({ id: ++env.timerId, due: env.wall + delay / 1000, callback });
      return env.timerId;
    },
    clearTimeout(id) {
      const index = env.timers.findIndex((timer) => timer.id === id);
      if (index >= 0) env.timers.splice(index, 1);
    }
  };
  const { CityAudioSystem } = loadModule(source, { imports, globals, filename: 'audio-system.js' });
  const system = new CityAudioSystem({ controllerManager: {}, trafficSystem: {} });
  const camera = {
    position: { x: 0, y: 1.7, z: 0 },
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    updateMatrixWorld() {}
  };
  let elapsed = 0;

  // Wall time drives timers; the audio clock only advances while its context renders.
  async function advance(seconds) {
    const end = env.wall + seconds;
    for (;;) {
      const due = env.timers.filter((timer) => timer.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      const until = due ? Math.max(env.wall, due.due) : end;
      for (const context of env.contexts) if (context.state === 'running') context.currentTime += until - env.wall;
      env.wall = until;
      if (!due) break;
      env.timers.splice(env.timers.indexOf(due), 1);
      due.callback();
      await flush();
    }
    await flush();
  }

  return {
    env,
    system,
    document,
    camera,
    advance,
    get context() { return env.contexts[0]; },
    async frame(dt = 0.1) {
      await advance(dt);
      system.update(dt, elapsed += dt, camera);
    },
    // Idling cars around a point; each placement is a new set of simulation objects.
    place(x, z, count = 3) {
      env.sources.snapshot.motors = Array.from({ length: count }, (_, i) => ({
        id: { car: i }, kind: 'sedan', x: x + 6 + i * 4, y: 0.7, z: z + 3, speed: 4, load: 0.3, verticalSpeed: 0, heading: 0,
        police: false, player: false, seed: i / count, blocked: false, gain: 0.5, range: 160
      }));
    }
  };
}

// Start audio with a mouse press, let the loading screen finish and bring up a few voices around the camera.
async function playing(options) {
  const h = harness(options);
  h.document.dispatch('pointerdown', { pointerType: 'mouse' });
  await flush();
  assert.equal(h.context.state, 'running');
  h.system.ready = true;
  h.place(0, 0);
  for (let i = 0; i < 8; i++) await h.frame();
  assert.equal(h.env.voices.length, 3);
  assert.ok(h.system.master.gain.at(h.context.currentTime) > MASTER * 0.98, 'the master has faded in');
  return h;
}

function assertReleasedSilently(h, voices) {
  for (const voice of voices) {
    assert.notEqual(voice.disposed, null, `${voice.kind} is released`);
    if (voice.state !== 'running') continue; // Nothing renders while suspended.
    const level = h.system.master.gain.at(voice.disposed);
    assert.ok(level < SILENT, `${voice.kind} stopped at master ${level.toFixed(4)}, which clicks`);
  }
}

test('gesture listeners use capture, so stopped propagation cannot block them, and dispose removes all of them', () => {
  const { system, document } = harness();
  const gestures = document.listeners.filter((entry) => entry.type !== 'visibilitychange');
  assert.deepEqual(gestures.map((entry) => entry.type).sort(), ['click', 'keydown', 'pointerdown', 'pointerup', 'touchend']);
  for (const entry of gestures) {
    assert.equal(entry.capture, true, `${entry.type} listens in the capture phase`);
    assert.equal(entry.passive, true, `${entry.type} never blocks scrolling or input`);
  }
  system.dispose();
  assert.deepEqual(document.listeners, [], 'no listener survives dispose()');
});

test('a touch tap starts audio on release, even on controls that stop propagation', async () => {
  const h = harness();
  const { env, document } = h;
  const controls = (event) => event.stopPropagation(); // Like the touch joystick and action buttons.
  document.dispatch('pointerdown', { pointerType: 'touch', pointerId: 2 }, controls);
  assert.equal(env.contexts.length, 0, 'a touch pointerdown is not user activation, so it must not create a context');
  document.dispatch('pointerup', { pointerType: 'touch', pointerId: 2 }, controls);
  assert.equal(env.contexts.length, 1);
  const [context] = env.contexts;
  assert.ok(context.resumes.length > 0 && context.resumes.every((call) => call.activation), 'resumed within the activation');
  await flush();
  assert.equal(context.state, 'running');
});

test('touchend and the tap\'s click each start audio on their own', async () => {
  for (const type of ['touchend', 'click']) {
    const { env, document } = harness();
    document.dispatch(type, {}, (event) => event.stopPropagation());
    await flush();
    assert.equal(env.contexts[0]?.state, 'running', `${type} starts audio`);
  }
});

test('mouse and keyboard still start audio on press, except for repeats, shortcuts, Escape and typing', async () => {
  const mouse = harness();
  mouse.document.dispatch('pointerdown', { pointerType: 'mouse' });
  await flush();
  assert.equal(mouse.context.state, 'running');

  const keyboard = harness();
  keyboard.document.dispatch('keydown', { key: 'w', repeat: true });
  keyboard.document.dispatch('keydown', { key: 'r', metaKey: true });
  keyboard.document.dispatch('keydown', { key: 'c', ctrlKey: true });
  keyboard.document.dispatch('keydown', { key: 'Escape' });
  keyboard.document.dispatch('keydown', { key: 'a', target: { tagName: 'INPUT' } });
  assert.equal(keyboard.env.contexts.length, 0);
  keyboard.document.dispatch('keydown', { key: 'w' });
  await flush();
  assert.equal(keyboard.context.state, 'running');
});

test('a later tap resumes audio that iOS interrupted or would not resume without one', async () => {
  const { document, env, advance } = harness();
  document.dispatch('touchend');
  await flush();
  const [context] = env.contexts;
  context.setState('interrupted');
  document.dispatch('pointerdown', { pointerType: 'touch' });
  assert.equal(context.resumes.length, 1, 'nothing to resume with before the release');
  document.dispatch('pointerup', { pointerType: 'touch' });
  assert.equal(context.resumes.at(-1).activation, true);
  await flush();
  assert.equal(context.state, 'running');

  // WebKit refuses to resume without activation when the page is shown again; the next tap succeeds.
  document.hidden = true;
  document.dispatch('visibilitychange');
  await advance(0.1);
  assert.equal(context.state, 'suspended');
  document.hidden = false;
  document.dispatch('visibilitychange');
  await flush();
  assert.equal(context.state, 'suspended');
  document.dispatch('touchend');
  await flush();
  assert.equal(context.state, 'running');
});

test('a muted system ignores gestures', () => {
  const { system, document, env } = harness();
  system.setEnabled(false);
  document.dispatch('pointerup', { pointerType: 'touch' });
  document.dispatch('click');
  assert.equal(env.contexts.length, 0);
});

test('a teleport fades the old voices out before releasing them, then fades back in from silence', async () => {
  const h = await playing();
  const { system, env, camera } = h;
  const master = system.master.gain;
  const car = { type: 'car', position: { x: 4, y: 0.7, z: 2 }, heading: 0 };
  system.honk(car);
  for (let i = 0; i < 9; i++) await h.frame();
  const old = [...env.voices, ...env.events];
  assert.equal(env.events.length, 1);
  assert.ok(old.every((voice) => voice.disposed === null), 'the horn is still sounding');

  camera.position.x = 2000;
  h.place(2000, 0);
  await h.frame();
  const jump = h.context.currentTime;
  assert.ok(old.every((voice) => voice.disposed === null), 'voices keep playing while the master fades out');
  assert.equal(env.voices.length, 3, 'new voices wait, so a jump never doubles the graph');
  assert.ok(master.at(jump + 0.05) < MASTER * 0.05, 'the master fades out within a few tens of milliseconds');
  system.honk({ ...car, position: { x: 2004, y: 0.7, z: 2 } });
  assert.equal(env.events.length, 1, 'no new events start during the fade-out');

  await h.frame();
  assertReleasedSilently(h, old);
  const fresh = env.voices.slice(3);
  assert.equal(fresh.length, 3);
  const released = Math.max(...old.map((voice) => voice.disposed));
  assert.ok(fresh.every((voice) => voice.created >= released), 'new voices start after the old ones are gone');
  assert.ok(master.at(h.context.currentTime) < SILENT, 'the new soundscape starts from silence');

  for (let i = 0; i < 10; i++) await h.frame();
  assert.ok(master.at(h.context.currentTime) > MASTER * 0.95, 'then fades back in');
  assert.ok(master.maxStep() < 1e-6, 'the master never steps');
  assert.ok(fresh.every((voice) => voice.disposed === null));
});

test('muting fades out before suspending, then unmuting fades back in', async () => {
  const h = await playing();
  const { system, env } = h;
  const master = system.master.gain;
  const old = [...env.voices];
  system.setEnabled(false);
  assert.equal(h.context.suspends.length, 0, 'the output keeps running while the master fades out');
  assert.ok(old.every((voice) => voice.disposed === null));

  await h.advance(0.1);
  assert.equal(h.context.suspends.length, 1);
  assert.ok(master.at(h.context.suspends[0].time) < SILENT, 'suspended only once silent');
  assert.equal(h.context.state, 'suspended');
  assertReleasedSilently(h, old);
  assert.ok(old.every((voice) => voice.state === 'suspended'), 'released after rendering stopped');

  h.document.dispatch('click', {}, () => system.setEnabled(true)); // The sound button.
  await flush();
  assert.equal(h.context.state, 'running');
  for (let i = 0; i < 12; i++) await h.frame();
  assert.ok(master.at(h.context.currentTime) > MASTER * 0.95);
  assert.equal(env.voices.length, 6);
  assert.ok(master.maxStep() < 1e-6);
});

test('unmuting during the fade-out keeps the context running', async () => {
  const h = await playing();
  const { system, env } = h;
  const old = [...env.voices];
  system.setEnabled(false);
  await h.advance(0.03);
  h.document.dispatch('click', {}, () => system.setEnabled(true));
  for (let i = 0; i < 12; i++) await h.frame();
  assert.equal(h.context.suspends.length, 0, 'the pending suspend is abandoned');
  assert.equal(h.context.state, 'running');
  assertReleasedSilently(h, old);
  assert.ok(system.master.gain.at(h.context.currentTime) > MASTER * 0.95);
  assert.equal(env.voices.filter((voice) => voice.disposed === null).length, 3);
});

test('hiding the page fades out before suspending, and returning starts again from silence', async () => {
  const h = await playing({ sticky: true });
  const { system, env, document } = h;
  const master = system.master.gain;
  const old = [...env.voices];
  document.hidden = true;
  document.dispatch('visibilitychange');
  assert.equal(h.context.suspends.length, 0);
  await h.advance(0.1);
  assert.equal(h.context.state, 'suspended');
  assert.ok(master.at(h.context.suspends[0].time) < SILENT);
  assertReleasedSilently(h, old);

  document.hidden = false;
  document.dispatch('visibilitychange');
  await flush();
  assert.equal(h.context.state, 'running');
  const resumed = h.context.currentTime;
  for (let i = 0; i < 12; i++) await h.frame();
  assert.ok(master.at(resumed) < SILENT, 'no stale level after resuming');
  assert.ok(master.at(h.context.currentTime) > MASTER * 0.95);
  assert.ok(master.maxStep() < 1e-6);
});

test('a reset while iOS has interrupted rendering releases at once and resumes from silence', async () => {
  const h = await playing({ sticky: true });
  const { system, env, document } = h;
  const master = system.master.gain;
  const old = [...env.voices];
  h.context.setState('interrupted');
  document.hidden = true;
  document.dispatch('visibilitychange');
  assert.ok(old.every((voice) => voice.disposed !== null && voice.state === 'interrupted'), 'no fade can render now');
  const frozen = h.context.currentTime;
  assert.equal(master.at(frozen), 0, 'rendering restarts from silence');
  await h.advance(0.1);
  assert.equal(h.context.state, 'suspended');

  document.hidden = false;
  document.dispatch('visibilitychange');
  await flush();
  for (let i = 0; i < 12; i++) await h.frame();
  assert.ok(master.at(h.context.currentTime) > MASTER * 0.95);
  assert.equal(env.voices.filter((voice) => voice.disposed === null).length, 3);
});

test('dispose releases every voice and cancels a pending suspend', async () => {
  const h = await playing();
  const { system, env } = h;
  system.setEnabled(false);
  system.dispose();
  assert.ok(env.voices.every((voice) => voice.disposed !== null));
  assert.equal(env.timers.length, 0);
  assert.equal(h.context.state, 'closed');
  await h.advance(0.2);
  assert.equal(h.context.suspends.length, 0);
});

// The real source collection, for the player's helicopter over ground raised above the street (a park's lawn)
function helicopterSources(floor) {
  const { CityAudioSources } = loadModule(readFileSync(join(__dirname, '../js/audio-sources.js'), 'utf8'), {
    imports: { './city-config.js': { signalPhase: () => 'green', walkSignal: () => 'walk' } },
    filename: 'audio-sources.js'
  });
  const helicopter = { type: 'helicopter', mesh: { visible: true }, position: { x: 40, y: floor, z: -60 }, speed: 0, verticalSpeed: 0, heading: 0 };
  const controllerManager = {
    entities: { helicopter },
    keys: { forward: false, backward: false, left: false, right: false, up: false, down: false, boost: false },
    getActiveEntity: () => helicopter,
    helicopterFloor: () => floor
  };
  const sources = new CityAudioSources({
    controllerManager,
    trafficSystem: { cars: [], buses: [], peds: [] },
    highwayTraffic: { cars: [] },
    streetDetails: { audioSignals: [] }
  });
  const motor = () => sources.collect({ x: 40, y: floor + 2, z: -60 }, 0).motors[0];
  return { helicopter, motor };
}

test('a helicopter resting on a raised park lawn idles as grounded, and its vertical speed is the controller\'s', () => {
  const lawnFloor = 1.24 + 0.25; // Central Park's lawn, skids just clear of it
  const { helicopter, motor } = helicopterSources(lawnFloor);
  const grounded = motor().load;
  assert.ok(Math.abs(grounded - 0.12) < 1e-9, `resting on the lawn idles at the grounded load, got ${grounded}`);

  helicopter.position.y = lawnFloor + 12;
  const hovering = motor().load;
  assert.ok(Math.abs(hovering - 0.45) < 1e-9, `hovering above the lawn is airborne, got ${hovering}`);

  helicopter.verticalSpeed = -4;
  assert.equal(motor().verticalSpeed, -4);
});
