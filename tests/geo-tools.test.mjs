import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// tools/geo-base.mjs builds the whole shoreline as it loads (10+ s), and the other tools build on it: their geometry
// helpers are lifted out of the source and run on their own, their bodies unchanged
function lift(file, ...names) {
  const source = fs.readFileSync(new URL(`../tools/${file}`, import.meta.url), 'utf8');
  const code = names.map((name) => {
    const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
    assert.ok(start >= 0, `tools/${file} declares ${name}()`);
    for (let i = source.indexOf('{', start), depth = 0; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`${name}() has no closing brace`);
  });
  return new Function(`'use strict';\n${code.join('\n')}\nreturn { ${names.join(', ')} };`)();
}
const { rdp, ringArea, chainRings } = lift('geo-base.mjs', 'rdp', 'ringArea', 'chainRings');
const { orientedBox, deckBox } = lift('geo-extra.mjs', 'orientedBox', 'deckBox');

function distToLine([x, z], line) {
  let d = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1], [bx, bz] = line[i];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0;
    d = Math.min(d, Math.hypot(ax + t * dx - x, az + t * dz - z));
  }
  return d;
}
const closed = (r) => Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.5;

test('rdp keeps a loop road whose chained pieces end where they start', () => {
  // Frederick Douglass Circle: ~170 m round, a vertex every 3.5 m, back to its first point
  const loop = [];
  for (let i = 0; i < 48; i++) loop.push([-888 + 27 * Math.cos((i / 48) * 2 * Math.PI), -5476 + 27 * Math.sin((i / 48) * 2 * Math.PI)]);
  loop.push(loop[0]);
  const s = rdp(loop, 0.8);
  assert.ok(s.length >= 8, `${s.length} points left of the loop`);
  assert.deepEqual(s[0], loop[0]);
  assert.deepEqual(s[s.length - 1], loop[0]);
  for (const p of loop) assert.ok(distToLine(p, s) <= 0.8, `(${p}) is within the tolerance of the simplified loop`);
});

test('rdp still simplifies open polylines along their chords', () => {
  assert.deepEqual(rdp([[0, 0], [10, 0], [20, 0.2], [30, 0], [30, 10], [30, 20]], 0.5), [[0, 0], [30, 0], [30, 20]]);
  assert.deepEqual(rdp([[0, 0], [5, 5]], 0.5), [[0, 0], [5, 5]]);
  // a run with no length at all still comes back as its two ends
  assert.deepEqual(rdp([[3, 4], [3, 4], [3, 4]], 0.5), [[3, 4], [3, 4]]);
});

test('chainRings joins an outline split across open ways, in any order and direction', () => {
  const a = [[0, 0], [100, 0], [100, 60]], b = [[100, 60], [0, 60]], c = [[0, 60], [0, 0]];
  const parts = [b.slice().reverse(), c, a];
  const before = JSON.stringify(parts);
  const rings = chainRings(parts);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
  assert.ok(closed(rings[0]));
  assert.equal(Math.abs(ringArea(rings[0])), 6000);
  assert.equal(JSON.stringify(parts), before, 'the pieces are left as they were');
});

test('chainRings passes closed ways through and keeps separate or incomplete outlines apart', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  assert.deepEqual(chainRings([square]), [square]);
  // two outer rings of one relation, each in two pieces
  const two = chainRings([[[0, 0], [10, 0], [10, 10]], [[50, 0], [60, 0], [60, 10]], [[10, 10], [0, 10], [0, 0]], [[60, 10], [50, 10], [50, 0]]]);
  assert.equal(two.length, 2);
  for (const r of two) assert.ok(closed(r) && Math.abs(ringArea(r)) === 100);
  // a piece missing from the data: the rest comes back as one open outline, not lost
  assert.deepEqual(chainRings([[[0, 0], [100, 0], [100, 60]], [[100, 60], [0, 60]]]), [[[0, 0], [100, 0], [100, 60], [0, 60]]]);
});

