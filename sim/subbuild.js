// Builds a submarine FROM SCRATCH: you describe rooms on a grid and how they connect; the builder makes everything the
// game needs around them and hands back a SubDoc (sim/subedit.js) for the electrical work (items, wires, circuit boxes).
//
// What it makes (conventions taken from the vanilla subs, see SUBBUILD.md):
//   room   -> a hull (rect = floor surface .. top of its ceiling slab), a background wall, its ceiling slab
//   shell  -> outer hull pieces on every room edge that touches the outside (96 thick), flipped like vanilla (bottom FY,
//             right FX) so the metal sits against the room; then SMOOTHING (sim/shellgeom.js):
//             * steps: where the outline steps (a hump, an overhang) a slanted piece fills the notch. It sits in the
//               empty corner outside both rooms, so it costs no space (how the Camel's humps are done);
//             * top corners: a shallow slope across each outer top corner (cuts at most ~60 into the ceiling corner);
//             * bottom corners: opt-in per room ({ bevelBottom: true }), because it cuts into the floor corner.
//             Every result is checked watertight (rays from each room must hit solid structure).
//   walls  -> inside walls centred on shared vertical edges (48 thick), slabs on shared horizontal edges
//   door   -> door item + its gap (linked), the wall segment removed
//   hatch  -> hatch item + gap in the slab + a ladder through it
//   waypoints -> a path along every floor at +113, linked through doors (gap=) and ladders (ladders=), spawn points
// Coordinates: x right, y up (game). A room is given by its floor-left corner and size: { x, y (floor), w, h }.
'use strict';
const X = require('./subxml'), SE = require('./subedit'), G = require('./shellgeom');

