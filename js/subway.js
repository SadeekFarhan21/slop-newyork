import * as THREE from 'three/webgpu';
import { GEO } from './nyc-geodata.js';
import { blockAt } from './city-config.js';

// js/subway.js
// Down into the subway (mode 5): the nearest real station (GEO.subway, from OpenStreetMap) built under its street as
// an enclosed island platform between its two tracks, turned along the service's real route: white tile walls with
// the station's name in the mosaic band, I-beam columns, fluorescent strips, name signs, stairs up to the street at
// both ends, and trains in and out of the tunnels on both tracks. The station is built when the player comes down and
// thrown away when they go back up (one at a time: there is only ever the one the player stands in).
//
// Station frame: x across the tracks, z along them (the route's direction), y up; the origin is on the route under
// the station's node, at street level.

const STATIONS = (GEO.subway?.stations || []).map(([name, x, z, services]) => ({ name, x, z, services }));
const LINES = new Map((GEO.subway?.lines || []).map((l) => [l.ref, l]));
const ENTRANCES = [];
for (let i = 0, e = GEO.subway?.entrances || []; i < e.length; i += 2) ENTRANCES.push({ x: e[i], z: e[i + 1] });

const PLATFORM_LEN = 156; // a ten-car IRT / eight-car IND platform, about 150 m
const PLATFORM_HALF_W = 4.5;
const TRACK_X = 6.8; // track centres either side of the platform
const HALL_HALF_W = 9.2; // tile wall to tile wall
const PLATFORM_H = 1.1; // platform top over the rails
const CEILING = 4.4; // over the platform
const TUNNEL_LEN = 330; // beyond each end of the platform: trains disappear into the dark well inside it
const STAIR_W = 2.6;
const STAIR_LEN = 7.2; // the flight's run on the platform
const STAIR_RISE = 3.9; // up to the ceiling (the street is above the mezzanine)
const STAIR_EXIT_RISE = 2.0; // climbing this high up a flight takes the player out to the street
const CAR_LEN = 18.3; // a 60 ft car
const CARS = 8;
const TRAIN_PERIOD = 64; // seconds between trains on each track
const DWELL = 20;

const BULLET_TEXT = { 1: '#fff', 2: '#fff', 3: '#fff', 4: '#fff', 5: '#fff', 6: '#fff', 7: '#fff', N: '#000', Q: '#000', R: '#000', W: '#000' };

// Where along a service's route a station lies: the nearest point of the route to the station's node, with the
// route's direction there and its track height (below 0 in tunnel)
function routeFrame(station) {
  let best = null;
  for (const ref of station.services) {
    const line = LINES.get(ref);
    if (!line) continue;
    for (const pts of line.paths) {
      for (let i = 0; i + 5 < pts.length; i += 3) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 3], bz = pts[i + 4];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((station.x - ax) * dx + (station.z - az) * dz) / l2));
        const px = ax + dx * t, pz = az + dz * t;
        const d = Math.hypot(px - station.x, pz - station.z);
        if (!best || d < best.d) {
          const len = Math.sqrt(l2);
          best = { d, x: px, z: pz, dirX: dx / len, dirZ: dz / len, trackY: Math.min(pts[i + 2], pts[i + 5]), line };
        }
      }
    }
    if (best && best.d < 60) break; // the station's first service runs right under it
  }
  if (!best || best.d > 120) return { x: station.x, z: station.z, dirX: 0, dirZ: -1, trackY: -9, line: LINES.get(station.services[0]) };
  return best;
}

