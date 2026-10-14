// Sanity tests: node sim/test.js
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const C = require('./components'), F = require('./format'), E = require('./engine'), P = require('./project');
const ROOT = path.resolve(__dirname, '..');
// number formatting like .NET float.ToString("G")
for (const [v, s] of [[0.1, '0.1'], [1 / 3, '0.33333334'], [1e9, '1E+09'], [0.00001, '1E-05'], [-0, '-0'], [999999, '999999']]) assert.strictEqual(C.fmtF(v), s);
// every community circuit parses and round-trips through export
for (const f of fs.readdirSync(path.join(ROOT, 'context/community_circuits'))) {
  const m = P.loadModel(fs.readFileSync(path.join(ROOT, 'context/community_circuits', f), 'utf8'), f);
  const back = F.parseTxt(F.toTxt(m.boxes[0]));
  assert.strictEqual(back.components.length, m.boxes[0].components.length, f);
  assert.strictEqual(back.wires.length, m.boxes[0].wires.length, f);
}
// determinism + export round trip give identical results
const prof = E.parseProfile(fs.readFileSync(path.join(ROOT, 'load_profiles/synthetic_cruise.csv'), 'utf8'), 'cruise'); prof.duration = 120;
const circ = F.parseCirc(fs.readFileSync(path.join(ROOT, 'circuits/example_feedforward.circ'), 'utf8'));
const run = m => new E.Sim(P.substitute(m, 3000), { profile: prof, reactorMaxKW: 3000 }).runToEnd();
const a = run(circ), b = run(circ);
const re = P.loadModel(P.exportBoxes(circ, 3000)[0].text, 'example_feedforward.txt');
const c = run(re);
assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
assert.strictEqual(a.unmet_kwh, c.unmet_kwh); assert.strictEqual(a.fuel_condition_used, c.fuel_condition_used);
// chunked stepping (what the web page does at x1..x25) == straight run
const s1 = new E.Sim(P.substitute(circ, 3000), { profile: prof, reactorMaxKW: 3000 });
while (!s1.done) for (let i = 0; i < 7 && !s1.done; i++) s1.step();
assert.strictEqual(JSON.stringify(s1.metrics.report()), JSON.stringify(a));
console.log('all tests passed');
