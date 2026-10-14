// Generates synthetic demand profiles (until real recordings from the PowerLogger mod exist).
// node sim/make_profiles.js
'use strict';
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'load_profiles');
function rng(seed) { let a = seed; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }
function write(name, maxKW, sub, dur, fn, fuel) {
  const L = [`# BaroPowerLog v1 (synthetic)`, `# sub=${sub}`, `# reactor_max_kw=${maxKW}`, `# duration=${dur}`, '# fuel_rods=2', `# fuel_type=${fuel || 'uranium'}`, 't,demand'];
  let prev = null;
  for (let t = 0; t <= dur; t += 0.5) { const d = Math.max(0, Math.round(fn(t) * 10) / 10); if (d !== prev) { L.push(`${t},${d}`); prev = d; } }
  fs.writeFileSync(path.join(out, name + '.csv'), L.join('\n') + '\n');
}
fs.mkdirSync(out, { recursive: true });
// 1) cruise: steady base + engine throttle changes every ~30-90 s
{ const r = rng(1); let next = 0, eng = 0; write('synthetic_cruise', 3000, 'synthetic', 900, t => { if (t >= next) { eng = [0, 400, 800, 1200, 600][Math.floor(r() * 5)]; next = t + 30 + r() * 60; } return 1100 + eng; }); }
// 2) combat: fast swings (engine full/stop, pumps, railguns charging bursts)
{ const r = rng(2); let next = 0, eng = 0, pump = 0, nb = 0, burst = 0; write('synthetic_combat', 5200, 'synthetic', 900, t => { if (t >= next) { eng = r() < 0.5 ? 0 : 1600; pump = r() < 0.4 ? 600 : 0; next = t + 5 + r() * 20; } if (t >= nb) { burst = r() < 0.3 ? 900 : 0; nb = t + 2 + r() * 6; } return 1500 + eng + pump + burst; }); }
// 3) ramp + spikes: slow ramps and single big spikes, tests overshoot
write('synthetic_ramps', 4000, 'synthetic', 900, t => { const base = 1200 + 1400 * (0.5 - 0.5 * Math.cos(t / 900 * 2 * Math.PI * 2)); const spike = (t % 120) > 100 ? 1200 : 0; return base + spike; });
// 4) long haul: long quiet stretches (batteries fill up if nothing stops them) and bursts ABOVE the reactor's
//    max output (only stored battery energy can cover those) -> tests battery state-of-charge management
{ const r = rng(4); let next = 0, mode = 'quiet', lvl = 900; write('synthetic_longhaul', 3000, 'synthetic', 2400, t => {
  if (t >= next) {
    const roll = r();
    if (mode !== 'quiet' && roll < 0.5) { mode = 'quiet'; lvl = 700 + r() * 500; next = t + 120 + r() * 240; }
    else if (roll < 0.3) { mode = 'burst'; lvl = 3300 + r() * 900; next = t + 30 + r() * 60; }
    else { mode = 'work'; lvl = 1500 + r() * 1200; next = t + 40 + r() * 120; }
  }
  return lvl + (mode === 'work' ? 150 * Math.sin(t / 7) : 0);
}, 'thorium'); }
console.log('wrote synthetic profiles to load_profiles/');
