#!/usr/bin/env node
// Usage: see AIHowTo.md.  node sim/cli.js <command> [args]
'use strict';
const fs = require('fs'), path = require('path');
const F = require('./format'), E = require('./engine'), P = require('./project'), A = require('./autopins');
const ROOT = path.resolve(__dirname, '..');
const rel = p => path.relative(ROOT, p) || '.';
const read = p => fs.readFileSync(p, 'utf8');

function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = k in o ? [].concat(o[k], v) : v; } else o._.push(a); } return o; }
// settings: sim.config.json (also exportable from the web bench), overridden by flags
function loadConfig(a) {
  const file = path.join(ROOT, 'sim.config.json');
  const c = fs.existsSync(file) ? JSON.parse(read(file)) : {};
  c.batteries = c.batteries || {};
  if (a.max) c.reactorMaxKW = Number(a.max);
  if (a.rods) c.rods = Number(a.rods);
  if (a.fuel) c.fuelType = a.fuel;
  if (a.skill) c.skill = Number(a.skill);
  if (a.start) c.start = a.start;
  if (a.link) c.linkMode = a.link;
  if (a.seed) c.seed = Number(a.seed);
  if (a.batteries === 'ship') { c.batteries.enabled = true; c.batteries.ship = true; } // the recorded ship's own batteries
  else if (a.batteries !== undefined) { const n = Number(a.batteries); c.batteries.enabled = n > 0; c.batteries.ship = false; if (n > 0) c.batteries.count = n; }
  if (a['recorded-rods']) c.recordedRods = true; // replay the round's rods instead of the --rods setting
  if (a['fuel-drain']) c.fuelDrain = true;       // rods run down and can run out
  if (a.btype) c.batteries.type = a.btype;
  return c;
}
function resolve(p, dirs) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  for (const d of dirs) for (const ext of ['', '.circ', '.txt', '.csv', '_reactor.txt']) { const q = path.join(ROOT, d, p + ext); if (fs.existsSync(q)) return q; }
  throw new Error('file not found: ' + p);
}
const CIRC_DIRS = ['circuits', 'context/community_circuits', 'context/reactor_circuits'];
function loadModel(file, batteryFile) {
  if (!batteryFile && file.endsWith('_reactor.txt')) { const b = file.replace(/_reactor\.txt$/, '_battery.txt'); if (fs.existsSync(b)) batteryFile = b; }
  const pinsFile = [file.replace(/\.(txt|circ)$/, '.pins'), file.replace(/(_reactor)?\.(txt|circ)$/, '.pins')].find(p => fs.existsSync(p)) || '';
  return P.loadModel(read(file), path.basename(file), batteryFile ? read(batteryFile) : null, fs.existsSync(pinsFile) ? read(pinsFile) : null);
}
// In-game circuits (.txt) often don't say which pin goes where. Check the pins (.pins file, labels or default harness) on a
// short load-step test; if the reactor doesn't run well, move pins around by trial and error and save what works to <name>.pins.
const pinMemo = {};
function autoPins(model, file, cfg, a) {
  if (!file || !file.endsWith('.txt') || a['no-autopins']) return null;
  const key = file + '|' + cfg.reactorMaxKW + '|' + !!a.force;
  let res = pinMemo[key];
  if (!res) {
    res = pinMemo[key] = A.solve(model, cfg, { guess: E.guessPins, force: !!a.force });
    if ((res.initialWorks && !a.force) || res.cost >= res.initialCost - 0.01) return res.saved = null, null;
    const pf = file.replace(/\.txt$/, '.pins'), old = fs.existsSync(pf) ? read(pf) : '';
    if (old) fs.writeFileSync(pf + '.bak', old);
    const keep = old.split(/\r?\n/).filter(l => /^\s*prop\s/.test(l)).join('\n');
    fs.writeFileSync(pf, A.pinsText(res, old ? `(old file: ${path.basename(pf)}.bak)` : '') + (keep ? keep + '\n' : ''));
    res.saved = rel(pf);
  }
  if (!res.saved) return null;
  for (const b of model.boxes) if (res.pins[b.name]) b.pins = res.pins[b.name];
  return `pins found by trial and error (${res.log[res.log.length - 1]}): ${res.changed.join(', ') || 'no change'}; saved to ${res.saved}`;
}
function exportTxt(model, file, vals) {
  if (!file.endsWith('.circ')) return [];
  return P.exportBoxes(model, vals).map(o => { const p = path.join(path.dirname(file), o.filename); fs.writeFileSync(p, o.text); return rel(p); });
}

