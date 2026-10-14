#!/usr/bin/env node
// Usage: see AIHowTo.md.  node sim/cli.js <command> [args]
'use strict';
const fs = require('fs'), path = require('path');
const F = require('./format'), E = require('./engine'), P = require('./project');
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
  if (a.batteries !== undefined) { const n = Number(a.batteries); c.batteries.enabled = n > 0; if (n > 0) c.batteries.count = n; }
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
  const pinsFile = file.replace(/(_reactor)?\.(txt|circ)$/, '.pins');
  return P.loadModel(read(file), path.basename(file), batteryFile ? read(batteryFile) : null, fs.existsSync(pinsFile) ? read(pinsFile) : null);
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
  const vals = P.placeholders(cfg);
  const sim = new E.Sim(P.substitute(model, vals), cfg);
  const r = sim.runToEnd();
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
  const cols = ['circuit', 'profile', 'score_reliability', ...(batt ? ['score_battery', 'battery_soc_avg_pct', 'battery_full_s', 'battery_empty_s', 'kwh_per_rod_adjusted'] : ['kwh_per_rod']), 'unmet_pct', 'voltage_mean_abs_dev', 'fluctuation_events', 'brownout_s_v_lt_0_9', 'overvolt_s_v_gt_1_1', 'temp_max', 'meltdown_at_s'];
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
  // verify <trace.csv>: replay a ReactorTrace recorded in game and show where the simulator differs
  verify(a) { const f = resolve(a._[0], ['load_profiles', 'traces']); process.stdout.write(require('./verify').verify(read(f))); },
  profiles() { for (const p of listProfiles({})) { const pr = E.parseProfile(read(p), path.basename(p)); const d = pr.points.map(x => x.demand); console.log(`${path.basename(p, '.csv')} dur=${pr.duration.toFixed(0)}s max_kw=${pr.reactorMaxKW || '?'} sub=${pr.meta.sub || '?'} demand=${Math.min(...d).toFixed(0)}..${Math.max(...d).toFixed(0)}`); } },
};

const a = args(process.argv.slice(3));
const cmd = COMMANDS[process.argv[2]];
if (!cmd) { console.log('commands: ' + Object.keys(COMMANDS).join(', ') + '  (see AIHowTo.md)'); process.exit(1); }
try { cmd(a); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
