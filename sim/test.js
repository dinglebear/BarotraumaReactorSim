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
  const out = V.verify(fs.readFileSync(path.join(ROOT, 'load_profiles/Dugong_round001.csv'), 'utf8'), { mode: 'autotemp' }); // that round ran on AutoTemp
  const g = k => Number(new RegExp('\\n' + k + '\\t([\\d.]+)\\t([\\d.]+)').exec(out)[1]);
  assert(g('temp') < 2 && g('fission') < 1.5 && g('turbine') < 1.5, 'simulator drifted from the real Dugong round:\n' + out);
  assert(/FIRE started/.test(out), 'the real round caught fire after the rods went in; the simulator should too:\n' + out);
}
// physics check on every recorded round: the simulator's heat/temperature/output must follow the game
for (const [name, maxRms] of [['Dugong_round001', 0.5], ['Humpback_round001', 1.5], ['Typhon2_round001', 1.0]]) {
  const V = require('./verify'), f = path.join(ROOT, 'load_profiles', name + '.csv');
  if (!fs.existsSync(f)) continue;
  const out = V.verify(fs.readFileSync(f, 'utf8'), { mode: 'physics' });
  const rms = Number(/\ntemp\t([\d.]+)/.exec(out)[1]);
  assert(rms < maxRms, `${name}: temperature drifted from the game (rms ${rms}):\n` + out);
}
console.log('real-game checks passed');
// pin finder: strip Rimuru's harness (its lever pin has no label) and it must find a working one by trial and error
{
  const A = require('./autopins'), P = require('./project'), E = require('./engine'), f = path.join(ROOT, 'context/reactor_circuits/rimuru_autoreactor.txt');
  const m = P.loadModel(fs.readFileSync(f, 'utf8'), 'rimuru_autoreactor.txt'); for (const b of m.boxes) b.pins = null;
  const res = A.solve(m, { reactorMaxKW: 3000 }, { guess: E.guessPins });
  assert(!res.initialWorks && res.works, 'autopins did not repair Rimuru:\n' + res.log.join('\n'));
  assert(/^const\./.test(res.pins.reactor.in9) && res.pins.reactor.out0 === 'reactor.set_turbineoutput' && res.pins.reactor.out1 === 'reactor.set_fissionrate', 'autopins found odd pins: ' + JSON.stringify(res.pins));
  console.log('autopins check passed');
}
// Blueprints mod compatibility (github.com/Max112358/Barotrauma-Blueprints, load_blueprint.lua parseXML + builder):
// components are added in file order and wires find them by id, so ids must be 0..n-1; every component needs item=,
// Class= and a position; attribute names are letters/digits only; wire ends must point at real components; pin labels
// are matched by value="..." (non-empty, no quotes); a component's attributes must not contain "/>" (ends the match).
{
  const F = require('./format'), P = require('./project');
  const files = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'circuits')).filter(f => f.endsWith('.circ'))) {
    const m = F.parseCirc(fs.readFileSync(path.join(ROOT, 'circuits', f), 'utf8'));
    for (const o of P.exportBoxes(m, { MAX: 3000, BATT_N: 2, BATT_KW: 1000, BATT_OUT: 2000, BATT_CAP: 4000 })) files.push(o);
  }
  // a hand-placed circuit from the web editor (positions kept)
  files.push(...P.exportBoxes(F.parseCirc('name ed\nbox reactor\nc mem1 mem Value=30 @-150,423\nc div1 div @-150,183\nw in1 div1.1\nw mem1.out div1.2\nw div1.out out2\n'), { MAX: 3000 }));
  for (const { filename, text } of files) {
    const comps = [...text.matchAll(/<Component[\s\S]*?\/>/g)].map(x => x[0]);
    assert(comps.length > 0, filename + ': no components');
    comps.forEach((c, i) => {
      assert(new RegExp(`\\bid="${i}"`).test(c), `${filename}: component #${i} must have id="${i}"`);
      assert(/position="-?[\d.]+,-?[\d.]+"/.test(c), `${filename}: component ${i} has no position`);
      assert(/item=<<<STRINGSTART>>>[a-z]+<<<STRINGEND>>>/.test(c) && /Class=<<<STRINGSTART>>>[A-Za-z]+<<<STRINGEND>>>/.test(c), `${filename}: component ${i} needs item= and Class=`);
      for (const [, k] of c.matchAll(/([\w-]+)=<<<STRINGSTART>>>/g)) assert(/^[A-Za-z0-9]+$/.test(k), `${filename}: attribute "${k}" (letters/digits only)`);
    });
    for (const w of text.matchAll(/<Wire[\s\S]*?<\/Wire>/g)) {
      for (const [, side, t] of w[0].matchAll(/<(From|To) name="[^"]+" target="([^"]*)"/g)) assert(t === '' || (Number(t) >= 0 && Number(t) < comps.length), `${filename}: wire ${side} target ${t} is not a component`);
      assert(/prefab="[a-z]+"/.test(w[0]), `${filename}: wire without prefab`);
    }
    for (const l of text.matchAll(/<ConnectionLabelOverride name="([^"]+)" value="([^"]*)"/g)) assert(l[2].length > 0, `${filename}: empty label on ${l[1]}`);
    assert(/<InputNode pos="-?[\d.]+,-?[\d.]+"/.test(text) && /<OutputNode pos="-?[\d.]+,-?[\d.]+"/.test(text), filename + ': input/output node positions');
  }
  console.log(`blueprints compatibility passed (${files.length} files)`);
}

