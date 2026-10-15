// Circuit sandbox: build any number of circuit boxes, loose components and virtual devices, wire them together,
// script inputs over time, and see what happens: a change trace, device logs, assertions, and a list of errors and
// warnings (the mistakes that cost an in-game round). Same component engine as the bench and the sub mock.
//
// File format (.sbx), one statement per line, '#' comments:
//   name <title>
//   dev <id> <type> [Prop=value ...]     button | switch | const | terminal | light | display | probe | door
//                                        | motion | water | smoke | oxygen   (see DEVICES below)
//   part <id> <component> [Prop=value]   a component outside any box (same types as .circ: and, mem, regex, wifi...)
//   box <name>                           a circuit box; then .circ lines (c / w / note / label) until the next
//   ...                                  top-level statement. Box pins: <box>.in0..in9 / <box>.out0..out9 (current boxes have 10 each)
//   box <name> file=<path> [box=N] [K=V] load a box from a .circ or Blueprints .txt file (path from the repo root;
//                                        the web page knows circuits/**), filling $K placeholders
//                                        (e.g. file=circuits/camel/camel_door.circ ROOM=Medbay). box=N picks the Nth box.
//   wire <a> <b> [<c> ...]               world wires: <dev>.<pin>, <part>.<pin>, <box>.in3 / <box>.out2
//   at <t> press|set|toggle|type|say <target> [value]     scripted input at t seconds
//   watch <endpoint> ...                 print every change on these pins
//   expect <t> <endpoint|dev> <op> <value>   check at t: op = | != | > | < | ~ (regex) ; dev value = its state/text
//   expectwarn <regex> / expecterror <regex>   this run must report a matching warning/error (for pitfall demos);
//                                        a matched error doesn't fail the run
//   run <seconds>
// Endpoints: pin shorthands work as in .circ (1 = signal_in1, out = signal_out, in = signal_in).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./components'), require('./format'));
  else root.BaroSandbox = factory(root.BaroEngine, root.BaroComponents, root.BaroFormat);
})(typeof self !== 'undefined' ? self : this, function (E, C, F) {
  'use strict';
  const STEP = E.STEP;
  const HELP = "File format (.sbx), one statement per line, '#' comments:\n  name <title>\n  dev <id> <type> [Prop=value ...]     button | switch | const | terminal | light | display | probe | door\n                                       | motion | water | smoke | oxygen   (see DEVICES below)\n  part <id> <component> [Prop=value]   a component outside any box (same types as .circ: and, mem, regex, wifi...)\n  box <name>                           a circuit box; then .circ lines (c / w / note / label) until the next\n  ...                                  top-level statement. Box pins: <box>.in0..in9 / <box>.out0..out9 (current boxes have 10 each)\n  box <name> file=<path> [box=N] [K=V] load a box from a .circ or Blueprints .txt file (path from the repo root;\n                                       the web page knows circuits/**), filling $K placeholders\n                                       (e.g. file=circuits/camel/camel_door.circ ROOM=Medbay). box=N picks the Nth box.\n  wire <a> <b> [<c> ...]               world wires: <dev>.<pin>, <part>.<pin>, <box>.in3 / <box>.out2\n  at <t> press|set|toggle|type|say <target> [value]     scripted input at t seconds\n  watch <endpoint> ...                 print every change on these pins\n  expect <t> <endpoint|dev> <op> <value>   check at t: op = | != | > | < | ~ (regex) ; dev value = its state/text\n  expectwarn <regex> / expecterror <regex>   this run must report a matching warning/error (for pitfall demos);\n                                       a matched error doesn't fail the run\n  run <seconds>\nEndpoints: pin shorthands work as in .circ (1 = signal_in1, out = signal_out, in = signal_in).";
  // virtual devices: pins and what they do
  const DEVICES = {
    button: { outs: ['signal_out'], ins: [], about: 'press -> sends Output (default "1") once' },
    switch: { outs: ['signal_out'], ins: ['toggle', 'set_state'], about: 'a lever: sends On ("1") or Off ("0") every tick; toggle / set 0|1' },
    const: { outs: ['signal_out'], ins: [], about: 'sends Value every tick (a slider, a sensor reading); set <value>' },
    terminal: { outs: ['signal_out'], ins: ['signal_in', 'clear_text'], about: 'type <text> -> signal_out; prints what arrives on signal_in' },
    light: { outs: [], ins: ['toggle', 'set_state', 'set_color'], about: 'on/off and colour' },
    display: { outs: [], ins: ['set_text', 'set_text_color'], about: 'a text display' },
    probe: { outs: [], ins: ['*'], about: 'shows the last signal on any pin and logs every change' },
    door: { outs: ['state_out'], ins: ['toggle', 'set_state'], about: 'open/closed; state_out every tick' },
    motion: { outs: ['state_out'], ins: [], about: 'Output ("1") while someone is there, else FalseOutput ("0"); set 1|0' },
    water: { outs: ['signal_out', 'water_%'], ins: [], about: 'like a water detector: set <percent>' },
    smoke: { outs: ['signal_out'], ins: [], about: 'Output ("1") while set 1, else FalseOutput ("0")' },
    oxygen: { outs: ['signal_out'], ins: [], about: 'oxygen detector: sends the % every tick; set <percent>' },
    // vehicles: drones, shuttles, anything you drive and shoot from
    periscope: { outs: ['position_out', 'trigger_out'], ins: [], about: 'aim angle in degrees on position_out every tick; set <deg>; press = one trigger_out (Output, "1"); toggle = hold fire (every tick)' },
    turret: { outs: [], ins: ['position_in', 'trigger_in', 'toggle_light', 'set_light'], about: 'coilgun/chaingun: takes the angle from position_in; fires on trigger_in if reloaded (Reload=1 s). Read gun.shots / gun.angle' },
    engine: { outs: [], ins: ['set_force'], about: 'set_force -100..100; with no signal for 0.1 s it falls back to its manual setting (0). Read eng.force' },
    pump: { outs: [], ins: ['set_speed', 'set_targetlevel', 'set_active', 'toggle'], about: 'set_speed -100..100 (+ pumps in), set_targetlevel 0..100, set_active. Read p.speed / p.target / p.on' },
    nav: { outs: ['velocity_x_out', 'velocity_y_out', 'toggle_docking', 'current_velocity_x', 'current_velocity_y'], ins: [], about: 'nav terminal: set <x>,<y> steering (-100..100, y up); sends velocity_x_out = x and velocity_y_out = -y (pump speed) every tick; press = toggle_docking' },
    dock: { outs: ['state_out', 'proximity_sensor', 'on_dock', 'on_undock'], ins: ['toggle', 'set_state'], about: 'docking port: dev d dock 1 = starts docked; set 1/0 = another port is near or not; toggle/set_state docks (only when near) or undocks; on_dock/on_undock pulse once' },
  };
  // inputs that keep only the latest value and act on it in Update() (several senders in one tick: the last one wins).
  // set_* pins always latch; signal_in* only on parts that store it (memory, regex, logic and arithmetic inputs).
  // wifi, not, relay, delay, mod, demux... forward every signal, so several wires into them are fine.
  const LATCH_SIGNAL_IN = /^(mem|regex|and|or|xor|add|sub|mul|div|greater|equals|concat|color|check|mux)$/;
  const LATCHING = /^(set_state|set_text|set_color|set_text_color|set_targetlevel|set_force|set_rate|set_fissionrate|set_turbineoutput|set_output|set_targetsignal|set_channel|lock_state|set_delay|set_frequency)$/;
  const latches = (alias, pin) => LATCHING.test(pin) || (/^signal_in[12]?$/.test(pin) && LATCH_SIGNAL_IN.test(alias));
  const tokenize = line => [...line.matchAll(/([^\s"=]+=)"([^"]*)"|"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(m => m[1] !== undefined ? m[1] + m[2] : m[3] !== undefined ? m[3].replace(/\\(.)/g, (a, b) => b === 'n' ? '\n' : b) : m[4]);

  function parse(text, opts = {}) {
    const spec = { name: 'sandbox', devs: [], parts: [], boxes: [], wires: [], events: [], watches: [], expects: [], msgExpects: [], duration: 10, errors: [] };
    let boxLines = null, boxName = null, boxStart = 0;
    const flush = () => {
      if (!boxLines) return;
      try { const m = F.parseCirc('box ' + boxName + '\n' + boxLines.join('\n')); spec.boxes.push(Object.assign(m.boxes[0], { name: boxName })); }
      catch (e) { spec.errors.push(`box ${boxName} (starts line ${boxStart}): ${e.message.replace(/line (\d+)/, (a, n) => 'line ' + (Number(n) + boxStart - 1))}`); }
      boxLines = null;
    };
    String(text).split(/\r?\n/).forEach((raw, i) => {
      const ln = i + 1, line = raw.replace(/(^|\s)#.*$/, '').trim(); if (!line) { if (boxLines) boxLines.push(''); return; }
      const t = tokenize(line), k = t[0].toLowerCase();
      if (boxLines && /^(c|w|note|label|pin)$/.test(k)) { boxLines.push(raw); return; }
      flush();
      const props = arr => { const o = {}; for (const s of arr) { const j = s.indexOf('='); if (j > 0) o[s.slice(0, j)] = s.slice(j + 1); } return o; };
      try {
        if (k === 'name') spec.name = t.slice(1).join(' ');
        else if (k === 'box' && t.some(x => x.startsWith('file='))) {
          const kv = props(t.slice(2)); if (!opts.readFile) throw new Error('box file= needs the CLI (no file access here)');
          let src = opts.readFile(kv.file); for (const [a, v] of Object.entries(kv)) if (a !== 'file') src = src.split('$' + a).join(v);
          const left = [...new Set((src.match(/\$[A-Z_][A-Z0-9_]*/g) || []))]; if (left.length) spec.errors.push(`line ${ln}: ${kv.file} still has placeholders ${left.join(' ')} (give them as K=V)`);
          const m = F.load(src, t[1]); spec.boxes.push(Object.assign(m.boxes[(Number(kv.box) || 1) - 1] || m.boxes[0], { name: t[1] }));
        }
        else if (k === 'box') { boxName = t[1]; boxLines = []; boxStart = ln + 1; }
        else if (k === 'dev') { if (!DEVICES[t[2]]) throw new Error(`unknown device "${t[2]}" (${Object.keys(DEVICES).join(', ')})`); spec.devs.push({ id: t[1], type: t[2], props: props(t.slice(3)), arg: t[3] && !t[3].includes('=') ? t[3] : undefined, ln }); }
        else if (k === 'part') { const def = C.byAlias(t[2]); if (!def) throw new Error(`unknown component "${t[2]}"`); const p = {}; for (const [a, v] of Object.entries(props(t.slice(3)))) p[C.propName(def, a)] = v; spec.parts.push({ id: t[1], def, props: p, ln }); }
        else if (k === 'wire') { for (const b of t.slice(2)) spec.wires.push({ a: t[1], b, ln }); }
        else if (k === 'at') spec.events.push({ t: Number(t[1]), act: t[2], target: t[3], value: t.slice(4).join(' '), ln });
        else if (k === 'watch') spec.watches.push(...t.slice(1));
        else if (k === 'expect') spec.expects.push({ t: Number(t[1]), target: t[2], op: t[3], value: t.slice(4).join(' '), ln });
        else if (k === 'expectwarn' || k === 'expecterror') spec.msgExpects.push({ kind: k === 'expectwarn' ? 'warning' : 'error', re: t.slice(1).join(' '), ln });
        else if (k === 'run') spec.duration = Number(t[1]) || 10;
        else throw new Error(`unknown statement "${t[0]}"`);
      } catch (e) { spec.errors.push(`line ${ln}: ${e.message}`); }
    });
    flush();
    return spec;
  }

  class Sandbox extends E.Sim {
    constructor(spec) {
      super({ boxes: [] }, { profile: { points: [{ t: 0, demand: 0 }], duration: spec.duration, meta: {} }, start: 'cold' });
      this.spec = spec; this.errors = spec.errors.slice(); this.warns = []; this.log = []; this.chat = []; this.trace = []; this.results = [];
      this.objs = {}; this.devs = []; this.conflicts = {};
      for (const bm of spec.boxes) {
        if (this.objs[bm.name]) { this.errors.push(`duplicate name "${bm.name}"`); continue; }
        if (bm.components.length > 64) this.errors.push(`box ${bm.name}: ${bm.components.length} components; an in-game circuit box holds 64 (the rest are lost on load)`);
        // the circuit box area is 8192 x 8192 around 0,0: anything placed further out is clamped and piles up at the border
        for (const c of bm.components) if (c.pos && (Math.abs(c.pos[0]) > F.CB_HALF || Math.abs(c.pos[1]) > F.CB_HALF)) this.warns.push(`box ${bm.name}: component ${c.id} at ${c.pos.map(Math.round).join(',')} is outside the box area (+-${F.CB_HALF}); the game pushes it to the border, where everything out there piles up`);
        F.autoLayout(bm); for (const p of F.layoutProblems(bm)) this.errors.push(`box ${bm.name}: ${p}`);
        const box = this.buildBox(bm); this.boxes.push(box); this.objs[bm.name] = { kind: 'box', it: box, bm };
      }
      for (const p of spec.parts) {
        const box = this.buildBox({ name: 'part:' + p.id, components: [{ id: '0', item: p.def.item, cls: p.def.cls, props: p.props }], wires: [], pins: {} });
        this.boxes.push(box); this.objs[p.id] = { kind: 'part', it: box.compById['0'], def: p.def };
      }
      for (const d of spec.devs) this.addDev(d);
      for (const w of spec.wires) { const a = this.ep(w.a, w.ln), b = this.ep(w.b, w.ln); if (a && b) { this.wire(a, b); (a.senders = a.senders || []).push(w.b); (b.senders = b.senders || []).push(w.a); } }
      this.lint();
      this.ev = spec.events.slice().sort((p, q) => p.t - q.t); this.evI = 0;
      this.ex = spec.expects.slice().sort((p, q) => p.t - q.t); this.exI = 0;
      this.watched = spec.watches.map(s => ({ name: s, conn: this.ep(s, 0, true), last: undefined }));
    }
    // resolve "obj.pin" to a connection
    ep(s, ln, quiet) {
      const i = s.indexOf('.'); const id = i < 0 ? s : s.slice(0, i), pin0 = i < 0 ? '' : s.slice(i + 1), o = this.objs[id];
      const err = m => { if (!quiet) this.errors.push(`line ${ln}: ${m}`); return null; };
      if (!o) return err(`"${id}" is not a device, part or box`);
      if (o.kind === 'box') { const m = /^(in|out)([0-9])$/.exec(pin0) || /^signal_(in|out)([0-9])$/.exec(pin0); if (!m) return err(`box pins are in0..in9 / out0..out9 (got "${pin0}")`); return this.conn(o.it, `signal_${m[1]}${m[2]}`); }
      if (o.kind === 'part') { const pin = F.longPin(pin0 || 'out', o.def.item); if (![...o.def.ins, ...o.def.outs].includes(pin)) return err(`${o.def.alias} has no pin "${pin0}" (${[...o.def.ins, ...o.def.outs].join(', ')})`); return this.conn(o.it, pin); }
      const dt = DEVICES[o.type], pin = pin0 === 'out' || pin0 === '' ? (dt.outs[0] || dt.ins[0]) : pin0 === 'in' ? 'signal_in' : pin0;
      if (dt.ins[0] !== '*' && ![...dt.ins, ...dt.outs].includes(pin)) return err(`${o.type} "${id}" has no pin "${pin0}" (${[...dt.ins, ...dt.outs].join(', ')})`);
      return this.conn(o.it, pin);
    }
    addDev(d) {
      if (this.objs[d.id]) { this.errors.push(`line ${d.ln}: duplicate name "${d.id}"`); return; }
      const it = this.mkItem('dev:' + d.id, {}), s = { on: false, text: '', color: '', lines: [], value: d.arg !== undefined ? d.arg : (d.props.Value !== undefined ? d.props.Value : '0') };
      const o = { kind: 'dev', type: d.type, it, s, props: d.props }; this.objs[d.id] = o; this.devs.push(o);
      const send = (pin, v) => this.send(it, pin, String(v)), P = d.props;
      // log changes; a device that changes more than 8 times in a second is fighting senders: warn once, mute it for that second
      const fl = { sec: -1, n: 0 }, log = m => {
        const sec = Math.floor(this.time); if (sec !== fl.sec) { fl.sec = sec; fl.n = 0; }
        if (fl.muted) { fl.muted++; return; }
        if (++fl.n === 9) { fl.muted = 1; this.warns.push(`${this.time.toFixed(2)}s ${d.type} ${d.id} flickers (changed 9+ times in a second): two signals fighting over one input?`); this.log.push(`${this.time.toFixed(2)}s ${d.id}: ... flickering, muted from here (see WARNINGS)`); return; }
        this.log.push(`${this.time.toFixed(2)}s ${d.id}: ${m}`);
      };
      const T = d.type;
      if (T === 'switch') s.on = /^(1|on|true)$/i.test(d.arg || P.State || '0');
      if (T === 'door') s.on = /^(1|open|true)$/i.test(d.arg || '0');
      if (T === 'nav' && d.arg === undefined && P.Value === undefined) s.value = '0,0';
      if (T === 'pump') { s.on = true; s.speed = 0; }
      if (T === 'turret') { s.angle = 0; s.shots = 0; }
      if (T === 'engine') s.force = 0;
      if (T === 'periscope') s.on = true; // manned
      if (T === 'dock') { s.on = /^(1|docked|true)$/i.test(d.arg || '0'); s.value = s.on ? '1' : '0'; } // dev d dock 1 = starts docked
      it.recv = (pin, sig) => {
        const v = sig.v;
        if (T === 'light' || T === 'switch' || T === 'door') {
          if (pin === 'toggle') { if (v !== '0' && v !== '') { s.on = !s.on; if (T !== 'switch') log(`${T === 'door' ? (s.on ? 'opens' : 'closes') : (s.on ? 'on' : 'off')} (toggle)`); } }
          else if (pin === 'set_state') { const n = v !== '0'; if (n !== s.on && T !== 'switch') log(T === 'door' ? (n ? 'opens' : 'closes') : (n ? 'on' : 'off')); s.on = n; }
          else if (pin === 'set_color') { if (v !== s.color) { s.color = v; log(`colour ${v}`); } }
        } else if (T === 'display') { if (pin === 'set_text' && v !== s.text) { s.text = v; log(`shows "${v}"`); } else if (pin === 'set_text_color') s.color = v; }
        else if (T === 'terminal') { if (pin === 'signal_in' && v !== '') { s.lines.push(v); log(`< ${v}`); } else if (pin === 'clear_text' && v !== '0') { s.lines = []; log('(cleared)'); } }
        else if (T === 'probe') { if (v !== s.last) log(`${pin} = "${v}"`); s.last = v; }
        else if (T === 'turret') {
          if (pin === 'position_in') { const a = Number(v); if (Number.isFinite(a)) s.angle = a; }
          else if (pin === 'trigger_in' && v !== '0' && v !== '') { const rl = Number(P.Reload ?? 1); if (this.time - (s.lastShot ?? -1e9) >= rl) { s.lastShot = this.time; s.shots = (s.shots || 0) + 1; log(`fires at ${Number(s.angle || 0).toFixed(1)}° (shot ${s.shots})`); } }
        }
        else if (T === 'engine') { if (pin === 'set_force') { const f = Number(v); if (Number.isFinite(f)) { const n = Math.max(-100, Math.min(100, f)); if (Math.round(n) !== Math.round(s.force || 0)) log(`force ${Math.round(n)} %`); s.force = n; s.lockT = this.time; } } }
        else if (T === 'pump') {
          const n = Number(v);
          if (pin === 'set_speed' && Number.isFinite(n)) { const q = Math.max(-100, Math.min(100, n)); if (Math.round(q) !== Math.round(s.speed || 0)) log(`speed ${Math.round(q)} %`); s.speed = q; }
          else if (pin === 'set_targetlevel' && Number.isFinite(n)) { const q = Math.max(0, Math.min(100, n)); if (Math.round(q) !== Math.round(s.target ?? -1)) log(`target level ${Math.round(q)} %`); s.target = q; }
          else if (pin === 'set_active') { const on = v !== '0'; if (on !== s.on) log(on ? 'on' : 'off'); s.on = on; }
          else if (pin === 'toggle' && v !== '0' && v !== '') { s.on = !s.on; log(s.on ? 'on' : 'off'); }
        }
        else if (T === 'dock') {
          const want = pin === 'toggle' ? (v !== '0' && v !== '' ? !s.on : s.on) : pin === 'set_state' ? v !== '0' : s.on;
          if (want !== s.on) { if (want && s.value === '0') log('can\'t dock: no port near'); else { s.on = want; log(s.on ? 'docked' : 'undocked'); s.pulse = s.on ? 'on_dock' : 'on_undock'; } }
        }
      };
      o.update = () => {
        if (T === 'switch') send('signal_out', s.on ? (P.On || '1') : (P.Off || '0'));
        else if (T === 'const' || T === 'oxygen') send('signal_out', s.value);
        else if (T === 'door') send('state_out', s.on ? '1' : '0');
        else if (T === 'motion') { const v = s.value !== '0' ? (P.Output !== undefined ? P.Output : '1') : (P.FalseOutput !== undefined ? P.FalseOutput : '0'); if (v !== '') send('state_out', v); }
        else if (T === 'periscope') { if (s.on !== false) send('position_out', s.value); if (s.fire) send('trigger_out', P.Output || '1'); }
        else if (T === 'engine') { if (s.lockT !== undefined && this.time - s.lockT > 0.1 && s.force) { s.force = 0; log('no signal: back to manual (0 %)'); } }
        else if (T === 'nav') { const [x, y] = String(s.value).split(',').map(Number); send('velocity_x_out', String(x || 0)); send('velocity_y_out', String(-(y || 0))); send('current_velocity_x', '0.0000'); send('current_velocity_y', '0.0000'); }
        else if (T === 'dock') { send('state_out', s.on ? '1' : '0'); send('proximity_sensor', s.value !== '0' ? '1' : '0'); if (s.pulse) { send(s.pulse, '1'); s.pulse = null; } }
        else if (T === 'water' || T === 'smoke') { const wet = Number(s.value) > 0; const v = wet ? (P.Output !== undefined ? P.Output : '1') : (P.FalseOutput !== undefined ? P.FalseOutput : '0'); if (v !== '') send('signal_out', v); if (T === 'water') send('water_%', String(Math.round(Number(s.value) || 0))); }
      };
      o.act = (act, value) => {
        if (act === 'press' && T === 'periscope') { send('trigger_out', P.Output || '1'); log('fire'); }
        else if (act === 'press' && T === 'nav') { send('toggle_docking', '1'); log('docking button'); }
        else if (act === 'press') { send('signal_out', P.Output || '1'); log('pressed'); }
        else if (act === 'toggle' && T === 'periscope') { s.fire = !s.fire; log(s.fire ? 'holding fire' : 'released fire'); }
        else if (act === 'toggle') { s.on = !s.on; log(T === 'switch' ? (s.on ? 'switched on' : 'switched off') : 'toggled'); }
        else if (act === 'set') { if (T === 'switch' || T === 'door') s.on = /^(1|on|true|open)$/i.test(value); else s.value = value; log(`set to ${value}`); }
        else if (act === 'type') { s.lines.push('> ' + value); log(`> ${value}`); send('signal_out', value); }
        else this.errors.push(`"${act}" doesn't apply to a ${T}`);
      };
    }
    // static checks: the in-game mistakes
    lint() {
      const W = m => this.warns.push(m);
      const needsBoth = /^(and|or|xor|add|sub|mul|div|mod|greater|equals|concat|pow|atan)$/;
      for (const box of this.boxes) {
        const bm = box.model, isPart = bm.name.startsWith('part:'), label = isPart ? 'part ' + bm.name.slice(5) : 'box ' + bm.name;
        // which component pins get signals inside a box (wires from box inputs or other components), and which outputs are used
        const fed = new Set(), used = new Set(), senders = {};
        for (const w of bm.wires) {
          if (w.to.c !== null) { const k = w.to.c + '|' + w.to.pin; fed.add(k); senders[k] = (senders[k] || 0) + 1; }
          if (w.from.c !== null) used.add(w.from.c + '|' + w.from.pin);
        }
        for (const [id, ci] of Object.entries(box.compById)) {
          const def = ci.def; if (!def) continue;
          const world = pin => { const c = ci.conns[pin]; return c ? c.wires.length + c.cb.length : 0; };
          const isFed = pin => fed.has(id + '|' + pin) || world(pin) > 0;
          const name = isPart ? `${label} (${def.alias})` : `${label} ${def.alias} ${id}`;
          if (needsBoth.test(def.alias) && !/^(or|xor)$/.test(def.alias)) { const a = isFed('signal_in1'), b = isFed('signal_in2'); if (a !== b) W(`${name}: only ${a ? 'signal_in1' : 'signal_in2'} is wired; ${/^(and|greater|equals)$/.test(def.alias) ? def.alias + " can never be true, so it sends FalseOutput forever" : def.alias + " needs both inputs, so it never outputs anything"}`); }
          if (def.alias === 'regex') {
            const ex = String(ci.comp.p.Expression || '');
            try { new RegExp(ex.replace(/\(\?i\)/g, '')); } catch (e) { this.errors.push(`${name}: regex "${ex}" is invalid (${e.message})`); }
            if (/(^|[^\\[a-z])d[+*]/.test(ex) && !/\\d/.test(ex)) W(`${name}: regex "${ex}" has "d+": in .circ a backslash escapes the next character, so \\d arrives as d. Use [0-9]+`);
          }
          const outs = def.outs;
          if (def.alias !== 'wifi' && outs.length && !outs.some(o => used.has(id + '|' + o) || world(o) > 0)) W(`${name}: its output goes nowhere`);
        }
      }
      const chans = {}; for (const w of this.wifis) { const ch = w.p.Channel; chans[ch] = chans[ch] || { tx: 0, rx: 0 }; if (w.isWired('signal_out')) chans[ch].rx++; chans[ch].tx++; }
      for (const [ch, c] of Object.entries(chans)) if (c.rx === 0 && !this.wifis.some(w => w.p.Channel === ch && String(w.p.LinkToChat).toLowerCase() === 'true')) W(`wifi channel ${ch}: nobody listens (no wifi on it has signal_out wired)`);
    }
    // runtime check: a latching input that gets two different values in the same tick keeps whichever arrived last,
    // which depends on wiring order. Reported once per input with the values and how many ticks it happened.
    deliver(conn, sig) {
      const it = conn.item, lat = it.def ? latches(it.def.alias, conn.pin) : /^dev:/.test(it.name) && LATCHING.test(conn.pin);
      if (lat) {
        if (conn.seenF === this.frame && conn.seenV !== sig.v) {
          const k = it.name + '.' + conn.pin, c = this.conflicts[k] || (this.conflicts[k] = { n: 0, first: this.time, vals: new Set(), lastF: -1 });
          if (c.lastF !== this.frame) { c.n++; c.lastF = this.frame; } c.vals.add(conn.seenV); c.vals.add(sig.v);
        }
        conn.seenF = this.frame; conn.seenV = sig.v;
      }
      super.deliver(conn, sig);
    }
    valueOf(target) {
      const dot = target.indexOf('.'), od = dot > 0 ? this.objs[target.slice(0, dot)] : null;
      if (od && od.kind === 'dev' && !DEVICES[od.type].outs.includes(target.slice(dot + 1)) && !DEVICES[od.type].ins.includes(target.slice(dot + 1))) { const f = od.s[target.slice(dot + 1)]; return f === undefined ? '' : typeof f === 'number' ? String(Math.round(f * 1000) / 1000) : String(f); } // gun.shots, eng.force...
      const o = this.objs[target];
      if (o && o.kind === 'dev') { const s = o.s; return o.type === 'display' ? s.text : o.type === 'terminal' ? (s.lines[s.lines.length - 1] || '') : o.type === 'probe' ? (s.last || '') : /light|switch|door|dock/.test(o.type) ? (s.on ? 'on' : 'off') : o.type === 'engine' ? String(Math.round(s.force || 0)) : o.type === 'turret' ? String(s.shots || 0) : o.type === 'pump' ? String(Math.round(s.speed || 0)) : s.value; }
      const c = this.ep(target, 0, true); return c ? (c.last === undefined ? '' : String(c.last)) : undefined;
    }
    // a crew member says something on a radio channel: every LinkToChat wifi on it passes it to signal_out
    say(ch, text) {
      ch = String(ch); this.chat.push({ t: this.time, ch, text, crew: true }); this.log.push(`${this.time.toFixed(2)}s radio ch${ch} (crew): ${text}`);
      for (const w of this.wifis) if (w.p.Channel === ch && String(w.p.LinkToChat).toLowerCase() === 'true' && w.isWired('signal_out')) this.itemSend(w.item, { v: text, steps: 0, src: null }, this.conn(w.item, 'signal_out'));
    }
    step() {
      while (this.evI < this.ev.length && this.time >= this.ev[this.evI].t) {
        const e = this.ev[this.evI++], o = this.objs[e.target];
        if (e.act === 'say') { this.say(e.target.replace(/^ch/, '') || '0', e.value); continue; }
        if (!o || o.kind !== 'dev') { this.errors.push(`line ${e.ln}: "${e.target}" is not a device`); continue; }
        o.act(e.act, e.value);
      }
      if (this.pending.length) { const p = this.pending; this.pending = []; if (p.length > 50) this.warns.push(`${this.time.toFixed(2)}s: ${p.length} signals delayed a tick (a chain or loop longer than 10 hops)`); for (const e of p) this.connSend(e.conn, e.sig); }
      for (const o of this.devs) o.update();
      for (const box of this.boxes) for (const ci of box.comps) if (ci.comp.update) ci.comp.update(STEP);
      for (const w of this.watched) if (w.conn && w.conn.last !== w.last) { w.last = w.conn.last; this.trace.push(`${this.time.toFixed(2)}s ${w.name} = "${w.last}"`); if (this.trace.length > 2000) this.trace.splice(0, 1000); }
      this.frame++; this.time = this.frame * STEP;
      while (this.exI < this.ex.length && this.time >= this.ex[this.exI].t) {
        const x = this.ex[this.exI++], got = this.valueOf(x.target); let ok;
        const n = Number(got), m = Number(x.value);
        if (x.op === '=') ok = got === x.value || (Number.isFinite(n) && Number.isFinite(m) && Math.abs(n - m) < 1e-6);
        else if (x.op === '!=') ok = got !== x.value; else if (x.op === '>') ok = n > m; else if (x.op === '<') ok = n < m; else if (x.op === '~') ok = new RegExp(x.value).test(got || ''); else ok = false;
        this.results.push({ ok, msg: `t=${x.t}s ${x.target} ${x.op} ${x.value}: ${ok ? 'ok' : 'FAILED (got "' + got + '")'}` });
      }
      // divide by zero: the game drops NaN/Infinity, so the output silently freezes at its last value
      if (this.frame % 30 === 0) for (const box of this.boxes) for (const ci of box.comps) {
        const c = ci.comp, nm = () => `${box.model.name.replace('part:', 'part ')} ${ci.def.alias} ${ci.id}`;
        if (ci.def.alias === 'div' && c.r && Math.abs(c.r[1]) < 1e-6 && c.t[1] < 0.5 && !ci.nanWarned) { ci.nanWarned = true; this.warns.push(`${this.time.toFixed(2)}s ${nm()}: divides by zero, so it sends nothing (the game drops NaN) and whatever reads it keeps a stale value`); }
        const o = ci.conns.signal_out; if (o && /^(NaN|Infinity|-Infinity)$/.test(String(o.last)) && !ci.nanWarned) { ci.nanWarned = true; this.warns.push(`${this.time.toFixed(2)}s ${nm()}: output is ${o.last}`); }
      }
    }
    get done() { return this.time >= this.spec.duration; }
    // warnings found while running: inputs that got two different values in one tick
    conflictWarnings() {
      return Object.entries(this.conflicts).map(([k, c]) => {
        const nm = k.replace(/^dev:/, '').replace(/^part:([^/]+)\/0/, 'part $1').replace('/', ' part '), vals = [...c.vals].slice(0, 4).map(v => JSON.stringify(v)).join(' vs ');
        return `${c.first.toFixed(2)}s ${nm}: got different values in one tick (${vals}) on ${c.n} tick${c.n > 1 ? 's' : ''}; the game keeps whichever arrives last`;
      });
    }
    get allWarnings() { return [...new Set([...this.warns, ...this.conflictWarnings()])]; }
    // end of the script: check expectwarn/expecterror (a pitfall demo passes when the sandbox catches the pitfall)
    finish() {
      if (this.finished) return; this.finished = true;
      const warns = this.allWarnings;
      for (const m of this.spec.msgExpects) {
        const list = m.kind === 'warning' ? warns : this.errors, re = new RegExp(m.re, 'i'), hit = list.filter(e => re.test(e));
        this.results.push({ ok: hit.length > 0, msg: `${m.kind} /${m.re}/: ${hit.length ? 'caught' : 'FAILED (not reported)'}` });
        if (m.kind === 'error') this.expectedErrors = (this.expectedErrors || []).concat(hit);
      }
    }
    run() { while (!this.done) this.step(); this.finish(); return this.report(); }
    // errors nobody expected (expecterror lines excuse theirs)
    get unexpectedErrors() { const ok = new Set(this.expectedErrors || []); return this.errors.filter(e => !ok.has(e)); }
    report() {
      const L = [`# sandbox "${this.spec.name}" ran ${this.spec.duration}s`];
      if (this.errors.length) L.push('ERRORS:', ...this.errors.map(e => '  ' + e));
      { const w = this.allWarnings; if (w.length) L.push('WARNINGS:', ...w.map(e => '  ' + e)); }
      if (this.trace.length) L.push('TRACE (watched pins, changes only):', ...this.trace.map(e => '  ' + e));
      if (this.log.length) L.push('DEVICES:', ...this.log.slice(-400).map(e => '  ' + e));
      const chat = (this.chat || []).filter(c => !c.crew); if (chat.length) L.push('RADIO CHAT (LinkToChat wifi):', ...chat.map(c => `  ${c.t.toFixed(2)}s ch${c.ch}: ${c.text}`));
      const fin = Object.entries(this.objs).filter(([, o]) => o.kind === 'dev').map(([id]) => `${id}=${JSON.stringify(this.valueOf(id))}`);
      if (fin.length) L.push('FINAL: ' + fin.join('  '));
      if (this.results.length) L.push('EXPECT:', ...this.results.map(r => '  ' + r.msg), `${this.results.filter(r => r.ok).length}/${this.results.length} passed`);
      return L.join('\n');
    }
  }
  return { parse, Sandbox, DEVICES, HELP, run: (text, opts) => { const sb = new Sandbox(parse(text, opts)); return { sb, report: sb.run() }; } };
});
