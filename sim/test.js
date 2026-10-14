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
// verify: a trace recorded from the simulator itself must replay with ~zero error
{
  const V = require('./verify');
  const p2 = E.parseProfile(fs.readFileSync(path.join(ROOT, 'load_profiles/synthetic_combat.csv'), 'utf8'), 'c'); p2.duration = 90;
  const s = new E.Sim({ name: 'x', boxes: [], links: [] }, { profile: p2, rods: 4, start: 'cold', vanilla: true, wear: false });
  const cols = ['t', 'temp', 'fission', 'turbine', 'target_fission', 'target_turbine', 'correct_turbine', 'load', 'output', 'max_kw', 'avail_fuel', 'rods', 'rod_cond', 'autotemp', 'power_on', 'condition', 'meltdown_timer', 'fire_timer', 'dos', 'event'];
  const L = ['# ReactorTrace v1', cols.join(',')];
  for (let i = 0; !s.done; i++) {
    const R = s.reactor;
    if (i % 6 === 0) L.push([s.time, R.temp, R.fission, R.turbine, R.tf, R.tt, R.cto, R.load, -R.cpc, R.maxPower, R.availFuel, R.rods.length, R.rods.map(r => 'fuelrod:' + r.cond).join(' '), 1, 1, R.cond, R.melt, R.fire, R.dos, ''].join(','));
    s.step();
  }
  const out = V.verify(L.join('\n'));
  const tempRms = Number(/\ntemp\t([\d.]+)/.exec(out)[1]);
  assert(tempRms < 0.5, 'verify replay error too high:\n' + out);
}
console.log('verify self-check passed');
// real game data: replaying the recorded Dugong round (AutoTemp, 1 -> 4 uranium rods at 37 s) must stay close to the game
{
  const V = require('./verify');
  const out = V.verify(fs.readFileSync(path.join(ROOT, 'load_profiles/Dugong_round001.csv'), 'utf8'));
  const g = k => Number(new RegExp('\\n' + k + '\\t([\\d.]+)\\t([\\d.]+)').exec(out)[1]);
  assert(g('temp') < 2 && g('fission') < 1.5 && g('turbine') < 1.5, 'simulator drifted from the real Dugong round:\n' + out);
  assert(/FIRE started/.test(out), 'the real round caught fire after the rods went in; the simulator should too:\n' + out);
}
console.log('real-game check (Dugong round) passed');