test('the OSM multipolygon piers chain into closed outlines (Pier 26 from its seven pieces)', () => {
  const osm = JSON.parse(fs.readFileSync(new URL('../tools/data/osm_piers.json', import.meta.url), 'utf8'));
  // local tangent plane at Lower Manhattan, metres
  const K = (Math.PI / 180) * 6378137;
  const xy = (g) => [(g.lon + 74) * K * Math.cos((40.73 * Math.PI) / 180), (g.lat - 40.73) * K];
  let relations = 0;
  for (const e of osm.elements) {
    if (e.type !== 'relation') continue;
    relations++;
    const rings = chainRings(e.members.filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry.map(xy)));
    for (const r of rings) assert.ok(closed(r), `${e.tags.name || `relation ${e.id}`} closes`);
    if (e.tags.name === 'Pier 26') {
      assert.equal(rings.length, 1);
      assert.ok(Math.abs(ringArea(rings[0])) > 12000, `Pier 26 covers ${Math.round(Math.abs(ringArea(rings[0])))} m²`);
    }
  }
  assert.ok(relations > 20, `${relations} multipolygon piers`);
});

// Local (u, s) points turned by `a` and moved to (x0, z0); the angle between two headings, either way round
const place = (pts, a, x0, z0) => pts.map(([u, s]) => [x0 + u * Math.cos(a) - s * Math.sin(a), z0 + u * Math.sin(a) + s * Math.cos(a)]);
const turn = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
// Pier 62's outline in its own frame, u along its sides: the deck tapers out into the river (to u = -135) from a wide
// root whose north side meets the land at 21° to the deck
const PIER_62 = [[62.5, 15.7], [62.6, 48.2], [134.9, 47.8], [135, 6.6], [-2.8, -46.2], [-27.7, -48.2], [-30, -30.8], [-134.9, -19.4], [-134.6, 16.6], [62.5, 15.7]];
function inRing(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
// The share of a box ({cx, cz, len, wid, ang}) lying on an outline (2 m samples), and deckBox's `root` for a box: +1 if
// its end along its heading is the one nearer the point (x, z)
function onRing(b, ring) {
  const ax = Math.cos(b.ang), az = Math.sin(b.ang);
  let n = 0, on = 0;
  for (let p = 1 - b.len / 2; p < b.len / 2; p += 2) {
    for (let q = 1 - b.wid / 2; q < b.wid / 2; q += 2) {
      n++;
      if (inRing(b.cx + p * ax - q * az, b.cz + p * az + q * ax, ring)) on++;
    }
  }
  return on / n;
}
const rootOf = (b, [x, z]) => {
  const ex = (Math.cos(b.ang) * b.len) / 2, ez = (Math.sin(b.ang) * b.len) / 2;
  return Math.hypot(b.cx + ex - x, b.cz + ez - z) < Math.hypot(b.cx - ex - x, b.cz - ez - z) ? 1 : -1;
};

test('orientedBox fits a rectangular pier exactly', () => {
  const a = (159 * Math.PI) / 180;
  const b = orientedBox(place([[0, 0], [200, 0], [200, 30], [0, 30], [0, 0]], a, -1700, 1600));
  const [cx, cz] = place([[100, 15]], a, -1700, 1600)[0];
  assert.ok(turn(b.ang, a) < 1e-9 && Math.abs(b.len - 200) < 1e-9 && Math.abs(b.wid - 30) < 1e-9);
  assert.ok(Math.hypot(b.cx - cx, b.cz - cz) < 1e-9);
});

test("orientedBox runs along a pier's sides, not across its root (Pier 62)", () => {
  // The minimum-area box over every edge direction (276 x 85 m) lies 7.5° off the pier
  const a = (159 * Math.PI) / 180;
  const b = orientedBox(place(PIER_62, a, -1862, 1650));
  assert.ok(turn(b.ang, a) < (0.5 * Math.PI) / 180, `heading ${((b.ang * 180) / Math.PI).toFixed(1)}°`);
  assert.ok(Math.abs(b.len - 270) < 1 && Math.abs(b.wid - 96) < 1, `${b.len.toFixed(1)} x ${b.wid.toFixed(1)} m`);
});

test('orientedBox keeps the minimum-area box of a rounded outline', () => {
  // a 120 x 80 m ellipse turned 30°: no direction most of its outline runs along
  const ellipse = [];
  for (let i = 0; i < 64; i++) ellipse.push([60 * Math.cos((2 * Math.PI * (i + 0.5)) / 64), 40 * Math.sin((2 * Math.PI * (i + 0.5)) / 64)]);
  const b = orientedBox(place(ellipse, Math.PI / 6, 500, 200));
  assert.ok(turn(b.ang, Math.PI / 6) < 1e-9, `heading ${((b.ang * 180) / Math.PI).toFixed(2)}°`);
  assert.ok(Math.abs(b.len - 120) < 0.5 && Math.abs(b.wid - 80) < 0.5 && Math.hypot(b.cx - 500, b.cz - 200) < 1e-9);
});

test("deckBox narrows a pier's box to its body, off a wide root at either end of the box (Pier 26)", () => {
  // Pier 26 in its own frame, u out from the bulkhead: a 37.3 m body out to 304 m, 13 m off the middle of a root 133 m
  // wide along the first 46 m
  const outline = [[0, -66.5], [46, -66.5], [46, -5.5], [304, -5.5], [304, 31.8], [46, 31.8], [46, 66.5], [0, 66.5], [0, -66.5]];
  const a = (160 * Math.PI) / 180;
  for (const endForEnd of [false, true]) {
    const local = endForEnd ? outline.map(([u, s]) => [304 - u, -s]) : outline;
    const ring = place(local, a, -880, 4560);
    const ob = orientedBox(ring);
    assert.ok(Math.abs(ob.len - 304) < 1e-6 && Math.abs(ob.wid - 133) < 1e-6);
    const d = deckBox(ring, ob, rootOf(ob, place([[endForEnd ? 304 : 0, 0]], a, -880, 4560)[0]));
    assert.ok(Math.abs(d.wid - 37.3) < 1e-6 && d.len === ob.len && d.ang === ob.ang, `${d.len.toFixed(1)} x ${d.wid.toFixed(1)} m`);
    const [cx, cz] = place([[152, endForEnd ? -13.15 : 13.15]], a, -880, 4560)[0];
    assert.ok(Math.hypot(d.cx - cx, d.cz - cz) < 1e-6, "on the body's centre line");
  }
});

test("deckBox keeps Pier 62's deck to its body, off the root running along the shore", () => {
  const a = (159 * Math.PI) / 180;
  const ring = place(PIER_62, a, -1862, 1650);
  const ob = orientedBox(ring);
  const d = deckBox(ring, ob, rootOf(ob, place([[135, 27]], a, -1862, 1650)[0]));
  assert.ok(Math.abs(d.wid - 45) < 1, `${d.wid.toFixed(1)} m wide`);
  const on = onRing(d, ring), onBox = onRing(ob, ring);
  assert.ok(on > 0.8 && onBox < 0.55, `${Math.round(on * 100)}% of the deck on the pier (${Math.round(onBox * 100)}% of the box)`);
});

test('deckBox keeps the box of a rectangular pier, and of a walkway too narrow for a deck (Pier 66)', () => {
  const a = (159 * Math.PI) / 180;
  const rect = place([[0, 0], [200, 0], [200, 30], [0, 30], [0, 0]], a, -1700, 1600);
  const ob = orientedBox(rect);
  const d = deckBox(rect, ob, rootOf(ob, rect[0]));
  assert.ok(Math.abs(d.wid - 30) < 1e-6 && Math.hypot(d.cx - ob.cx, d.cz - ob.cz) < 1e-6);
  // Pier 66: a 22 m root along the first 37 m, then a 6 m walkway out to a crosspiece at its end
  const walk = place([[0, -11], [155, -11], [155, 11], [145, 11], [145, -5], [37, -5], [37, 11], [0, 11], [0, -11]], Math.PI, -1970, 1247);
  const wb = orientedBox(walk);
  assert.equal(deckBox(walk, wb, rootOf(wb, walk[0])), wb);
});
