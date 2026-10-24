const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

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
