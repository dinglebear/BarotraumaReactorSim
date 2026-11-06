// "Claude's Test Capsule", second design: a small sub built completely from scratch by sim/subbuild.js, drawn as a sub
// rather than a box. Four levels: a ballast-and-cargo keel, the main deck, an upper deck, and a conning tower that is
// Claude's Room. The decks taper toward both ends (a long taper at the stern, a short round one at the bow), and the
// builder fills every step with a slanted shell piece, so the outline reads like a hull.
//
//              ┌ CLAUDE'S ┐                                   bow on the right (+x), like the vanilla subs
//      ┌───────┤   ROOM   ├──────────┬────────┐
//      │ CREW  │   LIFE SUPPORT      │ BRIDGE │               upper deck   y 256..512
//  ┌───┴──┬────┴───┬────────────┬────┴────────┴──┐
//  │ENGINE│ REACTOR │ ELECTRICAL │    WORKSHOP    │           main deck    y   0..256
//  └──────┴┬───────┴───┬────────┴───┬────────────┘
//          │AFT BALLAST│ CARGO HOLD │FORE BALLAST│             keel         y -256..0
//          └───────────┴────────────┴────────────┘
//
// Systems: the reactor runs Claude's REACTIVE/ECO circuit (circuits/reactor_modes.circ) with a mode lever, and two
// displays show its output; two ballast pumps follow the nav terminal; an oxygen generator feeds a vent in every dry
// room; two batteries back the grid. Claude's Room yells at visitors (circuits/capsule/). Circuits are checked in
// sandbox/capsule.sbx before they go in.
// node ships/scratch/capsule.gen.js   ->   ships/custom/Claudes_Test_Capsule.sub
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const SE = require('../../sim/subedit'), { SubBuilder } = require('../../sim/subbuild'), F = require('../../sim/format'), P = require('../../sim/project'), X = require('../../sim/subxml');
const ROOT = path.join(__dirname, '..', '..');
const read = f => { const b = fs.readFileSync(path.join(ROOT, f)); return (b[0] === 0x1f ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''); };
const templates = ['ships/vanilla/Dugong.sub', 'ships/vanilla/Camel.sub', 'ships/vanilla/Humpback.sub', 'ships/vanilla/Typhon2.sub', 'ships/templates/vanilla_items.xml'].map(f => new SE.SubDoc(read(f)));

const ORANGE = '217,119,87,255', CREAM = '240,225,205,255';
const B = new SubBuilder(templates, {
  name: "Claude's Test Capsule", class: 'Scout', tier: '1', price: '3500', recommendedcrewsizemin: '2', recommendedcrewsizemax: '4',
  checkval: '1532362630', // fixed, so rebuilding gives the same file
  description: "Built from nothing by Claude (Anthropic): every wall, room, door, ladder, wire and circuit placed by a script. A small scout with a tapered hull, a reactor with ECO and REACTIVE modes on a lever, two ballast tanks and a conning tower. The conning tower is Claude's Room. Don't go in Claude's Room. Tested by Dinglebear.",
}, { shellColor: ORANGE, wallColor: CREAM, backColor: '235,215,195,255' });

// ---- rooms: x from the stern (left) to the bow (right); a room is (x, floor y, width, height); decks are 256 tall
const D = 256;
B.room('aftBallast', -768, -D, 512, D, { name: 'Aft Ballast', wet: true }).room('cargo', -256, -D, 768, D, { name: 'Cargo Hold' }).room('foreBallast', 512, -D, 512, D, { name: 'Fore Ballast', wet: true });
B.room('engine', -1280, 0, 512, D, { name: 'Engine Room', bevelBottom: true }).room('reactor', -768, 0, 640, D, { name: 'Reactor Room' })
  .room('electrical', -128, 0, 512, D, { name: 'Electrical' }).room('workshop', 384, 0, 896, D, { name: 'Workshop' });
B.room('quarters', -768, D, 512, D, { name: 'Crew Quarters' }).room('life', -256, D, 896, D, { name: 'Life Support' }).room('bridge', 640, D, 384, D, { name: 'Bridge' });
B.room('claude', 0, 2 * D, 384, D, { name: "Claude's Room" });
B.door('engine', 'reactor').door('reactor', 'electrical').door('electrical', 'workshop').door('quarters', 'life').door('life', 'bridge');
// ladders: reactor room up to the quarters, electrical up to life support and down to the cargo hold, life support up the tower
B.hatch('reactor', 'quarters', -400).hatch('electrical', 'life', 0).hatch('cargo', 'electrical', 250).hatch('life', 'claude', 250);
B.spawn('bridge', 'captain').spawn('reactor', 'engineer').spawn('workshop', 'mechanic').spawn('quarters', 'medicaldoctor').spawn('life', 'securityofficer').spawn('quarters', 'assistant').spawn('cargo', 'cargo', 0);
const d = B.build();
const wire = (a, ac, b, bc) => d.wire(a, ac, b, bc);
const at = (key, rx, h) => { const r = B.rooms[key]; return [r.x0 + rx, r.y0 + h]; }; // a spot in a room: x from its left wall, height above its floor
const add = (key, id, room, rx, h, props) => { const [x, y] = at(room, rx, h); return d.add(key, id, x, y, props); };