function runOne(circuitFile, profileFile, a, quiet) {
  const cfg = loadConfig(a);
  const prof = E.parseProfile(read(profileFile), path.basename(profileFile).replace(/\.csv$/, ''));
  if (a.duration) prof.duration = Math.min(prof.duration, Number(a.duration));
  const model = circuitFile ? loadModel(circuitFile, a.battery && resolve(a.battery, CIRC_DIRS)) : { name: 'vanilla_autotemp', boxes: [], links: [] };
  const maxKW = cfg.reactorMaxKW || prof.reactorMaxKW || 5000;
  Object.assign(cfg, { reactorMaxKW: maxKW, profile: prof, circuitName: model.name });
  if (!circuitFile) cfg.vanilla = true;
  const pinNote = autoPins(model, circuitFile, cfg, a);
  if (pinNote && !quiet) console.log(pinNote);
  const vals = P.placeholders(cfg);
  const sim = new E.Sim(P.substitute(model, vals), cfg);
  const r = sim.runToEnd();
  if (pinNote) r.warnings = [pinNote, ...(r.warnings || [])];
  if (circuitFile && !quiet) r.exported = exportTxt(model, circuitFile, vals).join(',');
  const name = `${model.name}__${prof.name}`;
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const logFile = path.join(ROOT, 'logs', name + '.log');
  fs.writeFileSync(logFile, P.fmtReport(r));
  if (a.timeline) fs.writeFileSync(path.join(ROOT, 'logs', name + '.timeline.csv'), P.timelineCsv(sim.metrics.timeline));
  if (!quiet) { process.stdout.write(P.fmtReport(r)); console.log('log: ' + rel(logFile)); }
  return r;
}
function listProfiles(a) {
  if (a.profile && a.profile !== 'all') return String(a.profile).split(',').map(p => resolve(p, ['load_profiles']));
  const d = path.join(ROOT, 'load_profiles');
  return fs.readdirSync(d).filter(f => f.endsWith('.csv')).sort().map(f => path.join(d, f));
}
function printTable(rows) {
  const batt = rows.some(r => r.score_battery != null);
  const cols = ['circuit', 'profile', 'score_reliability', 'unmet_avoidable_pct', 'unmet_unavoidable_pct', ...(batt ? ['score_battery', 'battery_soc_avg_pct', 'battery_full_s', 'battery_empty_s', 'kwh_per_rod_adjusted'] : ['kwh_per_rod']), 'unmet_pct', 'voltage_mean_abs_dev', 'fluctuation_events', 'brownout_s_v_lt_0_9', 'overvolt_s_v_gt_1_1', 'temp_max', 'meltdown_at_s'];
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map(c => r[c] === null || r[c] === undefined ? '-' : r[c]).join('\t'));
  const w = [...new Set(rows.flatMap(r => r.warnings || []))]; if (w.length) console.log('WARNINGS:\n  ' + w.join('\n  '));
  console.log('(full logs in logs/<circuit>__<profile>.log)');
}
const circ = n => n === 'vanilla' ? null : resolve(n, CIRC_DIRS);

