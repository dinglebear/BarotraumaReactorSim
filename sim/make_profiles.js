// Generates synthetic test files (until real recordings from the PowerLogger mod exist).
// Each is a small ship model ticking at 60/s, written in the same CSV format as the mod:
//   nav terminal: velocity_x/y_out move toward the pilot's input at the game's default steering rate
//   engines: (|velocity_x_out|/100)^1.5 * engine kW, one tick after the nav terminal (Engine.targetForce)
//   ballast pumps: |velocity_y_out|/100 * pump kW;  guns: supercapacitor charging bursts;  sonar: active pings
// node sim/make_profiles.js
'use strict';
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'load_profiles');
function rng(seed) { let a = seed; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }
const STEER = Math.pow(1 / (1 - 0.2), 2) * 10; // Steering default adjust speed 0.2 -> 15.6 units/s

function ship(name, o) {
  const r = rng(o.seed), dt = 1 / 60;
  const cols = ['demand', 'rods', 'nav.velocity_x_out', 'nav.velocity_y_out', 'engines.load_value_out', 'pumps.load_value_out', 'guns.load_value_out', 'sonar.load_value_out'];
  const L = ['# BaroPowerLog v2 (synthetic ship model)', `# sub=${o.sub}`, `# reactor_max_kw=${o.maxKW}`, `# duration=${o.dur}`, `# fuel_rods=${o.rods || 2}`, `# fuel_type=${o.fuel || 'uranium'}`,
    `# engines kW=${o.engineKW} pumps kW=${o.pumpKW} base kW=${o.base}`, 't,' + cols.join(',')];
  let inX = 0, inY = 0, vx = 0, vy = 0, prevVx = 0, nextX = 0, nextY = 0, gun = 0, gunEnd = 0, nextGun = o.gunEvery ? 20 : Infinity, sonar = 0, nextPing = 0, last = null, lastT = -99, base = o.base;
  for (let i = 0; i <= o.dur * 60; i++) {
    const t = i * dt;
    if (t >= nextX) { const p = o.pilot(r, t); inX = p.x; nextX = t + p.hold; }
    if (t >= nextY) { inY = r() < 0.6 ? 0 : (r() < 0.5 ? -1 : 1) * (20 + r() * 80); nextY = t + 5 + r() * 25; }
    // nav terminal TargetVelocity approaches the input at the steering rate
    const dx = inX - vx, dy = inY - vy, len = Math.hypot(dx, dy);
    if (len > 0) { const step = Math.min(STEER * dt, len); vx += dx / len * step; vy += dy / len * step; }
    const engines = Math.pow(Math.abs(prevVx) / 100, 1.5) * o.engineKW; prevVx = vx;      // engine uses last tick's force
    const pumps = Math.abs(vy) / 100 * o.pumpKW;
    if (t >= nextGun) { gun = o.gunKW * (0.6 + r() * 0.4); gunEnd = t + 2 + r() * 4; nextGun = t + o.gunEvery * (0.5 + r()); }
    if (t >= gunEnd) gun = 0;
    if (o.sonarKW && t >= nextPing) { sonar = sonar ? 0 : o.sonarKW; nextPing = t + (sonar ? 1 : 6 + r() * 6); }
    if (o.baseFn) base = o.baseFn(t, r);
    const demand = base + engines + pumps + gun + sonar;
    const rods = o.rodsAt ? o.rodsAt(t) : (o.rods || 2);
    const row = [demand, rods, vx, vy, engines, pumps, gun, sonar];
    const changed = !last || row.some((v, k) => Math.abs(v - last[k]) >= (k === 1 ? 1 : k === 2 || k === 3 ? 0.5 : 2));
    if (changed || t - lastT >= 5) { L.push(t.toFixed(3) + ',' + row.map((v, k) => k === 1 ? String(v) : (k === 2 || k === 3) ? v.toFixed(4) : v.toFixed(1)).join(',')); last = row; lastT = t; }
  }
  fs.writeFileSync(path.join(out, name + '.csv'), L.join('\n') + '\n');
}
fs.mkdirSync(out, { recursive: true });
// cruise: steady travel, occasional speed changes
ship('synthetic_cruise', { seed: 1, sub: 'synthetic', maxKW: 3000, dur: 900, base: 900, engineKW: 1500, pumpKW: 300, sonarKW: 0, gunEvery: 0,
  pilot: (r) => ({ x: [0, 40, 60, 80, 100][Math.floor(r() * 5)], hold: 30 + r() * 60 }) });
// combat: hard manoeuvring, railgun charging, active sonar
ship('synthetic_combat', { seed: 2, sub: 'synthetic', maxKW: 5200, dur: 900, base: 1300, engineKW: 2200, pumpKW: 600, gunKW: 1200, gunEvery: 12, sonarKW: 300,
  pilot: (r) => ({ x: r() < 0.35 ? 0 : (r() < 0.5 ? -1 : 1) * (60 + r() * 40), hold: 3 + r() * 12 }) });
// ramps: slow base-load ramps plus full-throttle sprints (tests overshoot)
ship('synthetic_ramps', { seed: 3, sub: 'synthetic', maxKW: 4000, dur: 900, base: 1000, engineKW: 1800, pumpKW: 400, gunEvery: 0,
  baseFn: (t) => 1000 + 900 * (0.5 - 0.5 * Math.cos(t / 900 * 2 * Math.PI * 2)),
  pilot: (r, t) => ({ x: (t % 120) > 95 ? 100 : 30, hold: 5 }) });
// long haul: long quiet drifts (batteries fill up if nothing stops them) and fights ABOVE the reactor's max output
//            (only stored battery energy can cover those) -> tests battery state-of-charge management
ship('synthetic_longhaul', { seed: 4, sub: 'synthetic', maxKW: 3000, dur: 2400, base: 700, engineKW: 1900, pumpKW: 400, gunKW: 1300, gunEvery: 40, sonarKW: 250, fuel: 'thorium',
  pilot: (r) => { const q = r(); return q < 0.4 ? { x: 0, hold: 120 + r() * 200 } : q < 0.75 ? { x: 50 + r() * 30, hold: 40 + r() * 100 } : { x: 100, hold: 30 + r() * 60 }; } });
// rod swap: 5200 kW reactor on 1 rod, 3 more rods put in at 2:00, back to 2 at 7:00 (vanilla automatic control overheats and catches fire)
ship('synthetic_rodswap', { seed: 5, sub: 'synthetic', maxKW: 5200, dur: 600, base: 1200, engineKW: 2200, pumpKW: 500, gunKW: 1000, gunEvery: 30, sonarKW: 250, rods: 1,
  rodsAt: (t) => t < 120 ? 1 : t < 420 ? 4 : 2,
  pilot: (r) => ({ x: r() < 0.3 ? 0 : 40 + r() * 60, hold: 10 + r() * 30 }) });
console.log('wrote synthetic profiles to load_profiles/');