// sub editor: an unedited .sub serializes back unchanged; a patch adds/wires/removes items and passes the loader checks
{
  const zlib = require('zlib'), X = require('./subxml'), SE = require('./subedit'), SF = require('./subfile');
  const readSub = f => { const b = fs.readFileSync(path.join(ROOT, 'ships/vanilla', f + '.sub')); return (b[0] === 0x1f ? zlib.gunzipSync(b) : b).toString('utf8'); };
  const dug = readSub('Dugong'), norm = s => s.replace(/\r/g, '').trim();
  assert(norm(X.serialize(X.parse(dug))) === norm(dug), 'subxml round trip changed the Dugong');
  const doc = new SE.SubDoc(dug, [new SE.SubDoc(readSub('Humpback'))]);
  doc.apply('subname Test\nadd @b button at -760,40\nadd @r relaycomponent at -730,40 RelayComponent.IsOn=false\nwire @b.signal_out @r.toggle\nremove 393\n', {});
  assert(doc.check().length === 0, 'sub patch loader checks: ' + doc.check().join('; '));
  const sh = SF.parseSub(doc.text());
  assert(!sh.items.some(i => i.id === 393), 'removed item still there');
  const b = sh.items.find(i => i.identifier === 'button' && sh.wires.some(w => (w.from.item === i.id && w.from.conn === 'signal_out') || (w.to.item === i.id && w.to.conn === 'signal_out')));
  assert(b, 'new button is not wired');
  console.log('sub editor passed');
}

// Camel Overkill (ships/custom): every Camel circuit parses; the patched sub passes the loader checks; in a practice
// round the power manager keeps the main bus clean, CamelOS answers on the terminal and on radio chat, lockdown seals
// the doors and a flood is announced.
{
  const zlib = require('zlib'), SF = require('./subfile'), SH = require('./ship'), F = require('./format'), SE = require('./subedit');
  for (const f of fs.readdirSync(path.join(ROOT, 'circuits/camel'))) F.parseCirc(fs.readFileSync(path.join(ROOT, 'circuits/camel', f), 'utf8'));
  const text = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ships/custom/Camel_Overkill.sub'))).toString('utf8');
  assert(new SE.SubDoc(text).check().length === 0, 'Camel Overkill loader checks');
  const ship = SF.parseSub(text);
  const sim = new SH.ShipSim(ship, { duration: 240, scenario: { breachAt: 150, breachHull: '133', type: [{ t: 30, text: 'status' }, { t: 60, text: 'lockdown' }, { t: 90, text: 'unlock' }], radio: [{ t: 40, text: 'camel whoami' }] } });
  const doors = [870, 1097, 1103, 1109, 1115, 816, 851, 905, 914].map(i => sim.byId.get(String(i)));
  let lockedOpen = 0;
  while (!sim.done) { sim.step(); if (sim.time > 61 && sim.time < 89) lockedOpen += doors.filter(d => d.state.open).length; }
  const r = sim.metrics.report ? sim.metrics.report() : null;
  assert(!sim.reactor.autoTemp, 'Camel Overkill: its own circuit runs the reactor');
  assert(sim.termLog.some(l => l.dir === '<' && /^PWR \d+kW LOAD/.test(l.text)), 'CamelOS status answer');
  assert(sim.chat.some(c => /You are cargo/.test(c.text)), 'CamelOS radio answer');
  assert(sim.chat.some(c => /ALERT RED \| flood: Medbay/.test(c.text)), 'flood announcement');
  assert(lockedOpen === 0, 'lockdown keeps every door shut');
  assert(sim.o2Min > 80, 'oxygen stays above 80 %');
  // nothing new sits inside a floor or wall (turrets and their periscope/loader excepted: they replace vanilla parts)
  const doc = new SE.SubDoc(text), vanillaIds = new Set(new SE.SubDoc(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ships/vanilla/Camel.sub'))).toString('utf8')).items.keys());
  const inBoxes = new Set(); for (const n of doc.items.values()) if (n.children.some(c => c.tag === 'CircuitBox')) for (const c of n.children) if (c.tag === 'ItemContainer') for (const id of (c.attrs.find(a => a[0] === 'contained') || [0, ''])[1].split(/[,;]/)) inBoxes.add(id);
  const stuck = [...doc.items.values()].filter(n => !vanillaIds.has(n.attrs.find(a => a[0] === 'ID')[1]) && !inBoxes.has(n.attrs.find(a => a[0] === 'ID')[1]) && !n.children.some(c => c.tag === 'Wire')).filter(n => !/gun|periscope|loader/.test(n.attrs.find(a => a[0] === 'identifier')[1]) && doc.freeSpot(n) !== null);
  assert(stuck.length === 0, 'items inside floors or walls: ' + stuck.map(n => n.attrs.find(a => a[0] === 'identifier')[1]).join(', '));
  console.log('camel overkill passed');
}
