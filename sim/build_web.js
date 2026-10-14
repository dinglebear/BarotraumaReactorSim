// Builds web/index.html (single self-contained page) from web/app.html + sim/*.js + circuits + load profiles.
// node sim/build_web.js
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sim = ['sim/components.js', 'sim/format.js', 'sim/engine.js', 'sim/project.js'].map(read).join('\n;\n');
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
  const pf = f.replace(/(_reactor)?\.txt$/, '.pins'); if (list('context/reactor_circuits').includes(pf)) lib.circuits[f.replace(/(_reactor)?\.txt$/, '')].pins = read('context/reactor_circuits/' + pf);
}
for (const f of list('load_profiles')) if (f.endsWith('.csv')) lib.profiles[f.replace(/\.csv$/, '')] = read('load_profiles/' + f);
const json = JSON.stringify(lib).replace(/</g, '\\u003c');
const html = read('web/app.html').replace('/*__SIM__*/', () => sim.replace(/<\/script/gi, '<\\/script')).replace('/*__LIB__*/', () => json);
fs.writeFileSync(path.join(ROOT, 'web/index.html'), html);
console.log(`web/index.html: ${(html.length / 1024).toFixed(0)} KB, ${Object.keys(lib.circuits).length} circuits, ${Object.keys(lib.profiles).length} profiles`);