const WALL = 48, SHELL = 96, DOOR_H = 208, WP_H = 113;
const CL = 36;  // a straight shell's plate centre line is 36 outside the room edge (plate 72 thick, against the room)
const OV = 24;  // straight shells run this far under a slope so the joint has no crack
// slanted pieces the builder may use: the submarine shell set that the vanilla subs actually place (sprites unseen, so
// stay with proven pieces). Geometry comes from the prefab catalog.
const SLOPES = ['shella04deg', 'shella14degb', 'shella16deg', 'shella16degb', 'shella32deg', 'ShellA17deg', 'Shella18deg', 'shella26deg', 'shella34degb', 'shella38deg', 'shella43deg',
  'shella45degc', 'shella45degd', 'Shella47deg', 'Shella51deg', 'shella52deg', 'shella54deg', 'shella57deg', 'Shella60deg', 'ShellA61deg', 'Shella70deg'];

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
    this.style = Object.assign({ shell: 'shella0deg', shellV: 'shella90deg', wall: 'ff_x_wall', wallV: 'ff_y_wall', back: 'FF_Wall_G2', shellColor: null, wallColor: null, backColor: null,
      smooth: true, bevelTop: true, slopes: SLOPES }, style || {});
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

  // is (x, y) inside some room?
  occ(x, y) { return Object.values(this.rooms).some(r => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1); }
  // corners of the outline: a convex corner has one occupied quadrant around it, a step (notch) has three.
  // type = where the outside is: TL TR BL BR. o = outward direction (x, y).
  outlineCorners() {
    const pts = new Map(), e = 1;
    for (const r of Object.values(this.rooms)) for (const [x, y] of [[r.x0, r.y0], [r.x0, r.y1], [r.x1, r.y0], [r.x1, r.y1]]) pts.set(x + ',' + y, [x, y]);
    const out = [];
    for (const [x, y] of pts.values()) {
      const q = { TL: this.occ(x - e, y + e), TR: this.occ(x + e, y + e), BL: this.occ(x - e, y - e), BR: this.occ(x + e, y - e) }, n = Object.values(q).filter(Boolean).length;
      const opp = { TL: 'BR', TR: 'BL', BL: 'TR', BR: 'TL' };
      if (n === 1) { const t = opp[Object.keys(q).find(k => q[k])]; out.push({ kind: 'convex', type: t, x, y }); }
      if (n === 3) { const t = Object.keys(q).find(k => !q[k]); out.push({ kind: 'notch', type: t, x, y }); }
    }
    for (const c of out) { c.ox = c.type[1] === 'L' ? -1 : 1; c.oy = c.type[0] === 'T' ? 1 : -1; }
    return out;
  }
  // straight shell runs along exposed room edges: { side, at (the edge's x or y), a0, a1 (span along it), e0, e1 (where the
  // shell piece actually starts/ends, after corner closing and smoothing) }
  shellRuns() {
    const runs = [];
    for (const r of Object.values(this.rooms)) {
      for (const side of ['top', 'bottom', 'left', 'right']) for (const [a0, a1] of this.exposed(r, side)) {
        const at = side === 'top' ? r.y1 : side === 'bottom' ? r.y0 : side === 'left' ? r.x0 : r.x1;
        runs.push({ side, at, a0, a1, e0: a0, e1: a1, horiz: side === 'top' || side === 'bottom' });
      }
    }
    return runs;
  }
  // choose a slanted piece: span (dx, dy) within the limits, angle in range; biggest wins
  pickSlope(maxDx, maxDy, minDeg, maxDeg) {
    const all = G.slopePieces().filter(p => this.style.slopes.includes(p.id));
    const ok = all.filter(p => p.dx <= maxDx && p.dy <= maxDy && p.deg >= minDeg && p.deg <= maxDeg);
    return ok.sort((a, b) => b.dx * b.dy - a.dx * a.dy)[0] || null;
  }
  shell(d, rs, col) {
    const S = this.style, runs = this.shellRuns(), slopes = [];
    const runAt = (horiz, at, end) => runs.filter(u => u.horiz === horiz && u.at === at && (u.a0 === end || u.a1 === end));
    // convex corners: horizontal runs reach past the corner by a shell width to close it (unless smoothed below)
    const corners = this.outlineCorners();
    for (const c of corners.filter(c => c.kind === 'convex')) for (const u of runAt(true, c.y, c.x)) { if (u.a0 === c.x && c.ox < 0) u.e0 = c.x - SHELL; if (u.a1 === c.x && c.ox > 0) u.e1 = c.x + SHELL; }
    const setEnd = (u, end, v) => { if (u.a0 === end) u.e0 = v; else u.e1 = v; };
    if (S.smooth) {
      // short steps: a run between an outer corner and a notch of the same type (a small step in the outline) gets
      // ONE slope across it, from one wall's centre line to the other's (span along the run = the run's length)
      const used = new Set();
      for (const u of runs) {
        const len = u.a1 - u.a0; if (len > 260) continue;
        const ends = [u.a0, u.a1].map(a => corners.find(c => (u.horiz ? (c.x === a && c.y === u.at) : (c.y === a && c.x === u.at))));
        if (!ends[0] || !ends[1] || ends[0].kind === ends[1].kind || ends[0].type !== ends[1].type) continue;
        const cv = ends.find(c => c.kind === 'convex'), nt = ends.find(c => c.kind === 'notch');
        // the runs across the run at each end (the walls the slope joins)
        const other = c => runAt(!u.horiz, u.horiz ? c.x : c.y, u.horiz ? c.y : c.x).find(w => w !== u);
        const wc = other(cv), wn = other(nt); if (!wc || !wn) continue;
        const room = Math.min(wc.a1 - wc.a0, wn.a1 - wn.a0) - 20;
        const all = G.slopePieces().filter(p => S.slopes.includes(p.id));
        const fit = all.filter(p => Math.abs((u.horiz ? p.dx : p.dy) - len) <= 16 && (u.horiz ? p.dy : p.dx) <= room)
          .sort((a, b) => (u.horiz ? b.dy - a.dy : b.dx - a.dx) || Math.abs((u.horiz ? a.dx : a.dy) - len) - Math.abs((u.horiz ? b.dx : b.dy) - len)); // steepest that fits: reads as a curve
        const p = fit[0]; if (!p) continue;
        // centre line points: on the convex end's wall and on the notch end's wall, centred on the run's centre line
        const c = cv, along = u.horiz ? p.dy : p.dx;
        let A, Bp;
        if (u.horiz) { const ys = u.at + c.oy * CL; A = [cv.x + c.ox * CL, ys - c.oy * along / 2]; Bp = [nt.x + c.ox * CL, ys + c.oy * along / 2]; }
        else { const xs = u.at + c.ox * CL; A = [xs - c.ox * along / 2, cv.y + c.oy * CL]; Bp = [xs + c.ox * along / 2, nt.y + c.oy * CL]; }
        slopes.push({ piece: p, corner: c.type, a: A, b: Bp, at: c, bridge: true });
        u.dead = true; used.add(cv); used.add(nt);
        // trim the two walls: the convex end's wall stops under the slope's low end, the notch end's wall starts at its high end
        const ax = u.horiz ? 1 : 0; // the coordinate along those walls
        setEnd(wc, u.horiz ? cv.y : cv.x, A[ax] + (u.horiz ? c.oy : c.ox) * OV);
        setEnd(wn, u.horiz ? nt.y : nt.x, Bp[ax] - (u.horiz ? c.oy : c.ox) * OV);
      }
      // steps: fill the notch with a slope from the horizontal edge's centre line to the vertical edge's centre line
      for (const c of corners.filter(c => c.kind === 'notch' && !used.has(c))) {
        const h = runAt(true, c.y, c.x)[0], v = runAt(false, c.x, c.y)[0]; if (!h || !v) continue;
        const shared = corners.some(o => o !== c && o.kind === 'notch' && ((o.y === c.y && (o.x === h.a0 || o.x === h.a1)) || (o.x === c.x && (o.y === v.a0 || o.y === v.a1))));
        const maxDx = (h.a1 - h.a0) / (shared ? 2 : 1) - CL - 40, maxDy = v.a1 - v.a0;
        const p = this.pickSlope(maxDx, maxDy, 25, 65) || this.pickSlope(maxDx, maxDy, 10, 80); if (!p) continue;
        const Q = [c.x + c.ox * CL, c.y + c.oy * CL], A = [Q[0] + c.ox * p.dx, Q[1]], Bp = [Q[0], Q[1] + c.oy * p.dy];
        slopes.push({ piece: p, corner: c.type, a: A, b: Bp, at: c });
        setEnd(h, c.x, A[0] - c.ox * OV);
        if (p.dy >= maxDy - 1) v.dead = true; else setEnd(v, c.y, Bp[1] - c.oy * OV);
      }
      // outer corners: a shallow slope across the top ones (and the bottom ones of rooms that ask for it)
      for (const c of corners.filter(c => c.kind === 'convex' && !used.has(c))) {
        const room = Object.values(this.rooms).find(r => (r.x0 === c.x || r.x1 === c.x) && (r.y0 === c.y || r.y1 === c.y));
        if (c.type[0] === 'T' ? !S.bevelTop : !(room && room.bevelBottom)) continue;
        const h = runAt(true, c.y, c.x)[0], v = runAt(false, c.x, c.y)[0]; if (!h || !v) continue;
        const room_w = h.a1 - h.a0, room_h = v.a1 - v.a0;
        // cut at most ~60 into the room vertically (headroom / floor); a shallow slope can run most of the edge
        const p = this.pickSlope(Math.min(room_w * 0.85, 520), CL + 62, 3, 25); if (!p) continue;
        const C = [c.x + c.ox * CL, c.y + c.oy * CL], A = [C[0] - c.ox * p.dx, C[1]], Bp = [C[0], C[1] - c.oy * p.dy];
        slopes.push({ piece: p, corner: c.type, a: A, b: Bp, at: c });
        setEnd(h, c.x, A[0] + c.ox * OV);
        if (p.dy >= room_h) v.dead = true; else setEnd(v, c.y, Bp[1] + c.oy * OV);
      }
    }
    // straight shells (vanilla flips: bottom FY, right FX, so the plate sits against the room)
    for (const u of runs) {
      if (u.dead) continue;
      const lo = Math.min(u.e0, u.e1), hi = Math.max(u.e0, u.e1); if (hi - lo < 8) continue;
      const fl = u.side === 'bottom' ? { flippedy: 'true' } : u.side === 'right' ? { flippedx: 'true' } : {};
      if (u.side === 'top') d.addStructure(S.shell, lo, u.at + SHELL, hi - lo, SHELL, Object.assign(col(S.shellColor), fl));
      if (u.side === 'bottom') d.addStructure(S.shell, lo, u.at, hi - lo, SHELL, Object.assign(col(S.shellColor), fl));
      if (u.side === 'left') d.addStructure(S.shellV, u.at - SHELL, hi, SHELL, hi - lo, Object.assign(col(S.shellColor), fl));
      if (u.side === 'right') d.addStructure(S.shellV, u.at, hi, SHELL, hi - lo, Object.assign(col(S.shellColor), fl));
    }
    for (const sl of slopes) {
      const st = G.place(sl.piece, sl.corner, sl.a, sl.b), [x, top, w, h] = st.rect, fl = {};
      if (st.flippedx) fl.flippedx = 'true'; if (st.flippedy) fl.flippedy = 'true';
      d.addStructure(st.identifier, x, top, w, h, Object.assign(col(S.shellColor), fl));
    }
    this.slopes = slopes;
  }
  build() {
    const d = this.doc, S = this.style, rs = Object.values(this.rooms);
    const col = c => c ? { SpriteColor: c } : {};
    // rooms: hull + background
    for (const r of rs) {
      r.hull = d.addHull(r.x0, r.y1, r.x1 - r.x0, r.y1 - r.y0, { RoomName: r.name, IsWetRoom: r.wet ? 'True' : 'False' });
      d.addStructure(S.back, r.x0, r.y1, r.x1 - r.x0, r.y1 - r.y0, col(S.backColor));
    }
    this.shell(d, rs, col);
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
