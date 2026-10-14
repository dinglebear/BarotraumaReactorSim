#!/usr/bin/env node
// Usage: see AIHowTo.md.  node sim/cli.js <command> [args]
'use strict';
const fs = require('fs'), path = require('path');
const F = require('./format'), E = require('./engine'), P = require('./project'), A = require('./autopins');
const ROOT = path.resolve(__dirname, '..');
const rel = p => path.relative(ROOT, p) || '.';
const read = p => fs.readFileSync(p, 'utf8');

function args(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; } else o._.push(a); } return o; }
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
    console.log(`ok: ${m.boxes.map(b => `${b.name}(${b.components.length} comps, ${b.wires.length} wires)`).join(' ')}` + (s.warnings.length ? '\n' + s.warnings.join('\n') : ''));
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
  // verify <trace.csv>: replay a ReactorTrace recorded in game and show where the simulator differs
  verify(a) { const f = resolve(a._[0], ['traces', 'load_profiles']); process.stdout.write(require('./verify').verify(read(f), { from: a.from != null ? Number(a.from) : null, mode: a.physics ? 'physics' : a.autotemp ? 'autotemp' : null, debug: a.debug ? String(a.debug).split('-').map(Number) : null })); },
  profiles() { for (const p of listProfiles({})) { const pr = E.parseProfile(read(p), path.basename(p)); const d = pr.points.map(x => x.demand); console.log(`${path.basename(p, '.csv')} dur=${pr.duration.toFixed(0)}s max_kw=${pr.reactorMaxKW || '?'} sub=${pr.meta.sub || '?'} demand=${Math.min(...d).toFixed(0)}..${Math.max(...d).toFixed(0)}`); } },
};

const a = args(process.argv.slice(3));
const cmd = COMMANDS[process.argv[2]];
if (!cmd) { console.log('commands: ' + Object.keys(COMMANDS).join(', ') + '  (see AIHowTo.md)'); process.exit(1); }
try { cmd(a); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
