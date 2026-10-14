// Generates the synthetic test files: a ship model ticking at 60/s, written in the PowerLogger mod's CSV format.
// Calibrated on the real rounds in load_profiles/ (Dugong, Humpback, Typhon2):
//   base load: near-constant (lights, doors, oxygen...), plus fabricator/charging steps of 100-250 kW now and then
//   nav terminal: velocity_x/y_out move toward the pilot's input at the game's steering rate (15.6 units/s);
//     pilots stop ~40 % of the time, run flat out ~25 %, and adjust depth (velocity_y) almost constantly
//   engines: (|velocity_x_out|/100)^1.5 * engine kW, one tick late (fits the Dugong log within 9 kW)
//   pumps: ballast = |velocity_y_out|/100 * ballast kW, plus bilge pumps switching on during leaks
//   guns: supercapacitors recharging at ~160 kW each while a gunner fires, fading ~22 %/s after;
//     fights come in episodes of bursts; big ships add a railgun charge
//   sonar: 10 kW passive all round, 100 kW while active (minutes at a time)
//   rods and fuel are not part of a test file: the test settings choose them (tests are about demand)
// node sim/make_profiles.js [outDir]
'use strict';
const fs = require('fs'), path = require('path');
const out = process.argv[2] || path.join(__dirname, '..', 'load_profiles');
function rng(seed) { let a = seed; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }
const STEER = Math.pow(1 / (1 - 0.2), 2) * 10; // Steering default adjust speed 0.2 -> 15.6 units/s
const SHIPS = { // from the real logs: base = demand minus devices (median), device maxima, supercapacitor count
  dugong: { sub: 'Dugong (synthetic)', maxKW: 3000, batteries: '2 (capacity 1000 kW*min)', base: 1375, engineKW: 600, ballastKW: 800, bilgeKW: 350, caps: 2, railKW: 0 },
  humpback: { sub: 'Humpback (synthetic)', maxKW: 3100, batteries: '5 (capacity 2060 kW*min)', base: 1430, engineKW: 1500, ballastKW: 700, bilgeKW: 400, caps: 2, railKW: 0 },
  typhon: { sub: 'Typhon2 (synthetic)', maxKW: 5200, batteries: '2 (capacity 3000 kW*min)', base: 1740, engineKW: 2600, ballastKW: 1000, bilgeKW: 700, caps: 7, railKW: 1900 },
};
const CAP_KW = 160, CAP_FADE = 0.78; // per supercapacitor; recharge fades to 78 % per second after firing stops