const COMMANDS = {
  // run <circuit|vanilla> [--profile name|a,b|all]
  run(a) {
    const profs = listProfiles(a), c = circ(a._[0] || 'vanilla');
    if (profs.length === 1) return runOne(c, profs[0], a);
    printTable(profs.map(p => runOne(c, p, a, true)));
  },
  // compare a,b,vanilla [--profile all]
  compare(a) { const rows = []; for (const n of a._[0].split(',')) for (const p of listProfiles(a)) rows.push(runOne(circ(n), p, a, true)); printTable(rows); },
  build(a) { const f = resolve(a._[0], ['circuits']); console.log(exportTxt(F.parseCirc(read(f)), f, P.placeholders(loadConfig(a))).join('\n')); },
  decompile(a) { const f = resolve(a._[0], CIRC_DIRS); process.stdout.write(F.toCirc(loadModel(f, a.battery && resolve(a.battery, CIRC_DIRS)))); },
  check(a) {
    const f = resolve(a._[0], CIRC_DIRS), m = loadModel(f), cfg = loadConfig(a); cfg.start = 'cold';
    const s = new E.Sim(P.substitute(m, P.placeholders(cfg)), cfg);
    const big = m.boxes.filter(b => b.components.length > 64).map(b => `box ${b.name}: ${b.components.length} components, but an in-game circuit box holds at most 64 (the rest are lost on load): split it`);
    console.log(`${big.length ? 'TOO BIG' : 'ok'}: ${m.boxes.map(b => `${b.name}(${b.components.length} comps, ${b.wires.length} wires)`).join(' ')}` + ([...big, ...s.warnings].length ? '\n' + [...big, ...s.warnings].join('\n') : ''));
  },
  // autopins <circuit.txt> [--force]: find which pin goes where by trial and error, write <name>.pins
  autopins(a) {
    const f = resolve(a._[0], CIRC_DIRS), m = loadModel(f), cfg = loadConfig(a);
    cfg.reactorMaxKW = cfg.reactorMaxKW || 5000;
    const res = A.solve(m, cfg, { guess: E.guessPins, force: !!a.force });
    console.log(res.log.join('\n') + (res.changed.length ? '\nchanges: ' + res.changed.join(', ') : ''));
    process.stdout.write(A.pinsText(res));
    if (a.write || !fs.existsSync(f.replace(/\.txt$/, '.pins'))) { const pf = f.replace(/\.(txt|circ)$/, '.pins'); if (fs.existsSync(pf)) fs.writeFileSync(pf + '.bak', read(pf)); fs.writeFileSync(pf, A.pinsText(res)); console.log('saved ' + rel(pf)); }
  },
  // ship <sub name or .sub file> [--circuit name] [--battery-circuit name] [--duration s] [--no-fights] [--breach s] [--summary]
  // practice round on a whole sub (ships/vanilla/*.sub, ships/custom/*.sub); the circuit is wired into its reactor/junction/batteries/nav
  ship(a) {
    const zlib = require('zlib'), SF = require('./subfile'), SH = require('./ship');
    const name = a._[0] || 'Dugong', f = [name, `ships/vanilla/${name}.sub`, `ships/custom/${name}.sub`].map(x => path.isAbsolute(x) ? x : path.join(ROOT, x)).find(x => fs.existsSync(x) && fs.statSync(x).isFile());
    if (!f) throw new Error(`no sub "${name}" (looked in ships/vanilla and ships/custom)`);
    const buf = fs.readFileSync(f), ship = SF.parseSub((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'));
    if (a.summary) { console.log(SF.summary(ship)); return; }
    const cfg = loadConfig(a);
    const sim = new SH.ShipSim(ship, { duration: Number(a.duration) || 600, rods: cfg.rods, fuelType: cfg.fuelType, start: cfg.start, seed: cfg.seed,
      scenario: { fights: !a['no-fights'], breachAt: a.breach != null ? Number(a.breach) : null, breachHull: a['breach-hull'] != null ? String(a['breach-hull']) : null,
        fireAt: a.fire != null ? Number(a.fire) : null, fireHull: a['fire-hull'] != null ? String(a['fire-hull']) : null, crew: a.crew != null ? Number(a.crew) : 4,
        radio: [].concat(a.radio || []).map(s => { const m = /^(\d+(?:\.\d+)?):(.*)$/.exec(String(s)); return m ? { t: Number(m[1]), text: m[2] } : { t: 1, text: String(s) }; }),
        type: [].concat(a.type || []).map(s => { const m = /^(\d+(?:\.\d+)?):(.*)$/.exec(String(s)); return m ? { t: Number(m[1]), text: m[2] } : { t: 1, text: String(s) }; }) } });
    let model = null;
    if (a.circuit) model = loadModel(resolve(a.circuit, CIRC_DIRS), a['battery-circuit'] && resolve(a['battery-circuit'], CIRC_DIRS));
    if (model) { const sum = k => sim.batteries.reduce((x, b) => x + b[k], 0); sim.attachCircuit(P.substitute(model, { MAX: sim.reactor.maxPower, BATT_N: sim.batteries.length, BATT_KW: sum('maxRecharge'), BATT_OUT: sum('maxOut'), BATT_CAP: sum('capacity') })); }
    sim.cfg.circuitName = model ? model.name : sim.reactor.autoTemp ? 'crew_autotemp' : 'own_circuits';
    const r = sim.runToEnd(); r.profile = ship.name + '_practice'; r.warnings = sim.warnings;
    const out = path.join(ROOT, 'logs', `${r.circuit}__${r.profile}.log`); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, P.fmtReport(r));
    process.stdout.write(P.fmtReport(r));
    console.log(`oxygen_min_pct=${sim.o2Min.toFixed(1)}\noxygen_generator_on_pct=${(sim.o2GenOnS / sim.time * 100).toFixed(1)}`);
    if (a.transcript) { // what the crew would see: radio chat from wifi LinkToChat, terminal lines, text displays
      for (const c of sim.chat) console.log(`CHAT [${c.t.toFixed(1)}s ch${c.ch}] ${c.crew ? '(crew) ' : ''}${c.text}`);
      for (const l of sim.termLog) console.log(`TERM#${l.id} [${l.t.toFixed(1)}s] ${l.dir} ${l.text}`);
      for (const d of sim.devs) if (d.kind === 'display') console.log(`DISPLAY#${d.it.id}: ${d.state.text}`);
    }
    console.log('log: ' + rel(out));
  },
  // export <circuit> --sub Dugong,Humpback,... : Blueprints files with that sub's values (from its .sub) -> exports/<Sub>/
  export(a) {
    const zlib = require('zlib'), SF = require('./subfile');
    const f = resolve(a._[0], CIRC_DIRS), model = loadModel(f);
    for (const name of String(a.sub || 'Dugong,Humpback,Typhon2').split(',')) {
      const sf = [`ships/vanilla/${name}.sub`, `ships/custom/${name}.sub`, name].map(x => path.isAbsolute(x) ? x : path.join(ROOT, x)).find(x => fs.existsSync(x) && fs.statSync(x).isFile());
      if (!sf) { console.log(`no sub "${name}"`); continue; }
      const buf = fs.readFileSync(sf), sh = SF.parseSub((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'));
      const R = (sh.items.find(i => i.comps.Reactor) || { comps: { Reactor: [{}] } }).comps.Reactor[0];
      const bs = sh.items.filter(i => i.comps.PowerContainer && !/supercapacitor/.test(i.identifier)).map(i => i.comps.PowerContainer[0]), sum = k => bs.reduce((x, b) => x + Number(b[k]), 0);
      const vals = { MAX: Number(R.MaxPowerOutput) || 5000, BATT_N: bs.length, BATT_KW: sum('MaxRechargeSpeed'), BATT_OUT: sum('MaxOutPut'), BATT_CAP: sum('Capacity') };
      const dir = path.join(ROOT, 'exports', sh.name); fs.mkdirSync(dir, { recursive: true });
      for (const o of P.exportBoxes(model, vals)) { fs.writeFileSync(path.join(dir, o.filename), o.text); console.log(rel(path.join(dir, o.filename)), JSON.stringify(vals)); }
    }
  },
  // sub list <sub> [filter]           items with ID, position, room and every connection (what it is wired to)
  // sub patch <sub> <patch> [-o out]  apply an edit script (SUBEDIT.md), check it, save ships/custom/<name>.sub
  // sub check <sub>                   loader checks (IDs, wires, links)
  // sub audit <sub> [--base <sub>]     everything that broke in game before: box size, loose items, items in walls, moved originals
  sub(a) {
    const zlib = require('zlib'), SE = require('./subedit'), SF = require('./subfile');
    const [what, name, arg] = a._;
    const find = nm => [nm, `ships/custom/${nm}.sub`, `ships/vanilla/${nm}.sub`].map(x => path.isAbsolute(x) ? x : path.join(ROOT, x)).find(x => fs.existsSync(x) && fs.statSync(x).isFile());
    const readSub = f => { const b = fs.readFileSync(f); return (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8'); };
    const f = what === 'templates' ? null : find(name || ''); if (!f && what !== 'templates') throw new Error(`no sub "${name}" (ships/custom, ships/vanilla or a path)`);
    const text = f ? readSub(f) : '';
    if (what === 'list') {
      const sh = SF.parseSub(text), by = new Map(sh.items.map(i => [i.id, i])), re = arg ? new RegExp(arg, 'i') : null;
      const room = it => { const cx = it.rect[0] + it.rect[2] / 2, cy = it.rect[1] - it.rect[3] / 2, h = sh.hulls.find(h => cx >= h.rect[0] && cx <= h.rect[0] + h.rect[2] && cy <= h.rect[1] && cy >= h.rect[1] - h.rect[3]); return h ? (h.name || 'hull' + h.id) : 'outside'; };
      for (const it of sh.items) {
        if (re && !re.test(it.identifier) && !re.test(it.id) && !re.test(room(it))) continue;
        const ws = sh.wires.filter(w => w.from.item === it.id || w.to.item === it.id).map(w => { const me = w.from.item === it.id ? w.from : w.to, o = me === w.from ? w.to : w.from; return `${me.conn}->${(by.get(o.item) || {}).identifier || '?'}#${o.item}.${o.conn}`; });
        const cx = Math.round(it.rect[0] + it.rect[2] / 2), cy = Math.round(it.rect[1] - it.rect[3] / 2);
        console.log(`${it.id} ${it.identifier} @${cx},${cy} [${room(it)}] conns: ${it.conns.map(c => c.name).join(',')}${ws.length ? '\n    wired: ' + ws.join(' | ') : ''}`);
      }
      return;
    }
    // item templates: the vanilla subs, then ships/templates/*.xml (vanilla items saved from other subs: sim/cli.js sub templates)
    const tdir = path.join(ROOT, 'ships/templates');
    const templates = ['Camel', 'Dugong', 'Humpback', 'Typhon2'].map(n => find(n)).filter(Boolean).filter(x => x !== f).map(x => new SE.SubDoc(readSub(x)))
      .concat(fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(x => x.endsWith('.xml')).map(x => new SE.SubDoc(readSub(path.join(tdir, x)).replace(/^\uFEFF/, ''))) : []);
    if (what === 'templates') { // sub templates <out.xml> <ident,ident,...> <source files...>: one cleaned item per identifier, first source wins
      const X = require('./subxml'), [out, list, ...srcs] = a._.slice(1), want = new Set(list.split(','));
      const items = [];
      for (const src of srcs) { const d = new SE.SubDoc(readSub(src).replace(/^\uFEFF/, '')); for (const n of d.items.values()) { const idf = X.get(n, 'identifier'); if (!want.has(idf)) continue; if (!n.children.some(k => k.tag === 'ConnectionPanel') && !/wire$/.test(idf)) continue; want.delete(idf);
        const c = X.clone(n); X.set(c, 'ID', String(items.length + 1)); const r = (X.get(c, 'rect') || '0,0,16,16').split(','); X.set(c, 'rect', `0,0,${r[2]},${r[3]}`); X.del(c, 'linked');
        const p = c.children.find(k => k.tag === 'ConnectionPanel'); if (p) for (const k of p.children) k.children = k.children.filter(l => l.tag !== 'link');
        for (const k of c.children) if (k.tag === 'ItemContainer') X.set(k, 'contained', '');
        const def = require('./components').byItem(idf), dc = def && c.children.find(k => k.tag === def.cls); if (dc) for (const [k, v] of Object.entries(def.defaults)) X.set(dc, k, v); // back to the prefab's settings
        for (const k of c.children) { if (k.tag === 'ItemLabel') X.set(k, 'Text', ''); if (k.tag === 'Terminal') X.set(k, 'WelcomeMessage', ''); }
        items.push(c); console.log(`${idf} <- ${path.basename(src)}`); } }
      if (want.size) console.log('not found: ' + [...want].join(', '));
      const root = { tag: '#root', attrs: [], children: [X.el('ItemAssembly', { name: 'vanilla item templates', description: 'One saved instance of each vanilla item the sub editor can add (connection order as saved by the game).' }, items)] };
      fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, '<?xml version="1.0" encoding="utf-8"?>\n' + X.serialize(root)); console.log(`wrote ${items.length} templates to ${out}`); return;
    }
    const doc = new SE.SubDoc(text, templates);
    if (what === 'check') { const p = doc.check(); console.log(p.length ? p.join('\n') : 'ok: no loader problems'); return; }
    if (what === 'audit') { // sub audit <sub> [--base Camel]: loader checks, box size, loose items, items in walls, moved originals, >5 wires
      const bf = a.base ? find(a.base) : null, base = bf ? new SE.SubDoc(readSub(bf)) : null;
      const r = doc.audit(base); for (const x of r) console.log(`${x.level.toUpperCase().padEnd(5)} ${x.msg}`);
      const e = r.filter(x => x.level === 'error').length, w = r.filter(x => x.level === 'warn').length;
      console.log(`${e} errors, ${w} warnings, ${r.length - e - w} notes${base ? ' (compared with ' + path.basename(bf) + ')' : ' (add --base <original sub> to spot moved items)'}`); if (e) process.exitCode = 1; return;
    }
    if (what === 'patch') {
      const ship0 = SF.parseSub(text), R = (ship0.items.find(i => i.comps.Reactor) || { comps: { Reactor: [{}] } }).comps.Reactor[0];
      const bs = ship0.items.filter(i => i.comps.PowerContainer && !/supercapacitor/.test(i.identifier)).map(i => i.comps.PowerContainer[0]), sum = k => bs.reduce((x, b) => x + Number(b[k]), 0);
      const vals = { MAX: Number(R.MaxPowerOutput) || 5000, BATT_N: bs.length, BATT_KW: sum('MaxRechargeSpeed'), BATT_OUT: sum('MaxOutPut'), BATT_CAP: sum('Capacity') };
      const readCircuit = (file, extra) => P.substitute(loadModel(resolve(file, CIRC_DIRS)), Object.assign({}, vals, extra));
      doc.apply(read(resolve(/\.\w+$/.test(arg) ? arg : arg + '.subpatch', ['.', 'ships/patches'])), { readCircuit });
      const probs = doc.check(); if (probs.length) throw new Error('loader checks failed:\n  ' + probs.join('\n  '));
      const out = a.o || a.out || path.join(ROOT, 'ships/custom', (doc.name() || 'edited').replace(/[^\w-]+/g, '_') + '.sub');
      fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, zlib.gzipSync(Buffer.from(doc.text(), 'utf8')));
      console.log(doc.log.join('\n')); console.log(`saved ${rel(out)} (${doc.items.size} items; loader checks ok)`);
      const au = doc.audit(new SE.SubDoc(text)).filter(x => x.level !== 'info'); // compared with the sub we started from
      if (au.length) console.log('AUDIT:\n' + au.map(x => `  ${x.level.toUpperCase()} ${x.msg}`).join('\n')); else console.log('audit: clean (nothing loose, nothing in walls, originals unmoved, boxes <= 64 parts)');
      const modDir = path.join(path.dirname(out), doc.name() || ''); // a ready mod folder next to it (ships/custom/<Sub Name>/) gets the new file too
      if (doc.name() && fs.existsSync(path.join(modDir, 'filelist.xml'))) { fs.copyFileSync(out, path.join(modDir, path.basename(out))); console.log(`updated mod folder ${rel(modDir)}`); }
      return;
    }
    throw new Error('sub list|patch|check');
  },
  // explain <file.sub|assembly.xml> [filter] [--all]: readable netlist of a sub's or item assembly's circuits (settings, wiring, box insides)
  explain(a) {
    const zlib = require('zlib'), f = path.resolve(a._[0] || ''); if (!fs.existsSync(f)) throw new Error('no file ' + a._[0]);
    const b = fs.readFileSync(f), text = (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^\uFEFF/, '');
    console.log(require('./explain').explain(text, { filter: a._[1], all: !!a.all }));
  },
  // verify <trace.csv>: replay a ReactorTrace recorded in game and show where the simulator differs
  verify(a) { const f = resolve(a._[0], ['traces', 'load_profiles']); process.stdout.write(require('./verify').verify(read(f), { from: a.from != null ? Number(a.from) : null, mode: a.physics ? 'physics' : a.autotemp ? 'autotemp' : null, debug: a.debug ? String(a.debug).split('-').map(Number) : null })); },
  profiles() { for (const p of listProfiles({})) { const pr = E.parseProfile(read(p), path.basename(p)); const d = pr.points.map(x => x.demand); console.log(`${path.basename(p, '.csv')} dur=${pr.duration.toFixed(0)}s max_kw=${pr.reactorMaxKW || '?'} sub=${pr.meta.sub || '?'} demand=${Math.min(...d).toFixed(0)}..${Math.max(...d).toFixed(0)}`); } },
};

const a = args(process.argv.slice(3));
const cmd = COMMANDS[process.argv[2]];
if (!cmd) { console.log('commands: ' + Object.keys(COMMANDS).join(', ') + '  (see AIHowTo.md)'); process.exit(1); }
try { cmd(a); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
