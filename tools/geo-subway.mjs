// tools/geo-subway.mjs — the New York City Subway under the modelled island, from OpenStreetMap (osm_subway.json, see
// data/q_subway.overpassql): one route per service through Manhattan, the stations with the services that call at
// each, and the street entrances.
import { toWorld, rdp, pointInRing, load, log } from './geo-base.mjs';
import { manhattanSouth } from './geo-extra.mjs';

// Service order and the trunk-line colours of the MTA's map (OSM colours vary in case & shade between relations)
const SERVICES = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S'];
const COLORS = {
  1: '#ee352e', 2: '#ee352e', 3: '#ee352e', 4: '#00933c', 5: '#00933c', 6: '#00933c', 7: '#b933ad',
  A: '#0039a6', C: '#0039a6', E: '#0039a6', B: '#ff6319', D: '#ff6319', F: '#ff6319', M: '#ff6319',
  G: '#6cbe45', J: '#996633', Z: '#996633', L: '#a7a9ac', N: '#fccc0a', Q: '#fccc0a', R: '#fccc0a', W: '#fccc0a', S: '#808183'
};
// '<6>' & '<7>' (the diamond expresses) run the 6 & 7's tracks
const serviceOf = (ref) => (ref || '').replace(/[<>]/g, '');

const q = (v) => Math.round(v * 10) / 10;
const onIsland = ([x, z]) => pointInRing(x, z, manhattanSouth);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Track height: tunnels by OSM layer (-1: just under the street, each layer below ~5 m deeper), viaducts above it
function trackY(t) {
  const layer = parseInt(t.layer ?? t.level ?? '0', 10) || 0;
  if (t.tunnel === 'yes' || layer < 0) return -9 - 5 * Math.max(0, -layer - 1);
  if (t.bridge === 'yes' || layer > 0) return 9;
  return 0;
}

function buildSubway() {
  const osm = load('osm_subway.json').elements;
  const ways = new Map();
  const stopNodes = new Map();
  const stations = [];
  const entrances = [];
  for (const e of osm) {
    if (e.type === 'way' && e.geometry) ways.set(e.id, e);
    else if (e.type === 'node' && e.tags?.railway === 'station' && e.tags.station === 'subway') {
      const p = toWorld(e.lon, e.lat);
      if (onIsland(p)) stations.push({ name: e.tags.name || e.tags.short_name || '', p, services: new Set() });
    } else if (e.type === 'node' && e.tags?.railway === 'subway_entrance') {
      const p = toWorld(e.lon, e.lat);
      if (onIsland(p)) entrances.push(p);
    } else if (e.type === 'node') stopNodes.set(e.id, toWorld(e.lon, e.lat));
  }
  const routes = osm.filter((e) => e.type === 'relation' && e.tags?.network === 'NYC Subway' && SERVICES.includes(serviceOf(e.tags.ref)));

  // A relation's track in member order, as pieces on the island: each way turned to continue the previous one, a new
  // piece wherever the route leaves the island or a member is missing (outside the downloaded area)
  function routePieces(rel) {
    const pieces = [];
    let cur = null;
    for (const m of rel.members) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w) { cur = null; continue; }
      const y = trackY(w.tags || {});
      let pts = w.geometry.map((g) => [...toWorld(g.lon, g.lat), y]);
      const end = cur && cur[cur.length - 1];
      if (end && dist(end, pts[pts.length - 1]) < dist(end, pts[0])) pts.reverse();
      if (end && dist(end, pts[0]) > 30) cur = null;
      for (const p of pts) {
        if (!onIsland(p)) { cur = null; continue; }
        if (!cur) { cur = []; pieces.push(cur); }
        if (!cur.length || dist(cur[cur.length - 1], p) > 0.5) cur.push(p);
      }
    }
    return pieces.filter((pc) => pc.length > 1);
  }
  const length = (pc) => pc.reduce((t, p, i) => (i ? t + dist(pc[i - 1], p) : 0), 0);

  // One route per service: the longest run through the island of any of its relations (directions & variants)
  const lines = [];
  for (const ref of SERVICES) {
    let best = null, bestLen = 0;
    for (const rel of routes) {
      if (serviceOf(rel.tags.ref) !== ref) continue;
      const pieces = routePieces(rel).filter((pc) => length(pc) > 150);
      const len = pieces.reduce((t, pc) => t + length(pc), 0);
      if (len > bestLen) { best = pieces; bestLen = len; }
    }
    if (!best) continue;
    lines.push({ ref, color: COLORS[ref], paths: best.map((pc) => rdp(pc, 1.2).flatMap(([x, z, y]) => [q(x), q(z), y])) });
    log(`subway ${ref}: ${best.length} piece(s), ${(bestLen / 1000).toFixed(1)} km`);
  }

  // Which services call where: each route's stops go to the nearest station (a complex's platforms can lie 150 m
  // and more from its node)
  for (const rel of routes) {
    const ref = serviceOf(rel.tags.ref);
    for (const m of rel.members) {
      const p = m.type === 'node' && /stop/.test(m.role) ? stopNodes.get(m.ref) : null;
      if (!p || !onIsland(p)) continue;
      let near = null, d = 250;
      for (const s of stations) {
        const ds = dist(s.p, p);
        if (ds < d) { d = ds; near = s; }
      }
      if (near) near.services.add(ref);
    }
  }
  const stationsOut = stations
    .filter((s) => s.services.size)
    .map((s) => [s.name, q(s.p[0]), q(s.p[1]), SERVICES.filter((r) => s.services.has(r)).join('')]);
  log(`subway: ${lines.length} services, ${stationsOut.length} stations, ${entrances.length} entrances`);
  return { lines, stations: stationsOut, entrances: entrances.flatMap(([x, z]) => [q(x), q(z)]) };
}

export { buildSubway };