function ship(name, S, o) {
  const r = rng(o.seed), dt = 1 / 60, pick = (a, b) => a + r() * (b - a);
  const cols = ['demand', 'nav.velocity_x_out', 'nav.velocity_y_out', 'engines.load_value_out', 'pumps.load_value_out', 'guns.load_value_out', 'sonar.load_value_out'];
  const L = ['# BaroPowerLog v2 (synthetic ship model, sim/make_profiles.js)', `# sub=${S.sub}`, `# reactor_max_kw=${S.maxKW}`, `# duration=${o.dur}`,
    `# ship_batteries=${S.batteries}`, `# scenario=${o.note}`, 't,' + cols.join(',')];
  // pilot
  let inX = 0, inY = 0, vx = 0, vy = 0, prevVx = 0, prevVy = 0, nextX = 0, nextY = 0;
  // fights: episodes in which each supercapacitor's gunner fires bursts
  let fightEnd = -1, nextFight = o.firstFight ?? pick(60, 2 * o.fightEvery);
  const caps = Array.from({ length: S.caps }, () => ({ kw: 0, firing: false, next: 0 }));
  let rail = 0, railEnd = 0, nextRail = Infinity;
  let bilge = 0, bilgeEnd = 0, nextLeak = pick(60, 400), extra = 0, extraEnd = 0, nextExtra = pick(60, 300);
  let sonarOn = r() < 0.5, nextSonar = pick(60, 250);
  let last = null, lastT = -99;
  for (let i = 0; i <= o.dur * 60; i++) {
    const t = i * dt, fighting = t < fightEnd;
    if (!fighting && t >= nextFight) { fightEnd = t + pick(o.fightLen[0], o.fightLen[1]); nextFight = fightEnd + o.fightEvery * pick(0.4, 1.6); if (S.railKW) nextRail = t + pick(5, 30); }
    // pilot: stop / part throttle / flat out, shorter holds while fighting; depth changes most of the time
    if (t >= nextX) {
      const q = r(), stopP = fighting ? 0.25 : o.stop;
      inX = (r() < 0.85 ? 1 : -1) * (q < stopP ? 0 : q < stopP + (1 - stopP) * o.partial ? pick(15, 80) : 100);
      nextX = t + (fighting ? pick(3, 15) : pick(20, 120));
    }
    if (t >= nextY) { const q = r(); inY = q < 0.35 ? 0 : (r() < 0.5 ? -1 : 1) * (q < 0.6 ? pick(5, 40) : q < 0.7 ? pick(40, 80) : pick(80, 100)); nextY = t + pick(5, 40); }
    const dx = inX - vx, dy = inY - vy, len = Math.hypot(dx, dy);
    if (len > 0) { const step = Math.min(STEER * dt, len); vx += dx / len * step; vy += dy / len * step; }
    const engines = Math.pow(Math.abs(prevVx) / 100, 1.5) * S.engineKW; // the engine acts on last tick's signal
    // pumps: ballast follows the depth signal; bilge pumps run during leaks (more likely in fights)
    if (t >= nextLeak) { bilge = S.bilgeKW * pick(0.3, 1); bilgeEnd = t + pick(20, 150); nextLeak = bilgeEnd + pick(60, fighting ? 200 : 600); }
    if (t >= bilgeEnd) bilge = 0;
    const pumps = Math.abs(prevVy) / 100 * S.ballastKW + bilge; prevVx = vx; prevVy = vy;
    // guns: each supercapacitor recharges at CAP_KW while its gunner fires (1 s ramp), then fades
    let guns = 0;
    for (const c of caps) {
      if (t >= c.next) { c.firing = fighting && !c.firing && r() < 0.6; c.next = t + (c.firing ? pick(3, 30) : pick(2, 20)); }
      c.kw = c.firing ? Math.min(CAP_KW, c.kw + CAP_KW * dt) : c.kw * Math.pow(CAP_FADE, dt);
      if (c.kw < 5 && !c.firing) c.kw = 0;
      guns += c.kw;
    }
    if (t >= nextRail && fighting) { rail = S.railKW * pick(0.7, 1); railEnd = t + pick(3, 6); nextRail = t + pick(15, 60); }
    if (t >= railEnd) rail = 0;
    guns += rail;
    // sonar: passive 10 kW always, active 100 kW for minutes at a time (more often in fights)
    if (t >= nextSonar) { sonarOn = r() < (fighting ? 0.8 : 0.5); nextSonar = t + pick(60, 250); }
    const sonar = sonarOn ? 100 : 10;
    // base: constant plus a fabricator/charging step now and then
    if (t >= nextExtra) { extra = pick(100, 250) * (r() < 0.8 ? 1 : -0.5); extraEnd = t + pick(30, 200); nextExtra = extraEnd + pick(120, 600); }
    if (t >= extraEnd) extra = 0;
    const demand = S.base + extra + engines + pumps + guns + sonar;
    const row = [demand, vx, vy, engines, pumps, guns, sonar];
    const changed = !last || row.some((v, k) => Math.abs(v - last[k]) >= (k === 1 || k === 2 ? 0.5 : 2));
    if (changed || t - lastT >= 5) { L.push(t.toFixed(3) + ',' + row.map((v, k) => (k === 1 || k === 2) ? v.toFixed(4) : v.toFixed(1)).join(',')); last = row; lastT = t; }
  }
  fs.writeFileSync(path.join(out, name + '.csv'), L.join('\n') + '\n');
}
fs.mkdirSync(out, { recursive: true });
// cruise: Dugong travelling between outposts, no fights
ship('synthetic_cruise', SHIPS.dugong, { seed: 11, dur: 1200, stop: 0.4, partial: 0.6, fightEvery: 1e9, fightLen: [0, 0], note: 'Dugong travelling, no combat' });
// combat: Typhon2 in a busy mission: fights every few minutes with seven capacitors and a railgun; demand goes above the reactor's max
ship('synthetic_combat', SHIPS.typhon, { seed: 12, dur: 1200, stop: 0.5, partial: 0.6, fightEvery: 240, fightLen: [40, 150], firstFight: 60, note: 'Typhon2, frequent fights' });
// ramps: Humpback mixing sprints and stops, with a couple of fights
ship('synthetic_ramps', SHIPS.humpback, { seed: 13, dur: 1200, stop: 0.45, partial: 0.5, fightEvery: 400, fightLen: [60, 240], note: 'Humpback sprints, stops and fights' });
// long haul: long quiet drifts (batteries fill up if nothing stops them) and fights above the reactor's max output
//            (only stored battery energy can cover those) -> tests battery state-of-charge management
ship('synthetic_longhaul', SHIPS.dugong, { seed: 14, dur: 2400, stop: 0.65, partial: 0.5, fightEvery: 500, fightLen: [60, 200], note: 'Dugong long trip with quiet drifts and fights (battery test)' });
console.log('wrote synthetic profiles to ' + out);
