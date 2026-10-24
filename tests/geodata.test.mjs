import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Point in a flat [x0, z0, x1, z1, ...] polygon (even-odd), and its area
function inside(x, z, f) {
  let c = false;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
    if ((f[i + 1] > z) !== (f[j + 1] > z) && x < ((f[j] - f[i]) * (z - f[i + 1])) / (f[j + 1] - f[i + 1]) + f[i]) c = !c;
  }
  return c;
}
function area(f) {
  let a = 0;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) a += f[j] * f[i + 1] - f[i] * f[j + 1];
  return Math.abs(a / 2);
}
// What the build has got wrong before: loop roads collapsed to a point, multipolygon piers built from fragments of their
// outlines (Pier 34's walkways on a spit of land), a pier's box turned off its sides by its root (Pier 62) or spread by
// it over the water beside the pier (the deck city-grid.js lays along the box), park land lost on blocks without lots
function checkGeo(GEO) {
  for (const [name, , , , , pts] of GEO.roads) {
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    assert.ok(len > 0, `${name} is more than a point`);
  }
  for (const name of ['FREDERICK DOUGLASS CIR', 'HELL GATE CIR']) {
    const pts = GEO.roads.find((r) => r[0] === name)[5];
    const n = pts.length;
    assert.ok(n / 2 >= 8 && pts[0] === pts[n - 2] && pts[1] === pts[n - 1], `${name} goes all the way round`);
  }
  const pier = (name) => GEO.piers.filter((p) => p.name === name).reduce((a, b) => (b.len * b.wid > a.len * a.wid ? b : a));
  const p26 = pier('Pier 26');
  assert.ok(Math.abs(p26.len - 304) < 15 && area(p26.ring) > 12000, `Pier 26 is ${p26.len} m long, ${Math.round(area(p26.ring))} m²`);
  for (const name of ['Pier 59', 'Pier 60', 'Pier 61', 'Pier 62']) assert.ok(pier(name).len > 255, `${name} is ${pier(name).len} m long`);
  // the Chelsea Piers run out side by side
  const turn = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
  for (const name of ['Pier 59', 'Pier 60', 'Pier 62']) {
    const off = (turn(pier(name).ang, pier('Pier 61').ang) * 180) / Math.PI;
    assert.ok(off < 1, `${name} runs parallel to Pier 61 (${off.toFixed(1)}° off)`);
  }
  // the piers with wide roots keep their decks to their bodies (2 m samples)
  for (const name of ['Pier 25', 'Pier 26', 'Pier 57', 'Pier 59', 'Pier 60', 'Pier 61', 'Pier 62', 'Pier 76']) {
    const p = pier(name);
    const ax = Math.cos(p.ang), az = Math.sin(p.ang);
    let n = 0, on = 0;
    for (let a = 1 - p.len / 2; a < p.len / 2; a += 2) {
      for (let b = 1 - p.wid / 2; b < p.wid / 2; b += 2) {
        n++;
        if (inside(p.cx + a * ax - b * az, p.cz + a * az + b * ax, p.ring)) on++;
      }
    }
    assert.ok(on / n > 0.8, `${name}'s deck lies on the pier (${Math.round((on / n) * 100)}% of its ${p.len} x ${p.wid} m)`);
  }
  // and every pier runs out over the water along its box's centre line, bar where it meets the shore (Pier 62's first
  // 24 m: its root's north side runs off along the shore at 21°)
  for (const p of GEO.piers) {
    if (!p.name) continue;
    let onLand = 0;
    for (let t = -p.len / 2; t <= p.len / 2; t++) {
      const x = p.cx + Math.cos(p.ang) * t, z = p.cz + Math.sin(p.ang) * t;
      if (inside(x, z, GEO.manhattan) || inside(x, z, GEO.upperManhattan)) onLand++;
    }
    assert.ok(onLand <= 30, `${p.name} runs out over the water (${onLand} m of it over land)`);
  }
  for (const [x, z, name, share] of [[-1835, -5179, 'Riverside Park', 0.9], [1107, 3452, 'Allen Street Malls', 0.8]]) {
    const block = GEO.blocks.find(([poly]) => inside(x, z, poly));
    assert.ok(block && block[2] > share && block[3] === name, `the block at (${x}, ${z}) is ${name}: ${block && `${block[2]} ${block[3]}`}`);
  }
}

test('geodata builds with default paths in a checkout containing spaces and non-ASCII characters', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'New York 東京 '));
  try {
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'js'));
    for (const name of fs.readdirSync(path.join(root, 'tools'))) {
      if (name.endsWith('.mjs')) fs.copyFileSync(path.join(root, 'tools', name), path.join(dir, 'tools', name));
    }
    fs.symlinkSync(path.join(root, 'tools/data'), path.join(dir, 'tools/data'), 'dir');
    const env = { ...process.env };
    delete env.GEO_DATA;
    const result = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(dir, 'tools/build-geodata.mjs')], {
      encoding: 'utf8', env, timeout: 180000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { GEO } = await import(pathToFileURL(path.join(dir, 'js/nyc-geodata.js')).href);
    assert.ok(GEO.roadGraph.links.length > 0);
    assert.ok(GEO.blocks.length > 0);
    checkGeo(GEO);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed geodata keeps its loop roads, whole piers and park blocks', async () => {
  const { GEO } = await import(pathToFileURL(path.join(root, 'js/nyc-geodata.js')).href);
  checkGeo(GEO);
});
