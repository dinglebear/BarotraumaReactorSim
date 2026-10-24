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
  const sim = new SH.ShipSim(ship, { duration: 240, scenario: { breachAt: 150, breachHull: '133', type: [{ t: 30, text: 'status' }, { t: 60, text: 'lockdown' }, { t: 90, text: 'unlock' }, { t: 100, text: 'set battery 70' }, { t: 105, text: 'joke' }], radio: [{ t: 40, text: 'camel whoami' }] } });
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
  assert(sim.termLog.some(l => l.dir === '<' && /^Saved/.test(l.text)), 'CamelOS settings answer');
  assert(sim.termLog.filter(l => l.dir === '<' && l.t > 104 && l.t < 106).length === 1, 'CamelOS fun pack answers once');
  // every text display can be read to the end: changing values fit, the ticker restarts each message from the beginning
  const unreadable = sim.displayIssues(); assert(unreadable.length === 0, 'unreadable displays: ' + unreadable.map(x => x.id + ' ' + x.reason).join('; '));
  const dispTexts = sim.devs.filter(d => d.kind === 'display').map(d => d.state.text);
  assert(dispTexts.some(t => /^\d+ kW$/.test(t)) && dispTexts.some(t => /^\d\d:\d\d:\d\d$/.test(t)), 'screen wall values: ' + dispTexts.join(' | '));
  // nothing new sits inside a floor or wall (turrets and their periscope/loader excepted: they replace vanilla parts)
  const doc = new SE.SubDoc(text), vanillaIds = new Set(new SE.SubDoc(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ships/vanilla/Camel.sub'))).toString('utf8')).items.keys());
  const inBoxes = new Set(); for (const n of doc.items.values()) if (n.children.some(c => c.tag === 'CircuitBox')) for (const c of n.children) if (c.tag === 'ItemContainer') for (const id of (c.attrs.find(a => a[0] === 'contained') || [0, ''])[1].split(/[,;]/)) inBoxes.add(id);
  const stuck = [...doc.items.values()].filter(n => !vanillaIds.has(n.attrs.find(a => a[0] === 'ID')[1]) && !inBoxes.has(n.attrs.find(a => a[0] === 'ID')[1]) && !n.children.some(c => c.tag === 'Wire')).filter(n => !/gun|periscope|loader/.test(n.attrs.find(a => a[0] === 'identifier')[1]) && doc.freeSpot(n, 16) !== null);
  assert(stuck.length === 0, 'items inside floors or walls: ' + stuck.map(n => n.attrs.find(a => a[0] === 'identifier')[1]).join(', '));
  const au = doc.audit(new SE.SubDoc(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ships/vanilla/Camel.sub'))).toString('utf8'))).filter(x => x.level !== 'info');
  assert(au.length === 0, 'Camel Overkill audit: ' + au.map(x => x.msg).join('; '));
  console.log('camel overkill passed');
}

// a sub built from scratch (sim/subbuild.js): loader checks, audit, and it runs: the reactor circuit holds the load
{
  const { execFileSync } = require('child_process');
  execFileSync('node', [path.join(ROOT, 'ships/scratch/capsule.gen.js')]);
  const zlib = require('zlib'), SE = require('./subedit'), SF = require('./subfile'), SH = require('./ship');
  const text = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ships/custom/Claudes_Test_Capsule.sub'))).toString('utf8');
  const doc = new SE.SubDoc(text);
  assert(doc.check().length === 0, 'capsule loader checks: ' + doc.check().join('; '));
  assert(doc.audit(null).filter(x => x.level !== 'info').length === 0, 'capsule audit');
  const ship = SF.parseSub(text);
  assert(ship.hulls.length === 6 && ship.gaps.length === 4 && ship.waypoints.length > 30, 'capsule rooms, gaps, waypoints');
  const sim = new SH.ShipSim(ship, { duration: 120, scenario: { fights: false } }); const r = sim.runToEnd();
  assert(r.unmet_pct < 2, 'capsule power: unmet ' + r.unmet_pct);
  console.log('scratch build passed');
}

// circuit sandbox (sim/sandbox.js): every demo in sandbox/ passes, and the border/size limits are errors
{
  const S = require('./sandbox');
  const demos = [...fs.readdirSync(path.join(ROOT, 'sandbox')).filter(f => f.endsWith('.sbx')), ...fs.readdirSync(path.join(ROOT, 'sandbox/world')).filter(f => f.endsWith('.sbx')).map(f => 'world/' + f)];
  for (const f of demos) {
    const { sb, report } = S.run(fs.readFileSync(path.join(ROOT, 'sandbox', f), 'utf8'), { readFile: q => fs.readFileSync(path.join(ROOT, q), 'utf8') });
    assert(sb.unexpectedErrors.length === 0 && sb.results.every(r => r.ok), `sandbox ${f}:\n${report}`);
  }
  const big = ['box big', ...Array.from({ length: 70 }, (_, i) => `c n${i} not`), 'w in1 n0.in', ...Array.from({ length: 69 }, (_, i) => `w n${i}.out n${i + 1}.in`), 'w n69.out out1', 'run 1'].join('\n');
  const r = S.run(big).sb;
  assert(r.errors.some(e => /70 components/.test(e)), 'sandbox: a 70-part box is an error');
  console.log('sandbox passed');
}

// component details checked against the game's C# (float timers, delay ticks, HSV, optional regex groups, mux in a box)
{
  const mk = (alias, props) => { const d = C.byAlias(alias), outs = []; const c = { p: Object.assign({}, d.defaults, props), send: (p, v) => outs.push([p, v]), fwd: (s, p, v) => outs.push([p, v]), isWired: () => true }; d.make(c); return { c, outs }; };
  // TimeFrame 0.05 on an OR: the game's float timer keeps it true for 3 frames after the signal (4 with double maths)
  { const { c, outs } = mk('or', { TimeFrame: '0.05', FalseOutput: '' }); c.recv('signal_in1', { v: '1' }); for (let i = 0; i < 10; i++) c.update(1 / 60); assert.strictEqual(outs.length, 3, 'or TimeFrame 0.05 -> 3 frames, got ' + outs.length); }
  // delay 1 s = (int)(1f / (1/60.0)) = 60 ticks
  { const { c } = mk('delay', { Delay: '1' }); assert.strictEqual(c.ticks, 60, 'delay ticks ' + c.ticks); }
  // HSV 0,1,0.5 -> R 127 (Color truncates)
  { const { c, outs } = mk('color', { UseHSV: 'true' }); c.recv('signal_g', { v: '1' }); c.recv('signal_b', { v: '0.5' }); c.update(1 / 60); assert.strictEqual(outs.pop()[1], '127,0,0,0'); }
  // an optional group that didn't take part: "" (not FalseOutput), sent only with OutputEmptyCaptureGroup
  { const { c, outs } = mk('regex', { Expression: 'a(b)?', UseCaptureGroup: 'true', Output: '1', FalseOutput: 'F' }); c.recv('signal_in', { v: 'a' }); c.update(1 / 60); assert.strictEqual(outs.length, 0, 'regex empty group sends nothing'); }
  // atan starts from 0,0 like the game's float arrays: "0" for the first 0.1 s
  { const { c, outs } = mk('atan', {}); c.update(1 / 60); assert.deepStrictEqual(outs[0], ['signal_out', '0']); }
  console.log('component details passed');
}

// structure geometry and hull smoothing (sim/shellgeom.js, sim/subbuild.js)
{
  const zlib = require('zlib'), SF = require('./subfile'), G = require('./shellgeom'), SE = require('./subedit'), { SubBuilder } = require('./subbuild');
  const rd = f => { const b = fs.readFileSync(path.join(ROOT, f)); return (b[0] === 0x1f ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''); };
  // the game's body maths: every vanilla sub is watertight, and taking away the Camel's hump slopes makes it leak
  for (const n of ['Camel', 'Dugong', 'Humpback', 'Typhon2']) assert.strictEqual(G.leaks(SF.parseSub(rd(`ships/vanilla/${n}.sub`))).length, 0, n + ' watertight');
  const camel = SF.parseSub(rd('ships/vanilla/Camel.sub'));
  assert(G.leaks(Object.assign({}, camel, { structures: camel.structures.filter(s => s.identifier !== 'shella52deg') })).length > 0, 'leak check notices missing slopes');
  // a hump slope goes "/" on the left side (prefab rotation -52, the body is set to -BodyRotation)
  const b = G.body({ identifier: 'shella52deg', rect: [-1113, 759, 285, 338] }); assert(b.seg[1][0] > b.seg[0][0] && b.seg[1][1] > b.seg[0][1], 'left hump slope rises to the right');
  // builder: a stepped layout gets slopes in its steps, flips like vanilla, and stays watertight
  const T = ['ships/vanilla/Dugong.sub', 'ships/vanilla/Camel.sub', 'ships/templates/vanilla_items.xml'].map(f => new SE.SubDoc(rd(f)));
  const B = new SubBuilder(T, { name: 'steps' }, {});
  B.room('a', -768, 0, 512, 256).room('b', -256, 0, 512, 256).room('c', 256, 0, 512, 256).room('u', -256, 256, 512, 256).room('o', -896, 256, 640, 256);
  const d = B.build(), sh = SF.parseSub(d.text ? d.text() : d.toString());
  assert.strictEqual(G.leaks(sh).length, 0, 'stepped build watertight');
  assert(B.slopes.length >= 3, 'slopes placed: ' + B.slopes.length);
  const flat = sh.structures.filter(s => s.identifier === 'shella0deg'), vert = sh.structures.filter(s => s.identifier === 'shella90deg');
  assert(flat.some(s => s.flippedy) && vert.some(s => s.flippedx), 'bottom shells FY, right shells FX');
  // the capsule: stepped top deck, smoothed, watertight
  const cap = SF.parseSub(rd('ships/custom/Claudes_Test_Capsule.sub'));
  assert.strictEqual(G.leaks(cap).length, 0, 'capsule watertight');
  assert(cap.structures.filter(s => G.solid(s) && G.body(s).angle % (Math.PI / 2) !== 0).length >= 4, 'capsule has slopes');
  console.log('hull smoothing passed');
}

// what a player sees on a text display (sim/label.js, reference/TEXT_DISPLAYS.md) and stairs as the game builds them
{
  const L = require('./label'), G = require('./shellgeom'), SF = require('./subfile'), zlib = require('zlib');
  const every = (n, dt, f) => Array.from({ length: n }, (_, i) => ({ t: i * dt, text: f(i) }));
  assert(L.fits('1000 kW') && !L.fits('Reactor output: 1000 kW'), 'about 7 characters fit');
  assert(!L.check(every(60, 1, i => 'Reactor output: ' + (1000 + i) + ' kW'), 60).ok, 'long text changing every second never shows its end');
  assert(L.check(every(60, 1, i => (1000 + i) + ' kW'), 60).ok, 'a short changing value is fine');
  assert(L.check([{ t: 0, text: 'Reactor output: 1000 kW' }], 60).ok, 'a long text that holds still scrolls fine');
  // the snap-back: after a change the scroll keeps its place (clamped to the new text), so a new message starts midway...
  const m = new L.Marquee(); m.set('Chief Engineer Dingle: certified JESTER. Not a clown.'); for (let i = 0; i < 600; i++) m.tick(1 / 60);
  m.set('Forecast: wet, dark, with a chance of mudraptors.'); assert(m.idx > 0, 'scroll position kept across a change');
  // ...unless a text that fits comes in between: that resets it (the Camel's ticker sends a space for 0.5 s)
  m.set(' '); m.set('Forecast: wet, dark, with a chance of mudraptors.'); assert.strictEqual(m.idx, 0, 'a short text resets the scroll');
  // stairs: one 10 px plank at 45 degrees in the square at the bottom of the rect; a flip swaps the direction
  const st = G.body({ identifier: 'stairsleft3', rect: [-1425, 121, 254, 343], flippedx: true });
  assert.deepStrictEqual(st.seg.map(p => p.map(Math.round)), [[-1425, -222], [-1171, 32]], 'flipped left stairs rise to the right');
  assert.strictEqual(G.body({ identifier: 'stairsleft3', rect: [-921, -134, 254, 343] }).stairs, 'Left');
  // the renderer draws them, and the wire router keeps its bundles under the real ceiling slab
  const R = require('./subrender'), camel = SF.parseSub(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ships/vanilla/Camel.sub'))).toString('utf8'));
  const svg = R.render(camel, { width: 800 }).svg; assert((svg.match(/data-k="struct"/g) || []).length > 50 && /<polygon/.test(svg) && (svg.match(/data-k="item"/g) || []).length > 100, 'sub render has structures and items');
  const SE = require('./subedit'), doc = new SE.SubDoc(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'ships/vanilla/Camel.sub'))).toString('utf8'));
  const reactorRoom = doc.hulls().find(H => H.x0 === -1648 && H.y1 === 40); assert.strictEqual(doc.ceiling(reactorRoom), -8, 'reactor room ceiling slab is 48 thick');
  const path1 = doc.route([-1500, -150], [-700, -150]); assert(path1.every(p => p[1] <= -16 && p[1] >= -216), 'route stays inside the room, under the slab');
  console.log('displays and stairs passed');
}

// the world (sim/world.js): vehicle physics against SubmarineBody.cs / Engine.cs / Pump.cs, sensors, turrets
{
  const S = require('./sandbox'), W = require('./world');
  const run = (body, t) => { const sb = new S.Sandbox(S.parse(body + `\nrun ${t}`)); assert.deepStrictEqual(sb.errors, []); while (!sb.done) sb.step(); return sb; };
  // an empty tank: b = 2 x 0.07 -> 1.4 m/s² up; terminal 5.3 m/s up (drag 0.05 v²)
  let sb = run('vehicle d At=0,0 Size=300,150 Mass=1000 Volume=45000 Water=0', 1);
  assert(Math.abs(sb.world.vehicles.get('d').vy / 100 - 1.4) < 0.08, 'empty tank rises at 1.4 m/s²');
  sb = run('vehicle d At=0,0 Size=300,150 Mass=1000 Volume=45000 Water=0', 40); assert(Math.abs(sb.world.vehicles.get('d').vy / 100 - Math.sqrt(1.4 / 0.05)) < 0.05, 'terminal rise speed');
  // 7 % of the volume as water: neutral
  sb = run('vehicle d At=0,0 Size=300,150 Mass=1000 Volume=45000 Water=3150', 10); assert(Math.abs(sb.world.vehicles.get('d').vy) < 1, 'neutral at 7 % water');
  // full thrust = 20 x MaxForce N; terminal speed sqrt(a / 0.01)
  sb = run('vehicle d At=0,0 Size=300,150 Mass=1550 Volume=45000\ndev e engine On=d MaxForce=50\ndev k const 100\nwire k.out e.set_force', 60);
  assert(Math.abs(sb.world.vehicles.get('d').vx / 100 - Math.sqrt(1000 / 1550 / 0.01)) < 0.1, 'drone top speed ' + sb.world.vehicles.get('d').vx / 100);
  // the engine keeps its last force when signals stop (Engine.cs)
  sb = run('dev e engine\ndev b button Output=70\nwire b.out e.set_force\nat 0.5 press b', 3); assert.strictEqual(sb.valueOf('e'), '70', 'engine keeps set_force');
  // set_targetlevel -100..100 -> (v + 100) / 2 %
  sb = run('vehicle d At=0,0 Size=300,150 Volume=45000\ndev p pump On=d MaxFlow=600\ndev k const 60\nwire k.out p.set_targetlevel', 5); assert(Math.abs(sb.world.vehicles.get('d').water / sb.world.vehicles.get('d').tank - 0.8) < 0.02, 'pump target level 60 -> 80 %');
  // rock stops it, a fast hit counts as damage; a wall sensor only sees rock while moving
  sb = run('rock 400,-500,600,500\nvehicle d At=0,0 Size=300,150 Mass=1550 Volume=45000\ndev e engine On=d MaxForce=500\ndev k const 100\nwire k.out e.set_force\ndev s motion On=d Offset=250,0 RangeX=100 RangeY=50 Target=Wall', 4);
  const d = sb.world.vehicles.get('d'); assert(d.x + d.w / 2 <= 401 && d.impacts === 1, 'rock stops the drone (impacts ' + d.impacts + ')');
  sb = run('rock 300,-500,600,500\nvehicle d At=0,0 Size=300,150 Volume=45000\ndev s motion On=d Offset=250,0 RangeX=100 RangeY=50 Target=Wall', 0.5); assert.strictEqual(sb.objs.s.s.value, '0', 'a still drone sees no rock');
  // a coilgun on auto-operate shoots a crawler, holds fire while the diver is in the way
  sb = run('vehicle d At=0,0 Size=300,150 Volume=45000 Water=3150\nmonster c Kind=crawler At=1500,0 Sight=10\ndev g turret On=d Kind=coilgun MinAngle=0 MaxAngle=360 AutoOperate=true', 4);
  assert(!sb.world.chars.get('c').alive, 'auto coilgun kills a crawler');
  sb = run('vehicle d At=0,0 Size=300,150 Volume=45000 Water=3150\ndiver p At=700,0 Speed=0\nmonster c Kind=crawler At=1500,0 Sight=10\ndev g turret On=d Kind=coilgun MinAngle=0 MaxAngle=360 AutoOperate=true', 4);
  assert(sb.world.chars.get('c').alive && sb.world.friendly === 0 && sb.objs.g.s.shots === 0, 'no shot through the diver');
  // turret angles: 0 = right, 90 = down; limits snap to the nearer end
  assert.strictEqual(W.clampAngle(80, 180, 360), 360); assert.strictEqual(W.clampAngle(100, 180, 360), 180); assert.strictEqual(W.clampAngle(20, 180, 360), 360);
  console.log('world passed');
}
