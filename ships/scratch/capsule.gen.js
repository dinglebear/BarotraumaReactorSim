// "Claude's Test Capsule": the first submarine built completely from scratch by sim/subbuild.js.
// Two decks of three rooms, an orange shell, doors, a hatch + ladder, AI waypoints and spawn points, and a working
// power/oxygen/navigation setup with Claude's feed-forward reactor circuit. A test bed for the builder, not a showpiece.
// node ships/scratch/capsule.gen.js   ->   ships/custom/Claudes_Test_Capsule.sub
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const SE = require('../../sim/subedit'), { SubBuilder } = require('../../sim/subbuild'), F = require('../../sim/format'), P = require('../../sim/project');
const ROOT = path.join(__dirname, '..', '..');
const read = f => { const b = fs.readFileSync(path.join(ROOT, f)); return (b[0] === 0x1f ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''); };
const templates = ['ships/vanilla/Dugong.sub', 'ships/vanilla/Camel.sub', 'ships/vanilla/Humpback.sub', 'ships/vanilla/Typhon2.sub', 'ships/templates/vanilla_items.xml'].map(f => new SE.SubDoc(read(f)));

const ORANGE = '217,119,87,255', CREAM = '240,225,205,255';
const B = new SubBuilder(templates, {
  name: "Claude's Test Capsule", class: 'Scout', tier: '1', price: '3000', recommendedcrewsizemin: '1', recommendedcrewsizemax: '3',
  description: "Built from nothing by Claude (Anthropic) to test its submarine builder: every wall, room, door, waypoint and wire was placed by a script. Small, orange, and probably a bit wrong somewhere. Tested by Dinglebear.",
}, { shellColor: ORANGE, wallColor: CREAM, backColor: '235,215,195,255' });

const W = 512, H = 256, INSET = 128; // the upper deck steps in at both ends, and the builder fills the steps with slopes
// lower deck (floor y = 0)       upper deck (floor y = 256)
B.room('engine', -2 * W, 0, W, H, { name: 'Engine Room' }).room('reactor', -W, 0, W, H, { name: 'Reactor' }).room('ballast', 0, 0, W, H, { name: 'Ballast', wet: true, bevelBottom: true });
B.room('quarters', -2 * W + INSET, H, W - INSET, H, { name: 'Quarters' }).room('oxygen', -W, H, W, H, { name: 'Life Support' }).room('bridge', 0, H, W - INSET, H, { name: 'Bridge' });
B.door('engine', 'reactor').door('quarters', 'oxygen').door('oxygen', 'bridge');
B.hatch('reactor', 'oxygen', -100);
B.spawn('bridge', 'captain').spawn('reactor', 'engineer').spawn('engine', 'mechanic').spawn('quarters', 'medicaldoctor').spawn('oxygen', 'securityofficer').spawn('quarters', 'assistant').spawn('quarters', 'cargo', -2 * W + INSET + 100);
const d = B.build();

// ---- machinery ----
const reactor = d.add('reactor', 'reactor1', -320, 84 + 4);
const engine = d.add('engine', 'engine', -2 * W + 120, 90);
const pump = d.add('pump', 'pump', 256, 50);
const oxy = d.add('oxy', 'oxygenerator', -280, H + 98);
const nav = d.add('nav', 'navterminal', 300, H + 82);
const status = d.add('status', 'statusmonitor', 120, H + 120);
const batt = d.add('batt', 'battery', W - INSET - 50, H + 42);
// junction boxes: reactor room (main), life support, bridge, engine room
const jA = d.add('jA', 'junctionbox', -470, 110), jB = d.add('jB', 'junctionbox', -470, H + 110), jC = d.add('jC', 'junctionbox', 40, H + 110), jD = d.add('jD', 'junctionbox', -560, 110);
const w = (a, b) => d.wire(a, ...b);
d.wire(reactor, 'power_out', jA, 'power'); d.wire(jA, 'power', jB, 'power'); d.wire(jB, 'power', jC, 'power'); d.wire(jA, 'power', jD, 'power');
d.wire(jD, 'power', engine, 'power_in'); d.wire(jA, 'power', pump, 'power_in'); d.wire(jB, 'power', oxy, 'power_in');
d.wire(jC, 'power', nav, 'power_in'); d.wire(jC, 'power', status, 'power_in'); d.wire(jC, 'power', batt, 'power_in'); d.wire(batt, 'power_out', nav, 'power_in');
d.wire(nav, 'velocity_x_out', engine, 'set_force'); d.wire(nav, 'velocity_y_out', pump, 'set_targetlevel');
// vents in every dry room, linked to the oxygen generator
const vents = [];
for (const [x, y] of [[-2 * W + 300, 200], [-W + 380, 200], [-2 * W + 250, H + 200], [-W + 120, H + 200], [W - INSET - 100, H + 200]]) vents.push(d.add(null, 'vent', x, y));
require('../../sim/subxml').set(d.ref(oxy), 'linked', vents.join(','));
for (const v of vents) require('../../sim/subxml').set(d.ref(v), 'linked', oxy);
// a lamp in every room, powered from the nearest junction box
const lamps = [[-2 * W + W / 2, H - 80, jD], [-W + W / 2, H - 80, jA], [W / 2, H - 80, jA], [-2 * W + W / 2, 2 * H - 80, jB], [-W + W / 2, 2 * H - 80, jB], [W / 2 + 80, 2 * H - 80, jC]];
for (const [x, y, j] of lamps) { const l = d.add(null, 'lamp', x, y); d.wire(j, 'power', l, 'power'); }
// Claude's feed-forward auto reactor (the same idea as the Camel's HUMP-1, load-following)
const maxKW = Number(require('../../sim/subxml').get(d.ref(reactor).children.find(c => c.tag === 'Reactor'), 'MaxPowerOutput')) || 3000; // the cloned reactor's own max
const model = P.substitute(F.parseCirc(read('circuits/example_feedforward.circ')), { MAX: maxKW });
const brain = d.box('brain', -470, 50, model.boxes[0]);
d.wire(reactor, 'load_value_out', brain, 'signal_in1'); d.wire(reactor, 'power_value_out', brain, 'signal_in2'); d.wire(reactor, 'temperature_out', brain, 'signal_in3'); d.wire(reactor, 'fuel_out', brain, 'signal_in4');
d.wire(brain, 'signal_out1', reactor, 'set_fissionrate'); d.wire(brain, 'signal_out2', reactor, 'set_turbineoutput');
// a sign, because every sub needs one
d.add(null, 'label', 250, H + 200, { 'ItemLabel.Text': "CLAUDE'S TEST CAPSULE - mind the orange" });

const probs = d.check(); if (probs.length) throw new Error(probs.join('\n'));
const out = path.join(ROOT, 'ships/custom/Claudes_Test_Capsule.sub');
fs.writeFileSync(out, zlib.gzipSync(Buffer.from(d.text(), 'utf8')));
const au = d.audit(null).filter(x => x.level !== 'info');
console.log(`wrote ${path.relative(ROOT, out)} (${d.items.size} items)${au.length ? '\n' + au.map(x => x.level + ' ' + x.msg).join('\n') : '\naudit: clean'}`);