// ---- machinery (positions: x from the room's left wall, height above its floor; the ceiling slab starts at 208, and
// ladders, hatch holes and doors are kept clear)
const engine = add('engine', 'engine', 'engine', 120, 90);                       // overhangs the stern, like the vanilla subs
const reactor = add('reactor', 'reactor1', 'reactor', 150, 88);                  // ladder up at 328
const oxy = add('oxy', 'oxygenerator', 'life', 730, 100);
const nav = add('nav', 'navterminal', 'bridge', 200, 82), status = add('status', 'statusmonitor', 'bridge', 56, 130);
const pumpA = add('pumpA', 'pump', 'aftBallast', 256, 52), pumpF = add('pumpF', 'pump', 'foreBallast', 256, 52);
const batts = [add('batt1', 'battery', 'electrical', 200, 45), add('batt2', 'battery', 'electrical', 268, 45)]; // ladders at 88 (up) and 338 (down)
const fabr = add('fabr', 'fabricator', 'workshop', 150, 104), decon = add('decon', 'deconstructor', 'workshop', 360, 84);
for (const rx of [740, 800, 860]) add(null, 'divingsuitlocker', 'workshop', rx, 68);
add(null, 'opdeco_bunkbeds', 'quarters', 140, 70);                              // ladder up from the reactor room at 328
add(null, 'medcabinet', 'life', 70, 92); add(null, 'oxygentankshelf2', 'life', 560, 60); // ladders at 216 (from below) and 466 (tower)
add(null, 'crateshelf', 'cargo', 100, 96); add(null, 'crateshelf', 'cargo', 650, 96); // ladder at 466

// ---- power: reactor -> main box; branches to the engine room, electrical (batteries, workshop, keel) and up to life
// support and the bridge
const jMain = add('jMain', 'junctionbox', 'reactor', 600, 80), jEng = add('jEng', 'junctionbox', 'engine', 460, 80);
const jElec = add('jElec', 'junctionbox', 'electrical', 460, 110), jShop = add('jShop', 'junctionbox', 'workshop', 540, 90);
const jKeel = add('jKeel', 'junctionbox', 'cargo', 300, 110), jLife = add('jLife', 'junctionbox', 'life', 160, 110), jBridge = add('jBridge', 'junctionbox', 'bridge', 56, 50);
wire(reactor, 'power_out', jMain, 'power');
for (const j of [jEng, jElec, jLife]) wire(jMain, 'power', j, 'power');
for (const j of [jShop, jKeel]) wire(jElec, 'power', j, 'power');
wire(jLife, 'power', jBridge, 'power');
wire(jEng, 'power', engine, 'power_in');
for (const b of batts) { wire(jElec, 'power', b, 'power_in'); wire(b, 'power_out', jElec, 'power'); }
for (const it of [fabr, decon]) wire(jShop, 'power', it, 'power_in');
for (const p of [pumpA, pumpF]) wire(jKeel, 'power', p, 'power_in');
wire(jLife, 'power', oxy, 'power_in');
for (const it of [nav, status]) wire(jBridge, 'power', it, 'power_in');
// steering: the engine follows velocity_x_out, both ballast pumps velocity_y_out (as in the vanilla subs)
wire(nav, 'velocity_x_out', engine, 'set_force');
for (const p of [pumpA, pumpF]) wire(nav, 'velocity_y_out', p, 'set_targetlevel');

// ---- air: a vent in every dry room, all linked to the oxygen generator; lights: a lamp under every ceiling
const vents = [];
for (const [room, rx, h] of [['engine', 460, 168], ['reactor', 600, 170], ['electrical', 250, 170], ['workshop', 470, 172], ['quarters', 260, 172], ['life', 380, 175], ['bridge', 340, 40], ['claude', 330, 70], ['cargo', 380, 172]]) vents.push(add(null, 'vent', room, rx, h));
X.set(d.ref(oxy), 'linked', vents.join(','));
for (const v of vents) X.set(d.ref(v), 'linked', oxy);
const lamps = [['engine', 330, jEng], ['reactor', 380, jMain], ['electrical', 330, jElec], ['workshop', 650, jShop], ['cargo', 200, jKeel], ['aftBallast', 256, jKeel], ['foreBallast', 256, jKeel],
  ['quarters', 400, jLife], ['life', 300, jLife], ['bridge', 300, jBridge], ['claude', 260, jLife]];
