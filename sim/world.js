// The outside world for the circuit sandbox: level rock, vehicles (drones, shuttles, a small sub) that move with the
// game's physics, divers and monsters. Devices in a .sbx script are mounted on a vehicle with On=<vehicle>, and then:
//   engine   pushes it (set_force), the game's force lerp and 20 x MaxForce N at full thrust
//   pump     fills or empties its ballast tank (set_speed / set_targetlevel / set_active)
//   nav      reports its velocity and position and takes velocity_in, like the nav terminal
//   motion   a motion detector: an axis-aligned box at an offset that sees divers, monsters and (while moving) rock
//   turret   aims with the coilgun's spring, fires bolts that hit rock and characters, can auto-operate
// Formulas and their sources: reference/VEHICLE_MECHANICS.md. Units: px (100 px = 1 m), y up, 60 ticks a second.
//
// Statements (parsed by sim/sandbox.js):
//   world [Top=0] [Bounds=x0,y0,x1,y1]       Top: the depth reference (current_position_y = (Top - y) / 100)
//   rock x0,y0,x1,y1                         a rectangle of rock
//   wall x,y x,y x,y ...                     a convex polygon of rock (split a concave shape into convex pieces)
//   vehicle <id> At=x,y Size=w,h [Mass=kg] [Volume=px²] [Tank=px²] [Water=px²] [Neutral=0.5]
//   diver <id> At=x,y [Path="x,y x,y ..."] [Speed=150] [Loop=false] [Hp=100] [Team=crew|enemy]
//   monster <id> Kind=crawler|mudraptor At=x,y [Sight=1000] [Hp=...]
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaroWorld = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PX = 100, DEG = Math.PI / 180;
  const num = (v, d) => { const n = Number(v); return v === undefined || v === '' || !Number.isFinite(n) ? d : n; };
  const pair = (s, d) => { if (s === undefined) return d; const p = String(s).split(',').map(Number); return p.length === 2 && p.every(Number.isFinite) ? p : d; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrap360 = a => ((a % 360) + 360) % 360;

  // ---------- geometry: convex rock pieces ----------
  function convex(points) {
    let pts = points.map(p => [p[0], p[1]]);
    let area = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
    if (area < 0) pts = pts.reverse(); // counter-clockwise (y up): outward normal of edge a->b is (dy, -dx)
    const edges = pts.map((a, i) => { const b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return { a, b, n: [dy / l, -dx / l] }; });
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { pts, edges, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), cx: xs.reduce((a, b) => a + b, 0) / xs.length, cy: ys.reduce((a, b) => a + b, 0) / ys.length };
  }
  const inside = (P, x, y) => P.edges.every(e => (x - e.a[0]) * e.n[0] + (y - e.a[1]) * e.n[1] <= 0);
  function proj(pts, ax) { let lo = Infinity, hi = -Infinity; for (const p of pts) { const d = p[0] * ax[0] + p[1] * ax[1]; if (d < lo) lo = d; if (d > hi) hi = d; } return [lo, hi]; }
  // smallest push that moves box (x0,y0,x1,y1) out of the convex piece P, or null
  function boxPush(b, P) {
    if (b.x1 <= P.x0 || b.x0 >= P.x1 || b.y1 <= P.y0 || b.y0 >= P.y1) return null;
    const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
    let best = null;
    for (const ax of [[1, 0], [0, 1], ...P.edges.map(e => e.n)]) {
      const [a0, a1] = proj(corners, ax), [p0, p1] = proj(P.pts, ax), o = Math.min(a1, p1) - Math.max(a0, p0);
      if (o <= 0) return null;
      if (!best || o < best.d) { const dir = ((b.x0 + b.x1) / 2 - P.cx) * ax[0] + ((b.y0 + b.y1) / 2 - P.cy) * ax[1] >= 0 ? 1 : -1; best = { d: o, n: [ax[0] * dir, ax[1] * dir] }; }
    }
    return best;
  }
  function closestOnSeg(x, y, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1, t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l2, 0, 1); return [a[0] + t * dx, a[1] + t * dy]; }
  // push for a circle out of P
  function circlePush(x, y, r, P) {
    if (x + r <= P.x0 || x - r >= P.x1 || y + r <= P.y0 || y - r >= P.y1) return null;
    let bd = Infinity, bp = null, be = null;
    for (const e of P.edges) { const c = closestOnSeg(x, y, e.a, e.b), d = Math.hypot(x - c[0], y - c[1]); if (d < bd) { bd = d; bp = c; be = e; } }
    if (inside(P, x, y)) return { d: bd + r, n: be.n };
    if (bd >= r) return null;
    return { d: r - bd, n: [(x - bp[0]) / (bd || 1), (y - bp[1]) / (bd || 1)] };
  }
  function segHit(ax, ay, bx, by, cx, cy, dx, dy) { // segments a-b and c-d intersect: returns t along a-b or null
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx; if (Math.abs(den) < 1e-9) return null;
    const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  }
  function segRock(ax, ay, bx, by, P) { // first hit of segment a-b on P (t), or null
    if (Math.max(ax, bx) < P.x0 || Math.min(ax, bx) > P.x1 || Math.max(ay, by) < P.y0 || Math.min(ay, by) > P.y1) return null;
    if (inside(P, ax, ay)) return 0;
    let best = null; for (const e of P.edges) { const t = segHit(ax, ay, bx, by, e.a[0], e.a[1], e.b[0], e.b[1]); if (t !== null && (best === null || t < best)) best = t; }
    return best;
  }
  function rayCircle(ax, ay, dx, dy, cx, cy, r) { // ray a + t*(dx,dy), |d| = 1: smallest t >= 0 hitting the circle
    const fx = ax - cx, fy = ay - cy, b = fx * dx + fy * dy, c = fx * fx + fy * fy - r * r, disc = b * b - c;
    if (disc < 0) return null; const t = -b - Math.sqrt(disc); return t >= 0 ? t : (c <= 0 ? 0 : null);
  }
  // MotionSensor wall test: the box's centre is inside rock, or a rock edge crosses one of the box's sides
  function boxTouchesRock(b, P) {
    if (b.x1 < P.x0 || b.x0 > P.x1 || b.y1 < P.y0 || b.y0 > P.y1) return false;
    if (inside(P, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)) return true;
    const sides = [[b.x0, b.y0, b.x1, b.y0], [b.x1, b.y0, b.x1, b.y1], [b.x1, b.y1, b.x0, b.y1], [b.x0, b.y1, b.x0, b.y0]];
    return P.edges.some(e => sides.some(s => segHit(s[0], s[1], s[2], s[3], e.a[0], e.a[1], e.b[0], e.b[1]) !== null));
  }

  const MONSTERS = {
    crawler: { speed: 400, hp: 80, r: 45, bite: 150, dmg: 12, every: 3, flee: 10, armour: 1 },
    mudraptor: { speed: 250, hp: 150, r: 85, bite: 100, dmg: 30, every: 3, flee: 0, armour: 0.4 },
  };
  const TURRETS = {
    coilgun: { k: 26, c: 5.25, vmax: 4.5, reload: 0.25, aimTol: 10, spin: 0, damage: 15, life: 3 },
    chaingun: { k: 26, c: 5.25, vmax: 3.0, reload: 0.1, aimTol: 30, spin: 1, damage: 12, life: 2 },
  };

  class World {
    // cfg: { top, bounds, rocks: [[[x,y]...]], vehicles: [{id, props}], chars: [{id, kind, props}] }; sb: the sandbox
    constructor(cfg, sb) {
      this.sb = sb; this.top = num(cfg.top, 0); this.rocks = (cfg.rocks || []).map(convex); this.vehicles = new Map(); this.chars = new Map();
      this.bolts = []; this.events = []; this.kills = 0; this.friendly = 0; this.t = 0; this.devs = [];
      let seed = 99; this.rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (const v of cfg.vehicles || []) {
        const P = v.props, [x, y] = pair(P.At, [0, 0]), [w, h] = pair(P.Size, [300, 150]), vol = num(P.Volume, w * h);
        const tank = num(P.Tank, 0.14 * vol), nb = num(P.Neutral, 0.5);
        this.vehicles.set(v.id, { id: v.id, x, y, vx: 0, vy: 0, w, h, mass: num(P.Mass, 100 * vol / 1e4 + 50 * (2 * (w + h) * 16) / 1e4), volume: vol, tank, water: num(P.Water, 0.07 * vol), nbl: nb,
          contact: false, bumps: 0, impacts: 0, maxImpact: 0, trail: [[x, y]], bites: 0, devs: [] });
      }
      for (const c of cfg.chars || []) {
        const P = c.props, [x, y] = pair(P.At, [0, 0]), m = c.kind === 'monster' ? (MONSTERS[String(P.Kind || 'crawler').toLowerCase()] || MONSTERS.crawler) : null;
        const path = P.Path ? String(P.Path).trim().split(/\s+/).map(s => pair(s, null)).filter(Boolean) : [];
        this.chars.set(c.id, { id: c.id, human: c.kind === 'diver', kind: c.kind === 'diver' ? 'diver' : String(P.Kind || 'crawler').toLowerCase(), x, y, vx: 0, vy: 0, home: [x, y],
          r: m ? m.r : 30, speed: num(P.Speed, m ? m.speed : 150), hp: num(P.Hp, m ? m.hp : 100), maxHp: num(P.Hp, m ? m.hp : 100), alive: true, m, sight: num(P.Sight, 1000),
          team: String(P.Team || (c.kind === 'diver' ? 'crew' : 'monster')).toLowerCase(), path, wp: 0, loop: /^(1|true|yes)$/i.test(P.Loop || ''), cool: 0, hits: 0, hurt: 0, bites: 0 });
      }
    }
    log(m) { const s = `${this.t.toFixed(2)}s ${m}`; this.events.push(s); if (this.events.length > 400) this.events.shift(); if (this.sb) this.sb.log.push(s); }
    // a sandbox device with On=<vehicle>; returns an error message or null
    bind(o) {
      const v = this.vehicles.get(o.props.On); if (!v) return `"${o.props.On}" is not a vehicle (On=...)`;
      const P = o.props, s = o.s; o.vehicle = v; v.devs.push(o); this.devs.push(o);
      const [ox, oy] = pair(P.Offset, [0, 0]); o.off = [ox, oy];
      if (o.type === 'engine') { s.force = 0; s.target = 0; o.maxForce = num(P.MaxForce, 300); }
      else if (o.type === 'pump') { o.maxFlow = num(P.MaxFlow, 600); }
      else if (o.type === 'motion') { o.rx = clamp(num(P.RangeX, num(P.Range, 100)), 0, 1000); o.ry = clamp(num(P.RangeY, num(P.Range, 100)), 0, 1000); o.minV = num(P.MinimumVelocity, 0); const tg = String(P.Target || 'Any').toLowerCase(); o.tg = { human: /any|human/.test(tg), monster: /any|monster/.test(tg), wall: /any|wall/.test(tg) }; o.next = this.rand() * 0.1; s.value = '0'; }
      else if (o.type === 'turret') { const T = TURRETS[String(P.Kind || 'coilgun').toLowerCase()] || TURRETS.coilgun; o.T = T; o.min = num(P.MinAngle, 180); o.max = num(P.MaxAngle, 360); o.rot = (o.min + o.max) / 2 * DEG; o.w = 0; s.angle = o.rot / DEG; s.shots = 0; s.hits = 0; o.auto = /^(1|true|yes)$/i.test(P.AutoOperate || ''); o.tHumans = /^(1|true|yes)$/i.test(P.TargetHumans || ''); o.tMonsters = !/^(0|false|no)$/i.test(P.TargetMonsters || 'true'); o.damage = num(P.Damage, T.damage); o.spun = 0; o.last = -1e9; }
      else if (o.type === 'nav') { s.tx = 0; s.ty = 0; s.gx = 0; s.gy = 0; s.lastIn = -1e9; }
      return null;
    }
    // the outputs a mounted device sends this tick (called from the device's update)
    navOut(o) {
      const v = o.vehicle, s = o.s, nb = v.nbl;
      const vy = lerp((nb * 100 - 50) * 2, -100 * Math.sign(s.ty), Math.abs(s.ty) / 100);
      return { velocity_x_out: fmt(s.tx), velocity_y_out: fmt(vy), current_velocity_x: (v.vx / PX * 3.6).toFixed(4), current_velocity_y: (-v.vy / PX * 3.6).toFixed(4),
        current_position_x: fmt(v.x / PX), current_position_y: fmt((this.top - v.y) / PX) };
    }
    // velocity_in "x,y" (y positive = down) or the pilot's own steering (y up)
    // velocity_in sets the target velocity at once (Steering.ReceiveSignal); the pilot's own steering ramps toward the
    // input at 15.6 units/s (steeringAdjustSpeed 0.2: (1 / 0.8)^2 * 10)
    pilot(o, to) { o.pilotTo = to; if (!to) this.steer(o, 0, 0, true); }
    steer(o, x, y, direct) { const s = o.s; s.gx = clamp(x, -100, 100); s.gy = clamp(y, -100, 100); if (direct) { s.tx = s.gx; s.ty = s.gy; } }
    step(dt) {
      this.t += dt;
      for (const v of this.vehicles.values()) this.stepVehicle(v, dt);
      for (const o of this.devs) if (o.type === 'motion') this.stepMotion(o, dt); else if (o.type === 'turret') this.stepTurret(o, dt);
      this.stepBolts(dt);
      for (const c of this.chars.values()) this.stepChar(c, dt);
    }
    stepVehicle(v, dt) {
      let fx = 0, fy = 0;
      for (const o of v.devs) {
        const s = o.s;
        if (o.type === 'engine') { s.target = clamp(num(s.force, 0), -100, 100); s.cur = lerp(s.cur || 0, s.target, Math.min(1, dt * 10)); if (Math.abs(s.cur) > 1) fx += s.cur * o.maxForce * 0.1 * 2; }
        else if (o.type === 'pump') {
          if (s.on === false) continue;
          let flow = num(s.speed, 0); if (s.target !== undefined && s.target !== null) flow = Math.round(clamp((s.target - v.water / v.tank * 100) * 10, -100, 100));
          s.flow = flow; v.water = clamp(v.water + flow / 100 * o.maxFlow * dt * 60, 0, v.tank);
        }
        else if (o.type === 'nav' && o.pilotTo) { // a scripted pilot heading for a point (no rock avoidance), like "maintain position"
          const dx = o.pilotTo[0] - v.x - v.vx * 2, dy = o.pilotTo[1] - v.y - v.vy * 2, d = Math.hypot(dx, dy), k = d > 500 ? 100 / d : 1 / 5;
          s.gx = s.tx = lerp(s.tx, clamp(dx * k, -100, 100), 0.1); s.gy = s.ty = lerp(s.ty, clamp(dy * k, -100, 100), 0.1);
        }
        else if (o.type === 'nav') { s.tx += clamp(s.gx - s.tx, -15.6 * dt, 15.6 * dt); s.ty += clamp(s.gy - s.ty, -15.6 * dt, 15.6 * dt); } // the pilot's input: the target velocity follows it at 15.6 units/s
      }
      // buoyancy, drag (SubmarineBody.cs), then semi-implicit Euler in m/s
      let b = 0.07 - v.water / v.volume; b = b > 0 ? 2 * b : Math.max(b, -0.5);
      fy += b * v.mass * 10;
      const mx = v.vx / PX, my = v.vy / PX;
      if (mx * mx + my * my > 1e-4) { fx -= Math.sign(mx) * mx * mx * 0.01 * v.mass; fy -= Math.sign(my) * my * my * 0.05 * v.mass; }
      v.vx += dt * fx / v.mass * PX; v.vy += dt * fy / v.mass * PX;
      v.x += dt * v.vx; v.y += dt * v.vy;
      // rock: push out, kill the speed into the wall, slide with friction 0.2
      let touching = false;
      for (let pass = 0; pass < 3; pass++) {
        let any = false;
        for (const P of this.rocks) {
          const box = { x0: v.x - v.w / 2, x1: v.x + v.w / 2, y0: v.y - v.h / 2, y1: v.y + v.h / 2 }, hit = boxPush(box, P); if (!hit) continue;
          any = touching = true; v.x += hit.n[0] * hit.d; v.y += hit.n[1] * hit.d;
          const vn = v.vx * hit.n[0] + v.vy * hit.n[1];
          if (vn < 0) {
            const s = -vn / PX;
            if (!v.contact) { if (s > 0.5) v.bumps++; if (s >= 3) { v.impacts++; this.log(`${v.id} hits rock at ${s.toFixed(1)} m/s (damage)`); } v.maxImpact = Math.max(v.maxImpact, s); }
            v.vx -= vn * hit.n[0]; v.vy -= vn * hit.n[1];
            const tx = -hit.n[1], ty = hit.n[0], vt = v.vx * tx + v.vy * ty, cut = Math.min(Math.abs(vt), 0.2 * -vn) * Math.sign(vt);
            v.vx -= cut * tx; v.vy -= cut * ty;
          }
        }
        if (!any) break;
      }
      v.contact = touching;
      const last = v.trail[v.trail.length - 1]; if (Math.hypot(v.x - last[0], v.y - last[1]) > 40) { v.trail.push([v.x, v.y]); if (v.trail.length > 3000) v.trail.splice(0, 1000); }
    }
    stepMotion(o, dt) {
      o.next -= dt; if (o.next > 0) return; o.next += 0.1;
      const v = o.vehicle, cx = v.x + o.off[0], cy = v.y + o.off[1], box = { x0: cx - o.rx, x1: cx + o.rx, y0: cy - o.ry, y1: cy + o.ry };
      let on = false; const speed = Math.hypot(v.vx, v.vy) / PX;
      for (const c of this.chars.values()) {
        if (!c.alive || !(c.human ? o.tg.human : o.tg.monster)) continue;
        if (o.minV > 0 && Math.hypot(c.vx, c.vy) / PX < o.minV) continue;
        const nx = clamp(c.x, box.x0, box.x1), ny = clamp(c.y, box.y0, box.y1); if (Math.hypot(c.x - nx, c.y - ny) < c.r) { on = true; break; }
      }
      if (!on && o.tg.wall && speed > o.minV) on = this.rocks.some(P => boxTouchesRock(box, P));
      const nv = on ? '1' : '0'; if (nv !== o.s.value) o.s.value = nv;
    }
    stepTurret(o, dt) {
      const v = o.vehicle, s = o.s, T = o.T, px = v.x + o.off[0], py = v.y + o.off[1];
      let want = num(s.angle, o.rot / DEG), fire = !!s.trigger; s.trigger = false;
      if (o.auto) { // AutoOperate: nearest live target within 3500 px and the limits, never the own team
        let best = null, bd = 3500;
        for (const c of this.chars.values()) {
          if (!c.alive || (c.human ? !o.tHumans : !o.tMonsters) || (c.human && c.team !== 'enemy')) continue;
          const d = Math.hypot(c.x - px, c.y - py), a = wrap360(Math.atan2(-(c.y - py), c.x - px) / DEG); if (d > bd || !within(a, o.min, o.max)) continue; bd = d; best = c;
        }
        o.target = best ? best.id : null; fire = false;
        if (best) { want = wrap360(Math.atan2(-(best.y - py), best.x - px) / DEG); const err = Math.abs(angDiff(want, o.rot / DEG)); if (err < T.aimTol && this.firstInLine(px, py, o.rot, best.id) === best.id) fire = true; }
      }
      // aim: clamp into the limits, then the damped spring (Turret.cs)
      const tgt = clampAngle(wrap360(want), o.min, o.max) * DEG; let diff = tgt - o.rot; if (o.max - o.min >= 360) diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      o.w += (diff * T.k - o.w * T.c) * dt; o.w = clamp(o.w, -T.vmax, T.vmax); o.rot += o.w * dt; s.rot = o.rot / DEG;
      if (T.spin) { o.spun = fire ? Math.min(1, o.spun + dt) : 0; if (o.spun < 1) fire = false; }
      if (fire && this.t - o.last >= T.reload) {
        o.last = this.t; s.shots++; const dx = Math.cos(o.rot), dy = -Math.sin(o.rot), spread = T.spin ? (this.rand() - 0.5) * 9.5 * DEG : 0;
        const ca = Math.cos(spread), sa = Math.sin(spread), bx = dx * ca - dy * sa, by = dx * sa + dy * ca;
        this.bolts.push({ x: px + bx * 60, y: py + by * 60, vx: bx * 6080, vy: by * 6080, life: T.life, from: o, damage: o.damage });
      }
    }
    firstInLine(px, py, rot, wantId) { // the ray from the turret: which character does it reach first (rock blocks it)
      const dx = Math.cos(rot), dy = -Math.sin(rot); let best = null, bt = 3600;
      for (const P of this.rocks) { const t = segRock(px, py, px + dx * 3600, py + dy * 3600, P); if (t !== null && t * 3600 < bt) { bt = t * 3600; best = null; } }
      for (const c of this.chars.values()) { if (!c.alive) continue; const t = rayCircle(px, py, dx, dy, c.x, c.y, c.r); if (t !== null && t < bt) { bt = t; best = c.id; } }
      return best;
    }
    stepBolts(dt) {
      const keep = [];
      for (const b of this.bolts) {
        const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt; let hitT = null, who = null;
        for (const P of this.rocks) { const t = segRock(b.x, b.y, nx, ny, P); if (t !== null && (hitT === null || t < hitT)) { hitT = t; who = null; } }
        const len = Math.hypot(nx - b.x, ny - b.y), ux = (nx - b.x) / len, uy = (ny - b.y) / len;
        for (const c of this.chars.values()) { if (!c.alive) continue; const t = rayCircle(b.x, b.y, ux, uy, c.x, c.y, c.r); if (t !== null && t <= len && (hitT === null || t / len < hitT)) { hitT = t / len; who = c; } }
        if (hitT !== null) {
          if (who) {
            const dmg = b.damage * (who.m ? who.m.armour : 1); who.hp -= dmg; who.hurt += dmg; who.hits++; b.from.s.hits++;
            if (who.human) { this.friendly++; this.log(`${b.from.id} hits diver ${who.id}! (hp ${Math.max(0, who.hp).toFixed(0)})`); }
            else this.log(`${b.from.id} hits ${who.kind} ${who.id} (hp ${Math.max(0, who.hp).toFixed(0)})`);
            if (who.hp <= 0) { who.alive = false; who.vx = who.vy = 0; if (!who.human) this.kills++; this.log(`${who.id} dies`); }
          }
          continue;
        }
        b.x = nx; b.y = ny; b.life -= dt; if (b.life > 0) keep.push(b);
      }
      this.bolts = keep;
    }
    stepChar(c, dt) {
      if (!c.alive) return;
      let tx = null, ty = null, sp = c.speed;
      if (c.human) {
        if (c.goto) { [tx, ty] = c.goto; if (Math.hypot(tx - c.x, ty - c.y) < 20) c.goto = null; }
        else if (c.path.length) {
          const p = c.path[c.wp]; if (p) { tx = p[0]; ty = p[1]; if (Math.hypot(tx - c.x, ty - c.y) < 20) { c.wp++; if (c.wp >= c.path.length) c.wp = c.loop ? 0 : c.path.length; } }
        }
      } else {
        const m = c.m; c.cool = Math.max(0, c.cool - dt);
        if (m.flee && c.hp < m.flee) { const v = this.nearest(c, x => x.human, 2000); if (v) { tx = c.x * 2 - v.x; ty = c.y * 2 - v.y; } }
        else {
          const prey = this.nearest(c, x => x.human, c.sight), sub = prey ? null : this.nearestVehicle(c, c.sight);
          if (prey) { tx = prey.x; ty = prey.y; if (Math.hypot(prey.x - c.x, prey.y - c.y) < m.bite + c.r + prey.r && c.cool <= 0) { c.cool = m.every; prey.hp -= m.dmg; prey.hurt += m.dmg; prey.bites++; this.log(`${c.kind} ${c.id} bites ${prey.id} (hp ${Math.max(0, prey.hp).toFixed(0)})`); if (prey.hp <= 0) { prey.alive = false; this.log(`${prey.id} dies`); } } }
          else if (sub) { tx = sub.x; ty = sub.y; if (Math.hypot(sub.x - c.x, sub.y - c.y) < m.bite + c.r + Math.max(sub.w, sub.h) / 2 && c.cool <= 0) { c.cool = m.every; sub.bites++; this.log(`${c.kind} ${c.id} bites ${sub.id}`); } }
          else { tx = c.home[0]; ty = c.home[1]; sp *= 0.3; }
        }
      }
      let ax = 0, ay = 0;
      if (tx !== null) { const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy); if (d > 1) { ax = dx / d * Math.min(sp, d / dt); ay = dy / d * Math.min(sp, d / dt); } }
      c.vx = lerp(c.vx, ax, Math.min(1, dt * 4)); c.vy = lerp(c.vy, ay, Math.min(1, dt * 4));
      c.x += c.vx * dt; c.y += c.vy * dt;
      for (const P of this.rocks) { const h = circlePush(c.x, c.y, c.r, P); if (h) { c.x += h.n[0] * h.d; c.y += h.n[1] * h.d; const vn = c.vx * h.n[0] + c.vy * h.n[1]; if (vn < 0) { c.vx -= vn * h.n[0]; c.vy -= vn * h.n[1]; } } }
      for (const v of this.vehicles.values()) { const h = boxPushCircle(v, c); if (h) { c.x += h.n[0] * h.d; c.y += h.n[1] * h.d; } }
    }
    nearest(c, f, range) { let best = null, bd = range; for (const o of this.chars.values()) { if (o === c || !o.alive || !f(o)) continue; const d = Math.hypot(o.x - c.x, o.y - c.y); if (d < bd) { bd = d; best = o; } } return best; }
    nearestVehicle(c, range) { let best = null, bd = range; for (const v of this.vehicles.values()) { const d = Math.hypot(v.x - c.x, v.y - c.y); if (d < bd) { bd = d; best = v; } } return best; }
    // a scripted diver swims somewhere else: at <t> goto <diver> x,y
    goto(id, x, y) { const c = this.chars.get(id); if (!c) return false; c.goto = [x, y]; c.path = []; return true; }
    // values for expect / watch: drone.x, drone.depth, drone.impacts, player.hp, crawler1.alive, drone.dist.player, world.kills
    value(target) {
      const p = target.split('.'), obj = this.vehicles.get(p[0]) || this.chars.get(p[0]);
      if (p[0] === 'world') return p[1] === 'kills' ? this.kills : p[1] === 'friendly' ? this.friendly : p[1] === 'bolts' ? this.bolts.length : undefined;
      if (!obj || p.length < 2) return undefined;
      const f = p[1];
      if (f === 'dist') { const o = this.vehicles.get(p[2]) || this.chars.get(p[2]); return o ? Math.hypot(o.x - obj.x, o.y - obj.y) : undefined; }
      if (f === 'speed') return Math.hypot(obj.vx, obj.vy) / PX;
      if (f === 'depth') return (this.top - obj.y) / PX;
      if (f === 'ballast') return obj.tank ? obj.water / obj.tank * 100 : undefined;
      if (f === 'alive') return obj.alive ? 1 : 0;
      const v = obj[f]; return typeof v === 'number' || typeof v === 'boolean' ? Number(v) : undefined;
    }
    // everything the web view draws
    snapshot() {
      return { t: this.t, rocks: this.rocks, bolts: this.bolts.map(b => [b.x, b.y, b.vx, b.vy]),
        vehicles: [...this.vehicles.values()].map(v => ({ id: v.id, x: v.x, y: v.y, w: v.w, h: v.h, vx: v.vx, vy: v.vy, ballast: v.water / v.tank, trail: v.trail, impacts: v.impacts, bites: v.bites,
          devs: v.devs.map(o => ({ id: o.id, type: o.type, off: o.off, rx: o.rx, ry: o.ry, on: o.s.value === '1', rot: o.rot, cur: o.s.cur, min: o.min, max: o.max, auto: o.auto, target: o.target })) })),
        chars: [...this.chars.values()].map(c => ({ id: c.id, kind: c.kind, human: c.human, x: c.x, y: c.y, r: c.r, hp: c.hp, maxHp: c.maxHp, alive: c.alive, path: c.path, goto: c.goto })) };
    }
  }
  function within(a, lo, hi) { if (hi - lo >= 360) return true; a = wrap360(a); const l = wrap360(lo), h = l + (hi - lo); return (a >= l && a <= h) || (a + 360 >= l && a + 360 <= h); }
  function clampAngle(a, lo, hi) { // into [lo, hi] (degrees, lo may be < 0 or hi > 360), snapping to the nearer limit
    if (hi - lo >= 360) return a;
    for (const k of [-360, 0, 360]) if (a + k >= lo && a + k <= hi) return a + k;
    const dl = Math.abs(angDiff(a, lo)), dh = Math.abs(angDiff(a, hi)); return dl < dh ? lo : hi;
  }
  function angDiff(a, b) { return ((a - b + 540) % 360) - 180; }
  function boxPushCircle(v, c) { // keep characters out of a vehicle's box
    const nx = clamp(c.x, v.x - v.w / 2, v.x + v.w / 2), ny = clamp(c.y, v.y - v.h / 2, v.y + v.h / 2), dx = c.x - nx, dy = c.y - ny, d = Math.hypot(dx, dy);
    if (d >= c.r) return null; if (d < 1e-6) { const ox = c.x - v.x; return { d: v.w / 2 - Math.abs(ox) + c.r, n: [ox >= 0 ? 1 : -1, 0] }; }
    return { d: c.r - d, n: [dx / d, dy / d] };
  }
  function fmt(x) { const r = Math.round(x * 1000) / 1000; return String(Object.is(r, -0) ? 0 : r); }
  // statements the sandbox hands over: returns true if it was a world statement
  function parseLine(k, t, props, w) {
    if (k === 'world') { const p = props(t.slice(1)); w.top = num(p.Top, 0); w.used = true; return true; }
    if (k === 'rock') { const [x0, y0, x1, y1] = String(t[1] || '').split(',').map(Number); if (![x0, y0, x1, y1].every(Number.isFinite)) throw new Error('rock x0,y0,x1,y1'); w.rocks.push([[Math.min(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.max(y0, y1)], [Math.min(x0, x1), Math.max(y0, y1)]]); w.used = true; return true; }
    if (k === 'wall') { const pts = t.slice(1).map(s => s.split(',').map(Number)); if (pts.length < 3 || pts.some(p => p.length !== 2 || !p.every(Number.isFinite))) throw new Error('wall x,y x,y x,y ... (3 or more corners)'); if (!isConvex(pts)) throw new Error('wall: the corners must make a convex shape (split it into convex pieces)'); w.rocks.push(pts); w.used = true; return true; }
    if (k === 'vehicle') { w.vehicles.push({ id: t[1], props: props(t.slice(2)) }); w.used = true; return true; }
    if (k === 'diver' || k === 'monster') { w.chars.push({ id: t[1], kind: k, props: props(t.slice(2)) }); w.used = true; return true; }
    return false;
  }
  function isConvex(pts) { let sign = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length], z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]); if (Math.abs(z) < 1e-9) continue; if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false; } return true; }
  return { World, parseLine, convex, boxPush, circlePush, boxTouchesRock, segRock, MONSTERS, TURRETS, clampAngle, emptySpec: () => ({ used: false, top: 0, rocks: [], vehicles: [], chars: [] }) };
});
