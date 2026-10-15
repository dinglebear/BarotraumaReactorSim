// Builds a submarine FROM SCRATCH: you describe rooms on a grid and how they connect; the builder makes everything the
// game needs around them and hands back a SubDoc (sim/subedit.js) for the electrical work (items, wires, circuit boxes).
//
// What it makes (conventions taken from the vanilla subs, see SUBBUILD.md):
//   room   -> a hull (rect = floor surface .. top of its ceiling slab), a background wall, its ceiling slab
//   shell  -> outer hull pieces on every room edge that touches the outside (96 thick), corners covered
//   walls  -> inside walls centred on shared vertical edges (48 thick), slabs on shared horizontal edges
//   door   -> door item + its gap (linked), the wall segment removed
//   hatch  -> hatch item + gap in the slab + a ladder through it
//   waypoints -> a path along every floor at +113, linked through doors (gap=) and ladders (ladders=), spawn points
// Coordinates: x right, y up (game). A room is given by its floor-left corner and size: { x, y (floor), w, h }.
'use strict';
const X = require('./subxml'), SE = require('./subedit');

const WALL = 48, SHELL = 96, DOOR_H = 208, WP_H = 113;

function blankSub(meta) {
  const a = Object.assign({
    description: '', checkval: String(Math.floor(Math.random() * 2147483647)), price: '5000', SoldByFaction: '', MinReputationToBuy: '0', tier: '1',
    initialsuppliesspawned: 'false', noitems: 'false', lowfuel: 'false', type: 'Player', ismanuallyoutfitted: 'false', class: 'Scout', tags: '0',
    outposttags: '', triggeroutpostmissionevents: '', gameversion: '1.13.2.0', dimensions: '0,0', cargocapacity: '4', recommendedcrewsizemin: '2',
    recommendedcrewsizemax: '4', recommendedcrewexperience: 'CrewExperienceLow', requiredcontentpackages: 'Vanilla', name: 'New Sub',
  }, meta || {});
  const attrs = Object.entries(a).map(([k, v]) => ` ${k}="${X.enc(v)}"`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<Submarine${attrs}>\n</Submarine>\n`;
}

class SubBuilder {
  // templates: SubDocs of vanilla subs (items, structures, hull/gap templates come from them)
  constructor(templates, meta, style) {
    this.doc = new SE.SubDoc(blankSub(meta), templates);
    this.rooms = {}; this.doors = []; this.hatches = []; this.spawns = [];
    this.style = Object.assign({ shell: 'shella0deg', shellV: 'shella90deg', wall: 'ff_x_wall', wallV: 'ff_y_wall', back: 'FF_Wall_G2', shellColor: null, wallColor: null, backColor: null }, style || {});
  }
  room(key, x, y, w, h, opts) { this.rooms[key] = Object.assign({ key, x0: x, x1: x + w, y0: y, y1: y + h, name: key }, opts || {}); return this; }
  door(a, b, opts) { this.doors.push(Object.assign({ a, b }, opts || {})); return this; }
  hatch(lower, upper, x, opts) { this.hatches.push(Object.assign({ lower, upper, x }, opts || {})); return this; }
  spawn(room, job, x) { this.spawns.push({ room, job, x }); return this; }

  // ----- geometry helpers -----
  static overlap(a0, a1, b0, b1) { const lo = Math.max(a0, b0), hi = Math.min(a1, b1); return hi > lo ? [lo, hi] : null; }
  neighbours() { // shared edges between rooms
    const rs = Object.values(this.rooms), v = [], h = [];
    for (const a of rs) for (const b of rs) {
      if (a === b) continue;
      if (a.x1 === b.x0) { const o = SubBuilder.overlap(a.y0, a.y1, b.y0, b.y1); if (o) v.push({ a, b, x: a.x1, y0: o[0], y1: o[1] }); }
      if (a.y1 === b.y0) { const o = SubBuilder.overlap(a.x0, a.x1, b.x0, b.x1); if (o) h.push({ lower: a, upper: b, y: a.y1, x0: o[0], x1: o[1] }); }
    }
    return { v, h };
  }
  // the parts of a room edge that touch no other room: [[from, to], ...]
  exposed(r, side) {
    const horiz = side === 'top' || side === 'bottom'; let segs = [horiz ? [r.x0, r.x1] : [r.y0, r.y1]];
    for (const o of Object.values(this.rooms)) {
      if (o === r) continue;
      let cut = null;
      if (side === 'top' && o.y0 === r.y1) cut = SubBuilder.overlap(r.x0, r.x1, o.x0, o.x1);
      if (side === 'bottom' && o.y1 === r.y0) cut = SubBuilder.overlap(r.x0, r.x1, o.x0, o.x1);
      if (side === 'left' && o.x1 === r.x0) cut = SubBuilder.overlap(r.y0, r.y1, o.y0, o.y1);
      if (side === 'right' && o.x0 === r.x1) cut = SubBuilder.overlap(r.y0, r.y1, o.y0, o.y1);
      if (!cut) continue;
      segs = segs.flatMap(([s0, s1]) => { const out = []; if (cut[0] > s0) out.push([s0, Math.min(cut[0], s1)]); if (cut[1] < s1) out.push([Math.max(cut[1], s0), s1]); return out.filter(q => q[1] - q[0] > 1); });
    }
    return segs;
  }

  build() {
    const d = this.doc, S = this.style, rs = Object.values(this.rooms);
    const col = c => c ? { SpriteColor: c } : {};
    // rooms: hull + background
    for (const r of rs) {
      r.hull = d.addHull(r.x0, r.y1, r.x1 - r.x0, r.y1 - r.y0, { RoomName: r.name, IsWetRoom: r.wet ? 'True' : 'False' });
      d.addStructure(S.back, r.x0, r.y1, r.x1 - r.x0, r.y1 - r.y0, col(S.backColor));
    }
    // outer shell on exposed edges (outside the hulls); horizontal pieces run past the corners to close them
    for (const r of rs) {
      const L = this.exposed(r, 'left').length > 0, R = this.exposed(r, 'right').length > 0;
      for (const [x0, x1] of this.exposed(r, 'top')) d.addStructure(S.shell, x0 - (x0 === r.x0 && L ? SHELL : 0), r.y1 + SHELL, x1 - x0 + (x0 === r.x0 && L ? SHELL : 0) + (x1 === r.x1 && R ? SHELL : 0), SHELL, col(S.shellColor));
      for (const [x0, x1] of this.exposed(r, 'bottom')) d.addStructure(S.shell, x0 - (x0 === r.x0 && L ? SHELL : 0), r.y0, x1 - x0 + (x0 === r.x0 && L ? SHELL : 0) + (x1 === r.x1 && R ? SHELL : 0), SHELL, col(S.shellColor));
      for (const [y0, y1] of this.exposed(r, 'left')) d.addStructure(S.shellV, r.x0 - SHELL, y1, SHELL, y1 - y0, col(S.shellColor));
      for (const [y0, y1] of this.exposed(r, 'right')) d.addStructure(S.shellV, r.x1, y1, SHELL, y1 - y0, col(S.shellColor));
    }
    const nb = this.neighbours();
    // horizontal slabs between floors (inside the lower room's top), with hatch openings cut out
    for (const e of nb.h) {
      const holes = this.hatches.filter(h => this.rooms[h.lower] === e.lower && this.rooms[h.upper] === e.upper).map(h => [h.x - 64, h.x + 64]).sort((p, q) => p[0] - q[0]);
      let x = e.x0;
      for (const [h0, h1] of holes) { if (h0 > x) d.addStructure(S.wall, x, e.y, h0 - x, WALL, col(S.wallColor)); x = h1; }
      if (e.x1 > x) d.addStructure(S.wall, x, e.y, e.x1 - x, WALL, col(S.wallColor));
    }
    // vertical walls on shared edges (centred), below the ceiling slab; a door takes the whole height (doors are 208 tall)
    for (const e of nb.v) {
      if (e.a.x0 > e.b.x0) continue; // each pair once
      const top = e.y1 - WALL, hasDoor = this.doors.some(dr => (this.rooms[dr.a] === e.a && this.rooms[dr.b] === e.b) || (this.rooms[dr.a] === e.b && this.rooms[dr.b] === e.a));
      const bottom = hasDoor ? e.y0 + DOOR_H : e.y0;
      if (top - bottom > 1) d.addStructure(S.wallV, e.x - WALL / 2, top, WALL, top - bottom, col(S.wallColor));
    }
    // doors: item + gap linked
    for (const dr of this.doors) {
      const a = this.rooms[dr.a], b = this.rooms[dr.b], e = nb.v.find(v => (v.a === a && v.b === b) || (v.a === b && v.b === a));
      if (!e) throw new Error(`rooms ${dr.a} and ${dr.b} share no wall`);
      const gap = d.addGap(e.x - 17, e.y0 + DOOR_H, 34, DOOR_H, true);
      const door = d.add(null, dr.identifier || 'doorwbuttons', e.x, e.y0 + DOOR_H / 2); X.set(d.ref(door), 'linked', gap);
      dr.gap = gap; dr.item = door; dr.x = e.x; dr.y = e.y0;
    }
    // hatches: item + gap + ladder
    for (const h of this.hatches) {
      const lo = this.rooms[h.lower], up = this.rooms[h.upper];
      const gap = d.addGap(h.x - 64, lo.y1 + 5, 128, WALL + 10, false);
      const hatch = d.add(null, h.identifier || 'hatchwbuttons', h.x, lo.y1 - WALL / 2); X.set(d.ref(hatch), 'linked', gap);
      const top = up.y0 + 120, len = top - lo.y0;
      const lad = d.add(null, 'ladder', h.x - 40, lo.y0 + len / 2); const ln = d.ref(lad), rr = (X.get(ln, 'rect') || '0,0,11,384').split(',').map(Number);
      X.set(ln, 'rect', `${Math.round(h.x - 40 - rr[2] / 2)},${Math.round(top)},${rr[2]},${Math.round(len)}`);
      h.gap = gap; h.item = hatch; h.ladder = lad;
    }
    this.waypoints();
    // sub size for the menus
    const xs = rs.flatMap(r => [r.x0 - SHELL, r.x1 + SHELL]), ys = rs.flatMap(r => [r.y0, r.y1 + SHELL]);
    X.set(d.sub, 'dimensions', `${Math.round(Math.max(...xs) - Math.min(...xs))},${Math.round(Math.max(...ys) - Math.min(...ys))}`);
    return d;
  }

  // AI paths: a line of waypoints along each floor, joined through doors and up ladders; spawn points for jobs
  waypoints() {
    const d = this.doc, STEP = 120;
    for (const r of Object.values(this.rooms)) {
      r.wps = []; const n = Math.max(1, Math.round((r.x1 - r.x0 - 60) / STEP));
      for (let i = 0; i <= n; i++) { const x = r.x0 + 30 + (r.x1 - r.x0 - 60) * (n ? i / n : 0.5); r.wps.push({ x, id: d.addWaypoint(x, r.y0 + WP_H) }); }
      for (let i = 1; i < r.wps.length; i++) d.linkWaypoints(r.wps[i - 1].id, r.wps[i].id);
    }
    const nearest = (r, x) => r.wps.reduce((p, q) => Math.abs(q.x - x) < Math.abs(p.x - x) ? q : p);
    for (const dr of this.doors) { // a waypoint in the doorway, carrying the gap
      const w = d.addWaypoint(dr.x, dr.y + WP_H, { gap: dr.gap });
      d.linkWaypoints(w, nearest(this.rooms[dr.a], dr.x).id); d.linkWaypoints(w, nearest(this.rooms[dr.b], dr.x).id);
    }
    for (const h of this.hatches) { // ladder waypoints at the bottom and the top, carrying the ladder (and the gap at the top)
      const lo = this.rooms[h.lower], up = this.rooms[h.upper];
      const w0 = d.addWaypoint(h.x - 40, lo.y0 + WP_H, { ladders: h.ladder }), w1 = d.addWaypoint(h.x - 40, up.y0 + WP_H, { ladders: h.ladder, gap: h.gap });
      d.linkWaypoints(w0, w1); d.linkWaypoints(w0, nearest(lo, h.x).id); d.linkWaypoints(w1, nearest(up, h.x).id);
    }
    for (const s of this.spawns) { const r = this.rooms[s.room], x = s.x !== undefined ? s.x : (r.x0 + r.x1) / 2; const w = d.addWaypoint(x, r.y0 + WP_H, { spawn: s.job === 'cargo' ? 'Cargo' : 'Human', job: s.job === 'cargo' || s.job === 'any' ? null : s.job }); d.linkWaypoints(w, nearest(r, x).id); }
  }
}

module.exports = { SubBuilder, blankSub, WALL, SHELL, DOOR_H, WP_H };