for (const [room, rx, j] of lamps) wire(j, 'power', add(null, 'lamp', room, rx, room === 'reactor' ? 150 : 182), 'power'); // the reactor room's sits between the ladder and the controls

// ---- the reactor: Claude's REACTIVE / ECO circuit, a mode lever beside it (up = REACTIVE), output on two displays
const maxKW = Number(X.get(d.ref(reactor).children.find(c => c.tag === 'Reactor'), 'MaxPowerOutput')) || 3000; // the cloned reactor's own max
const brain = d.box('brain', ...at('reactor', 450, 50), P.substitute(F.parseCirc(read('circuits/reactor_modes.circ')), { MAX: maxKW }).boxes[0]);
const lever = add('lever', 'lever', 'reactor', 500, 50, { 'Controller.IsToggle': 'True', 'Controller.State': 'True', 'Controller.Output': '1', 'Controller.FalseOutput': '0', 'Controller.Msg': 'Reactor mode: up REACTIVE, down ECO' });
wire(reactor, 'load_value_out', brain, 'signal_in1'); wire(reactor, 'power_value_out', brain, 'signal_in2'); wire(reactor, 'temperature_out', brain, 'signal_in3'); wire(reactor, 'fuel_out', brain, 'signal_in4');
wire(lever, 'signal_out', brain, 'signal_in8');
wire(brain, 'signal_out1', reactor, 'set_fissionrate'); wire(brain, 'signal_out2', reactor, 'set_turbineoutput');
const readout = d.box('readout', ...at('reactor', 550, 50), F.parseCirc(read('circuits/capsule/capsule_readout.circ')).boxes[0]);
wire(reactor, 'power_value_out', readout, 'signal_in1'); wire(lever, 'signal_out', readout, 'signal_in2');
for (const [room, rx, h] of [['reactor', 500, 148], ['bridge', 200, 176]]) { const sc = add(null, 'textdisplay', room, rx, h); wire(readout, 'signal_out1', sc, 'set_text'); wire(readout, 'signal_out2', sc, 'set_text_color'); }
add(null, 'label', 'reactor', 500, 100, { 'ItemLabel.Text': 'LEVER UP: REACTIVE / DOWN: ECO' });

// ---- Claude's Room: walk in and the capsule yells at you (circuits/capsule/capsule_claude_room.circ); ladder at 210
const pir = add('pir', 'motiondetector', 'claude', 150, 100, { 'MotionSensor.Target': 'Human', 'MotionSensor.RangeX': '170', 'MotionSensor.RangeY': '90', 'MotionSensor.DetectOffset': '0,0' });
const room = d.box('room', ...at('claude', 140, 150), F.parseCirc(read('circuits/capsule/capsule_claude_room.circ')).boxes[0]);
const flash = add('flash', 'emergencylight', 'claude', 190, 196, { 'LightComponent.LightColor': ORANGE, 'LightComponent.IsOn': 'false' });
const buzz = add('buzz', 'alarmbuzzer', 'claude', 330, 165);
const chat = add('chat', 'wificomponent', 'claude', 110, 100, { 'WifiComponent.Channel': '0', 'WifiComponent.LinkToChat': 'true', 'WifiComponent.DiscardDuplicateChatMessages': 'false', 'WifiComponent.MinChatMessageInterval': '30' });
const sign = add('sign', 'textdisplay', 'claude', 300, 125, { 'ItemLabel.TextColor': ORANGE });
wire(pir, 'state_out', room, 'signal_in1'); wire(room, 'signal_out1', chat, 'signal_in'); wire(room, 'signal_out2', flash, 'set_state'); wire(room, 'signal_out3', buzz, 'set_state'); wire(room, 'signal_out4', sign, 'set_text');
add(null, 'op_clownposter2', 'claude', 50, 70);
add(null, 'label', 'claude', 60, 160, { 'ItemLabel.Text': 'NOT A JESTER' });
add(null, 'label', 'life', 360, 100, { 'ItemLabel.Text': "CLAUDE'S ROOM - KEEP OUT" }); // by the tower ladder
add(null, 'label', 'workshop', 650, 110, { 'ItemLabel.Text': "CLAUDE'S TEST CAPSULE" });

const probs = d.check(); if (probs.length) throw new Error(probs.join('\n'));
const out = path.join(ROOT, 'ships/custom/Claudes_Test_Capsule.sub');
fs.writeFileSync(out, zlib.gzipSync(Buffer.from(d.text(), 'utf8')));
const au = d.audit(null).filter(x => x.level !== 'info');
console.log(`wrote ${path.relative(ROOT, out)} (${d.items.size} items, ${B.slopes.length} slopes)${au.length ? '\n' + au.map(x => x.level + ' ' + x.msg).join('\n') : '\naudit: clean'}`);