// --- Textures: the station's name in the wall's mosaic band, on the hanging signs, and the service bullets -------------
function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
const SIGN_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
function nameSignTexture(station) {
  return canvasTexture(2048, 256, (ctx, w, h) => {
    ctx.fillStyle = '#0d0d0e';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(0, 18, w, 6);
    let x = 60;
    // the services stopping here, as bullets, then the name
    for (const ref of station.services) {
      const line = LINES.get(ref);
      ctx.fillStyle = line ? line.color : '#808183';
      ctx.beginPath();
      ctx.arc(x + 70, h / 2 + 10, 70, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = BULLET_TEXT[ref] || '#fff';
      ctx.font = `bold 104px ${SIGN_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ref, x + 70, h / 2 + 16);
      x += 160;
    }
    ctx.fillStyle = '#f4f4f4';
    ctx.textAlign = 'left';
    let size = 120;
    ctx.font = `bold ${size}px ${SIGN_FONT}`;
    while (ctx.measureText(station.name).width > w - x - 60 && size > 50) ctx.font = `bold ${(size -= 4)}px ${SIGN_FONT}`;
    ctx.fillText(station.name, x + 20, h / 2 + 14);
  });
}
function mosaicTexture(station) {
  return canvasTexture(2048, 256, (ctx, w, h) => {
    // a border of small tiles in the service's colour around a cream field with the name in dark tile
    const color = LINES.get(station.services[0])?.color || '#2a6b4f';
    ctx.fillStyle = '#e9e1cc';
    ctx.fillRect(0, 0, w, h);
    const t = 16;
    for (let x = 0; x < w; x += t) {
      for (const y of [0, t, h - 2 * t, h - t]) {
        ctx.fillStyle = (x / t + y / t) % 2 ? color : '#c9b98f';
        ctx.fillRect(x + 1, y + 1, t - 2, t - 2);
      }
    }
    ctx.fillStyle = '#23201c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 120;
    const label = station.name.toUpperCase();
    ctx.font = `bold ${size}px Georgia, "Times New Roman", serif`;
    while (ctx.measureText(label).width > w - 160 && size > 40) ctx.font = `bold ${(size -= 4)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(label, w / 2, h / 2 + 4);
  });
}
function bulletTexture(ref, color) {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#16181a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 104, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = BULLET_TEXT[ref] || '#fff';
    ctx.font = `bold 150px ${SIGN_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ref, w / 2, h / 2 + 10);
  });
}

// Materials shared by every station (built once, so going down again compiles nothing new)
let MATS = null;
function materials() {
  if (MATS) return MATS;
  const std = (color, roughness = 0.6, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  MATS = {
    tile: std(0xe7e2d4, 0.32),
    platform: std(0x8f8b83, 0.85),
    edge: std(0xe2b42a, 0.6),
    trackbed: std(0x1e1c1a, 0.95),
    rail: std(0x8a8580, 0.35, 0.85),
    tie: std(0x2c2621, 0.9),
    column: std(0x2f4a3f, 0.55, 0.35),
    ceiling: std(0x6a6c6a, 0.8),
    tunnel: std(0x0d0d0d, 1.0),
    step: std(0x76736d, 0.8),
    carBody: std(0xb7bcc2, 0.32, 0.75),
    carRoof: std(0x8e9297, 0.5, 0.6),
    carUnder: std(0x1b1c1e, 0.8, 0.3),
    lamp: new THREE.MeshBasicNodeMaterial({ color: 0xfff8e8 }),
    window: new THREE.MeshBasicNodeMaterial({ color: 0xd9e6ea }),
    headlight: new THREE.MeshBasicNodeMaterial({ color: 0xfffbe6 }),
    daylight: new THREE.MeshBasicNodeMaterial({ color: 0xdce8f0 })
  };
  return MATS;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
function box(group, mat, cx, cy, cz, sx, sy, sz, shadows = true) {
  const m = new THREE.Mesh(unitBox, mat);
  m.position.set(cx, cy, cz);
  m.scale.set(sx, sy, sz);
  m.castShadow = shadows;
  m.receiveShadow = true;
  group.add(m);
  return m;
}
function instanced(group, mat, list, shadows = false) {
  const inst = new THREE.InstancedMesh(unitBox, mat, list.length);
  const dummy = new THREE.Object3D();
  list.forEach(([x, y, z, sx, sy, sz], i) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  });
  inst.castShadow = shadows;
  inst.receiveShadow = true;
  group.add(inst);
  return inst;
}

// A train of CARS stainless cars on one track, built along +z from its head at z = 0
function buildTrain(line, ref) {
  const M = materials();
  const train = new THREE.Group();
  const bodyY = 0.42 + 1.55; // over the rails
  for (let c = 0; c < CARS; c++) {
    const z0 = -c * CAR_LEN - CAR_LEN / 2;
    box(train, M.carBody, 0, bodyY, z0, 3.02, 3.1, CAR_LEN - 0.9, false);
    box(train, M.carRoof, 0, bodyY + 1.62, z0, 2.7, 0.18, CAR_LEN - 1.2, false);
    box(train, M.carUnder, 0, 0.42, z0, 2.5, 0.55, CAR_LEN - 2.4, false);
    // lit windows down both sides, broken by the doors
    for (const side of [-1, 1]) {
      for (let w = 0; w < 4; w++) box(train, M.window, side * 1.515, bodyY + 0.42, z0 - CAR_LEN / 2 + 2.4 + w * 4.5, 0.02, 0.92, 2.4, false);
    }
  }
  // The lead car's face: headlights and the service bullet
  const bullet = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), new THREE.MeshBasicNodeMaterial({ map: bulletTexture(ref, line?.color || '#808183') }));
  bullet.position.set(0.72, bodyY + 0.9, 0.02 - 0.45);
  train.add(bullet);
  for (const side of [-1, 1]) box(train, M.headlight, side * 1.05, bodyY - 0.95, -0.44, 0.24, 0.16, 0.04, false);
  box(train, M.window, -0.5, bodyY + 0.5, -0.43, 0.9, 0.9, 0.03, false); // the cab window
  return train;
}

// Where a train's head is at time t of its cycle along a track running +z: in from the tunnel, slowing to a stop with
// its head near the platform's far end, waiting with its doors to the platform, then out into the tunnel ahead
function trainHead(t) {
  const stop = PLATFORM_LEN / 2 - 6;
  const approach = 13; // seconds to brake from tunnel speed
  const reach = stop + PLATFORM_LEN / 2 + 12; // braking from a head 12 m inside the tunnel: all of it out of sight
  if (t < approach) {
    const u = 1 - t / approach;
    return stop - reach * u * u;
  }
  if (t < approach + DWELL) return stop;
  const s = t - approach - DWELL;
  return stop + 0.9 * s * s; // the tail clears the platform ~13 s out, well inside the cycle
}

function buildStation(station) {
  const M = materials();
  const frame = routeFrame(station);
  const railY = Math.min(frame.trackY, -9);
  const floorY = railY + PLATFORM_H;
  const ceilY = floorY + CEILING;
  const group = new THREE.Group();
  group.name = `SubwayStation ${station.name}`;
  group.position.set(frame.x, 0, frame.z);
  const heading = Math.atan2(frame.dirX, frame.dirZ);
  group.rotation.y = heading;
  const L = PLATFORM_LEN;
  const fullLen = L + 2 * TUNNEL_LEN;

  // Platform, its yellow edges & the track beds with their rails and ties
  box(group, M.platform, 0, floorY - PLATFORM_H / 2, 0, PLATFORM_HALF_W * 2, PLATFORM_H, L);
  for (const side of [-1, 1]) box(group, M.edge, side * (PLATFORM_HALF_W - 0.3), floorY + 0.005, 0, 0.6, 0.01, L);
  for (const side of [-1, 1]) {
    const tx = side * TRACK_X;
    box(group, M.trackbed, tx, railY - 0.42, 0, (HALL_HALF_W - PLATFORM_HALF_W) * 2 + 0.2, 0.3, fullLen);
    for (const r of [-0.72, 0.72]) box(group, M.rail, tx + r, railY - 0.09, 0, 0.08, 0.18, fullLen, false);
    box(group, M.rail, tx + side * 1.45, railY - 0.02, 0, 0.12, 0.14, fullLen, false); // the third rail
  }
  const ties = [];
  for (const side of [-1, 1]) for (let z = -L / 2 - 60; z <= L / 2 + 60; z += 0.76) ties.push([side * TRACK_X, railY - 0.22, z, 2.6, 0.14, 0.24]);
  instanced(group, M.tie, ties);

  // Tile walls, the mosaic band with the station's name, the ceiling; the tunnels beyond both ends
  const mosaic = mosaicTexture(station);
  const bandMat = new THREE.MeshStandardNodeMaterial({ map: mosaic, roughness: 0.4 });
  const wallH = ceilY - (railY - 0.6);
  for (const side of [-1, 1]) {
    box(group, M.tile, side * (HALL_HALF_W + 0.15), (ceilY + railY - 0.6) / 2, 0, 0.3, wallH, L);
    for (let z = -L / 2 + 14; z < L / 2 - 10; z += 26) {
      const band = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.8), bandMat);
      band.position.set(side * HALL_HALF_W - side * 0.01, floorY + 2.75, z);
      band.rotation.y = -side * Math.PI / 2;
      group.add(band);
    }
    // tunnel walls & roof beyond the platform
    for (const end of [-1, 1]) {
      const cz = end * (L / 2 + TUNNEL_LEN / 2);
      box(group, M.tunnel, side * (HALL_HALF_W + 0.15), (ceilY + railY - 0.6) / 2, cz, 0.3, wallH, TUNNEL_LEN, false);
    }
  }
  // the ceiling, open over the top of each flight of stairs (see below)
  const flightTop = L / 2 - 4 - STAIR_LEN; // where the flights start, either end
  box(group, M.ceiling, 0, ceilY + 0.15, 0, HALL_HALF_W * 2 + 0.6, 0.3, flightTop * 2);
  for (const end of [-1, 1]) {
    const zc = end * (flightTop + L / 2 + 0.1) / 2;
    const len = L / 2 + 0.1 - flightTop;
    const sideW = HALL_HALF_W + 0.3 - STAIR_W / 2 - 0.1;
    for (const side of [-1, 1]) box(group, M.ceiling, side * (STAIR_W / 2 + 0.1 + sideW / 2), ceilY + 0.15, zc, sideW, 0.3, len);
  }
  for (const end of [-1, 1]) {
    const ez = end * (L / 2);
    box(group, M.tunnel, 0, ceilY + 0.15, end * (L / 2 + TUNNEL_LEN / 2), HALL_HALF_W * 2 + 0.6, 0.3, TUNNEL_LEN, false);
    // the platform's end wall (between the two tunnel mouths) and the far ends of the tunnels
    box(group, M.tile, 0, (floorY + ceilY) / 2, ez + end * 0.15, PLATFORM_HALF_W * 2 + 0.4, ceilY - floorY, 0.3);
    box(group, M.tunnel, 0, (ceilY + railY - 0.6) / 2, end * (L / 2 + TUNNEL_LEN), HALL_HALF_W * 2 + 0.6, wallH, 0.3, false);
    box(group, M.tunnel, 0, floorY - PLATFORM_H / 2, end * (L / 2 + TUNNEL_LEN / 2), PLATFORM_HALF_W * 2, PLATFORM_H, TUNNEL_LEN, false); // the bench wall between the tracks
  }

  // I-beam columns down both platform edges, the fluorescent strips and the hanging name signs
  const columns = [];
  for (const side of [-1, 1]) for (let z = -L / 2 + 6; z <= L / 2 - 6; z += 7.5) columns.push([side * (PLATFORM_HALF_W - 1.0), (floorY + ceilY) / 2, z, 0.26, ceilY - floorY, 0.32]);
  instanced(group, M.column, columns, true);
  const lamps = [];
  for (const x of [-2.2, 2.2, -TRACK_X, TRACK_X]) for (let z = -L / 2 + 3; z <= L / 2 - 3; z += 6) lamps.push([x, ceilY - 0.06, z, 0.16, 0.06, 3.2]);
  instanced(group, M.lamp, lamps);
  const signMat = new THREE.MeshBasicNodeMaterial({ map: nameSignTexture(station) });
  for (let z = -L / 2 + 20; z < L / 2 - 15; z += 30) {
    for (const face of [0, Math.PI]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 0.5), signMat);
      sign.position.set(face ? -0.02 : 0.02, ceilY - 0.75, z);
      sign.rotation.y = face + Math.PI / 2;
      group.add(sign);
    }
  }
  const lights = [];
  for (let z = -L / 2 + 12; z <= L / 2 - 12; z += 22) {
    const light = new THREE.PointLight(0xfff3dc, 60, 24, 1.6);
    light.position.set(0, ceilY - 0.5, z);
    group.add(light);
    lights.push(light);
  }

  // Stairs up to the street at both ends of the platform: a flight rising toward the end wall through an opening in
  // the ceiling, daylight at the top
  const stairs = [];
  const steps = [];
  const stairSteps = 14;
  for (const end of [-1, 1]) {
    const z0 = end * (L / 2 - 4 - STAIR_LEN); // foot of the flight
    stairs.push({ z0, end });
    for (let s = 0; s < stairSteps; s++) {
      const rise = ((s + 1) / stairSteps) * STAIR_RISE;
      const zc = z0 + end * ((s + 0.5) / stairSteps) * STAIR_LEN;
      steps.push([0, floorY + rise / 2, zc, STAIR_W, rise, STAIR_LEN / stairSteps]);
    }
    // the flight's side rails, then its shaft up through the ceiling: tiled sides, daylight from the street at the top
    for (const side of [-1, 1]) box(group, M.column, side * (STAIR_W / 2 + 0.05), floorY + STAIR_RISE / 2 + 0.5, z0 + end * STAIR_LEN / 2, 0.08, STAIR_RISE + 1, STAIR_LEN, false);
    const shaftLen = L / 2 - Math.abs(z0) + 0.1;
    const shaftZ = z0 + end * shaftLen / 2;
    for (const side of [-1, 1]) box(group, M.tile, side * (STAIR_W / 2 + 0.25), ceilY + 2.2, shaftZ, 0.3, 4.4, shaftLen, false);
    box(group, M.daylight, 0, ceilY + 4.3, shaftZ, STAIR_W + 0.2, 0.1, shaftLen, false);
  }
  instanced(group, M.step, steps, true);

  // Trains: one on each track, the east one (+x) running along the route's direction, the west one against it
  const services = [...station.services].filter((r) => LINES.has(r));
  const trains = [-1, 1].map((side, i) => {
    const ref = services[i % Math.max(1, services.length)] || frame.line?.ref || 'S';
    const t = buildTrain(LINES.get(ref), ref);
    const pivot = new THREE.Group();
    pivot.position.set(side * TRACK_X, railY, 0);
    pivot.rotation.y = side > 0 ? 0 : Math.PI; // the west train runs -z
    pivot.add(t);
    group.add(pivot);
    return { pivot, train: t, ref, phase: i * (TRAIN_PERIOD / 2) + 6 };
  });

  return { group, frame, heading, floorY, ceilY, railY, stairs, trains, lights, station };
}

function createSubwaySystem(scene) {
  let current = null;
  const cos = () => Math.cos(current.heading);
  const sin = () => Math.sin(current.heading);
  // world <-> station frame (the group's rotation about y)
  const toLocal = (x, z) => {
    const dx = x - current.frame.x, dz = z - current.frame.z;
    return { lx: dx * cos() - dz * sin(), lz: dx * sin() + dz * cos() };
  };
  const toWorld = (lx, lz) => ({ x: current.frame.x + lx * cos() + lz * sin(), z: current.frame.z - lx * sin() + lz * cos() });

  // The rise of a flight of stairs under (lx, lz), 0 off the stairs
  function stairRise(lx, lz) {
    if (Math.abs(lx) > STAIR_W / 2) return 0;
    for (const s of current.stairs) {
      const along = (lz - s.z0) * s.end;
      if (along > 0 && along < STAIR_LEN + 0.6) return Math.min(STAIR_RISE, (along / STAIR_LEN) * STAIR_RISE);
    }
    return 0;
  }

  const system = {
    get active() { return !!current; },
    get station() { return current ? current.station : null; },
    get label() {
      return current ? current.station.name : '';
    },
    nearestStation(x, z) {
      let best = null, bestD = Infinity;
      for (const s of STATIONS) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < bestD) { bestD = d; best = s; }
      }
      return best;
    },
    // Down into the station nearest (x, z): returns where the player arrives on the platform (world x, y, z & heading)
    enter(x, z) {
      this.leave();
      const station = this.nearestStation(x, z);
      if (!station) return null;
      current = buildStation(station);
      scene.add(current.group);
      // at the foot of the flight nearest to where the player came down, facing along the platform
      const near = toLocal(x, z).lz >= 0 ? 1 : -1;
      const foot = current.stairs.find((s) => s.end === near) || current.stairs[0];
      const at = toWorld(0, foot.z0 - foot.end * 2.5);
      return { x: at.x, y: current.floorY, z: at.z, heading: current.heading + (foot.end > 0 ? Math.PI : 0) };
    },
    // Back up to the street: the real entrance nearest to where the player stands, or the station's own node
    leave() {
      if (!current) return null;
      const out = { x: current.station.x, z: current.station.z };
      current.group.removeFromParent();
      const shared = new Set(Object.values(materials()));
      current.group.traverse((o) => {
        if (o.isInstancedMesh) o.dispose();
        else if (o.isMesh && o.geometry !== unitBox) o.geometry.dispose();
        if (o.isMesh && !shared.has(o.material)) {
          o.material.map?.dispose();
          o.material.dispose();
        }
      });
      current = null;
      return out;
    },
    // Where the player comes out: beside the real entrance nearest to (x, z), on the curb side of its sidewalk (the
    // stairs stand a couple of metres in from the curb, see street-details.js) and facing the street
    exitPoint(x, z) {
      let best = null, bestD = Infinity;
      for (const e of ENTRANCES) {
        const d = Math.hypot(e.x - x, e.z - z);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best || bestD > 260) return null;
      let curb = Infinity, nx = 0, nz = 1;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        for (let r = 0.5; r < Math.min(curb, 14); r += 0.5) {
          if (!blockAt(best.x + Math.cos(a) * r, best.z + Math.sin(a) * r)) {
            curb = r;
            nx = Math.cos(a);
            nz = Math.sin(a);
            break;
          }
        }
      }
      if (curb > 14) return { x: best.x, z: best.z, heading: null };
      return { x: best.x + nx * (curb - 0.8), z: best.z + nz * (curb - 0.8), heading: Math.atan2(nx, nz) };
    },
    // The walking surface under (x, z) in the station: the platform, or a step of the stairs
    floorAt(x, z) {
      const { lx, lz } = toLocal(x, z);
      return current.floorY + stairRise(lx, lz);
    },
    // Keep the pedestrian (radius r) on the platform: off the tracks, inside the end walls, off the columns
    clamp(pos, r) {
      const { lx, lz } = toLocal(pos.x, pos.z);
      let x = Math.max(-PLATFORM_HALF_W + r, Math.min(PLATFORM_HALF_W - r, lx));
      let z = Math.max(-PLATFORM_LEN / 2 + 0.3 + r, Math.min(PLATFORM_LEN / 2 - 0.3 - r, lz));
      // the stairs' side rails: on a flight stay between them, beside it stay clear of it
      const rise = stairRise(0, z);
      if (rise > 0.05) {
        const onFlight = Math.abs(lx) < STAIR_W / 2;
        if (onFlight) x = Math.max(-STAIR_W / 2 + r, Math.min(STAIR_W / 2 - r, x));
        else x = x < 0 ? Math.min(x, -STAIR_W / 2 - 0.1 - r) : Math.max(x, STAIR_W / 2 + 0.1 + r);
      }
      const w = toWorld(x, z);
      pos.x = w.x;
      pos.z = w.z;
    },
    // Climbed far enough up a flight to come out on the street
    reachedStreet(x, z) {
      const { lx, lz } = toLocal(x, z);
      return stairRise(lx, lz) >= STAIR_EXIT_RISE;
    },
    // Keep a camera inside the station: between the walls & the ends, under the ceiling, over the platform or rails
    clampCamera(pos) {
      const { lx, lz } = toLocal(pos.x, pos.z);
      const x = Math.max(-HALL_HALF_W + 0.35, Math.min(HALL_HALF_W - 0.35, lx));
      const z = Math.max(-PLATFORM_LEN / 2 - 30, Math.min(PLATFORM_LEN / 2 + 30, lz));
      const overPlatform = Math.abs(x) < PLATFORM_HALF_W && Math.abs(z) < PLATFORM_LEN / 2;
      const w = toWorld(x, z);
      pos.x = w.x;
      pos.z = w.z;
      pos.y = Math.max((overPlatform ? current.floorY : current.railY) + 0.4, Math.min(current.ceilY - 0.3, pos.y));
    },
    update(dt, elapsed) {
      if (!current) return;
      for (const tr of current.trains) {
        const t = (elapsed + tr.phase) % TRAIN_PERIOD;
        tr.train.position.z = trainHead(t);
      }
    }
  };
  return system;
}

export { createSubwaySystem, routeFrame, trainHead, STATIONS, PLATFORM_LEN, TRAIN_PERIOD };
