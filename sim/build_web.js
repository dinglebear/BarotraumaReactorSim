// Builds web/index.html (single self-contained page) from web/app.html + sim/*.js + circuits + load profiles.
// node sim/build_web.js
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sim = ['sim/components.js', 'sim/format.js', 'sim/engine.js', 'sim/project.js', 'sim/autopins.js'].map(read).join('\n;\n');
const lib = { circuits: {}, profiles: {} };
const list = d => fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).sort() : [];
for (const f of list('circuits')) {
  if (f.endsWith('.circ')) lib.circuits[f.replace(/\.circ$/, '')] = { circ: read('circuits/' + f), group: 'AI' };
}
// community / imported reactor circuits in Blueprints format (pairs: name_reactor.txt + name_battery.txt)
for (const f of list('context/reactor_circuits')) {
  if (!f.endsWith('.txt') || f.endsWith('_battery.txt')) continue;
  const bf = f.replace(/_reactor\.txt$/, '_battery.txt');
  lib.circuits[f.replace(/(_reactor)?\.txt$/, '')] = { main: read('context/reactor_circuits/' + f), mainName: f, battery: bf !== f && list('context/reactor_circuits').includes(bf) ? read('context/reactor_circuits/' + bf) : null, group: 'Community' };
  const pf = [f.replace(/\.txt$/, '.pins'), f.replace(/(_reactor)?\.txt$/, '.pins')].find(p => list('context/reactor_circuits').includes(p)); if (pf) lib.circuits[f.replace(/(_reactor)?\.txt$/, '')].pins = read('context/reactor_circuits/' + pf);
}
// Real round logs can be huge (a 64-minute round is ~18 MB). For the page, keep only rows where something the simulator
// replays changed (demand >= 5 kW, a pin >= 1, rods/fuel), at least every 5 s, and bake in the rod fuel worked out from the full log.
const E = require('./engine');
function thin(text, name) {
  if (text.length < 1.5e6) return text;
  const prof = E.parseProfile(text, name);
  const ch = prof.channels, head = text.split(/\r?\n/).filter(l => l.startsWith('#') && !/duration/.test(l));
  const L = [...head, `# duration=${prof.duration}`, ['t', 'demand', 'rods', 'avail_fuel', 'fuel', ...ch].join(',')];
  let last = null;
  for (const p of prof.points) {
    const row = [p.demand, p.rods ?? '', p.rodFuel && p.rods !== undefined ? p.rodFuel * p.rods : '', p.g.fuelPct ?? '', ...ch.map(c => p.ch[c] ?? '')];
    const keep = !last || p.t - last.t >= 5 || Math.abs(row[0] - last.row[0]) >= 10 || row[1] !== last.row[1] || row[2] !== last.row[2] || Math.abs((row[3] || 0) - (last.row[3] || 0)) >= 1
      || row.slice(4).some((v, i) => Math.abs((v || 0) - (last.row[i + 4] || 0)) >= 2);
    if (!keep) continue;
    L.push([p.t.toFixed(2), ...row.map(v => typeof v === 'number' ? (Math.round(v * 10) / 10) : v)].join(','));
    last = { t: p.t, row };
  }
  return L.join('\n') + '\n';
}
for (const f of list('load_profiles')) if (f.endsWith('.csv')) lib.profiles[f.replace(/\.csv$/, '')] = thin(read('load_profiles/' + f), f);
const json = JSON.stringify(lib).replace(/</g, '\\u003c');
const html = read('web/app.html').replace('/*__SIM__*/', () => sim.replace(/<\/script/gi, '<\\/script')).replace('/*__LIB__*/', () => json);
fs.writeFileSync(path.join(ROOT, 'web/index.html'), html);
console.log(`web/index.html: ${(html.length / 1024).toFixed(0)} KB, ${Object.keys(lib.circuits).length} circuits, ${Object.keys(lib.profiles).length} profiles`);
