// Checks the simulator against the real game: replays a ReactorTrace CSV (mod/ReactorPowerLogger/.../reactortrace.lua)
// through the simulator's reactor, driven by the recorded load, rods, AutoTemp/power state, operator skill and condition
// (and the player's sliders while AutoTemp is off), then compares temperature, fission, turbine, output and timers.
'use strict';
const E = require('./engine');

function parseTrace(text) {
  const all = text.split(/\r?\n/);
  const meta = {}; for (const l of all) { const m = /^#\s*([\w.]+)\s*=\s*(.*)$/.exec(l); if (m) meta[m[1]] = m[2].trim(); }
  const lines = all.filter(l => l.trim() && !l.startsWith('#'));
  const cols = lines[0].split(',');
  let rows = lines.slice(1).map(l => {
    const p = l.split(','), r = {};
    cols.forEach((c, i) => { const v = p[i] === undefined ? '' : p[i]; r[c] = (c === 'rod_cond' || c === 'event') ? v : (v === '' ? null : Number(v)); });
    return r;
  });
  // A PowerLogger round file (has "demand") also records the reactor: use it as a coarse trace.
  // It doesn't record AutoTemp/power/targets, so AutoTemp is assumed on and the targets are left to the simulator.
  if (cols.includes('demand')) {
    const prof = E.parseProfile(text, 'x'); const rf = new Map(prof.points.map(p => [p.t + (rows[0] ? rows[0].t : 0), p.rodFuel]));
    const id = Object.keys(E.FUEL_IDS).find(k => E.FUEL_IDS[k] === (meta.fuel_type || 'uranium')) || 'fuelrod';
    const max = Number(meta.reactor_max_kw) || 5000, rodMax = (E.FUEL[meta.fuel_type] || E.FUEL.uranium).cond;
    const hasCtl = cols.includes('autotemp') && cols.includes('target_fission');
    rows = rows.map(r => {
      // rods with fuel left: newer logs record avail_fuel directly; older ones only have the summed condition %
      const per = rf.get(r.t) || (E.FUEL[meta.fuel_type] || E.FUEL.uranium).fuel;
      const rid = Object.keys(E.FUEL_IDS).find(k => E.FUEL[E.FUEL_IDS[k]].fuel === per) || id;
      const active = r.avail_fuel != null ? Math.round(r.avail_fuel / per) : (r.rods || 0);
      const conds = Array.from({ length: r.rods || 0 }, (x, i) => i < active ? Math.max(0.1, r.fuel / Math.max(1, active) / 100 * rodMax) : 0);
      return { t: r.t, temp: r.temp, fission: r.fission, turbine: r.turbine, load: r.load, output: r.reactor_out, max_kw: max, rods: r.rods, perRodFuel: per,
        rod_cond: conds.map(c => `${rid}:${c.toFixed(1)}`).join(' '),
        autotemp: hasCtl ? r.autotemp : 1, power_on: hasCtl ? r.power_on : 1, target_fission: hasCtl ? r.target_fission : null, target_turbine: hasCtl ? r.target_turbine : null,
        event: '', powerlog: true, hasCtl };
    });
  }
  return rows;
}
function rodsFrom(s) { // "fuelrod:87.2 thoriumfuelrod:200.0"
  return String(s || '').trim().split(/\s+/).filter(Boolean).map(x => { const [id, c] = x.split(':'); const t = E.FUEL[E.FUEL_IDS[id]] || E.FUEL.uranium; return { fuel: E.FUEL_IDS[id] ? t.fuel : 0, cond: Number(c), max: t.cond }; });
}

function verify(text, opts) {
  opts = opts || {};
  let rows = parseTrace(text);
  // physics mode: drive fission and turbine from the recording (works under ANY control: AutoTemp, manual, circuit)
  // and check the temperature and power output the simulator's physics produces. Default for round logs without control columns.
  const physics = opts.mode === 'physics' || (opts.mode !== 'autotemp' && rows[0] && rows[0].powerlog && !rows[0].hasCtl);
  if (opts.from != null) rows = rows.filter(r => r.t >= opts.from);
  else if (rows[0] && rows[0].powerlog) { const k = rows.findIndex(r => r.temp > 1); if (k > 0) rows = rows.slice(k); } // skip the time the reactor was off
  if (rows.length < 2) throw new Error('trace has no rows');
  const r0 = rows[0], t0 = r0.t;
  const profile = { name: 'trace', points: rows.map(r => ({ t: r.t - t0, demand: Math.max(0, r.load || 0), ch: {} })), duration: rows[rows.length - 1].t - t0, channels: [], meta: {} };
  let idx = 0, lastRods = null;
  const cfg = { roundTimeOffset: t0, profile, reactorMaxKW: r0.max_kw, rods: Math.max(1, r0.rods || 1), recordedRods: true, fuelDrain: true, start: 'cold', wear: false, vanilla: false,
    beforeTick(sim) {
      const t = sim.time + t0;
      while (idx + 1 < rows.length && rows[idx + 1].t <= t) idx++;
      const r = rows[idx], R = sim.reactor;
      if (physics) {
        const n = rows[idx + 1], k = n && n.t > r.t ? Math.min(1, (t - r.t) / (n.t - r.t)) : 0, lp = (a, b) => a + ((b ?? a) - a) * k;
        R.autoTemp = false; R.powerOn = true; R.sigF = R.sigT = null;
        R.fission = R.tf = lp(r.fission, n && n.fission); R.turbine = R.tt = lp(r.turbine, n && n.turbine);
      } else {
      R.autoTemp = r.autotemp === 1; R.powerOn = r.power_on === 1;
      }
      if (r.dos != null) R.dos = r.dos;
      if (r.temp_boost != null) R.boost = r.temp_boost; // player's temperature boost buttons
      if (r.condition != null) R.cond = r.condition; // condition (wear, repairs, fire damage) taken from the game
      if (r.rod_cond !== lastRods) { // rods inserted/removed/swapped: take the game's rods
        const rods = rodsFrom(r.rod_cond), prevR = rodsFrom(lastRods);
        const changed = lastRods === null || rods.length !== prevR.length || (rods[0] && prevR[0] && rods[0].fuel !== prevR[0].fuel)
          || rods.some((r, i) => prevR[i] && r.cond - prevR[i].cond > 5); // a fresh rod swapped in at the same count
        if (changed) { R.rods = rods; R.availFuel = sim.rodFuel(); }
        lastRods = r.rod_cond;
      }
      if (r.sig_fission != null) { R.sigF = r.sig_fission; R.lastF = sim.time; }
      if (r.sig_turbine != null) { R.sigT = r.sig_turbine; R.lastT = sim.time; }
      // player at the sliders: targets come from the game, everything else is simulated
      if (physics) return;
      if (!R.autoTemp && r.sig_fission == null && r.target_fission != null) R.tf = r.target_fission;
      if (!R.autoTemp && r.sig_turbine == null && r.target_turbine != null) R.tt = r.target_turbine;
    } };
  const sim = new E.Sim({ name: 'trace', boxes: [], links: [] }, cfg);
  const R = sim.reactor;
  Object.assign(R, { temp: r0.temp, fission: r0.fission, turbine: r0.turbine, tf: r0.target_fission ?? r0.fission, tt: r0.target_turbine ?? r0.turbine, cto: r0.correct_turbine ?? r0.load / r0.max_kw * 100, load: r0.load,
    melt: r0.meltdown_timer || 0, fire: r0.fire_timer || 0, dos: r0.dos || 0, cond: r0.condition == null ? 100 : r0.condition });
  R.rods = rodsFrom(r0.rod_cond).length ? rodsFrom(r0.rod_cond) : R.rods; R.availFuel = R.prevAvailFuel = sim.rodFuel(); lastRods = r0.rod_cond;
  sim.metrics.reset();
  const VARS = physics ? [['temp', 'temp'], ['output', 'cpc']] : [['temp', 'temp'], ['fission', 'fission'], ['turbine', 'turbine'], ['target_fission', 'tf'], ['target_turbine', 'tt'], ['output', 'cpc'], ['meltdown_timer', 'melt'], ['fire_timer', 'fire']];
  const err = {}; for (const [k] of VARS) err[k] = { sum2: 0, max: 0, at: null, n: 0 };
  let firstDiverge = null; const gameEvents = [], simEvents = [];
  for (const r of rows) {
    while (sim.time + t0 < r.t - 1e-9 && sim.time < profile.duration) sim.step();
    if (r.event) gameEvents.push(`[${(r.t - t0).toFixed(1)}s] ${r.event}`);
    if (opts.debug && r.t >= opts.debug[0] && r.t <= opts.debug[1]) console.log(`t=${r.t.toFixed(2)} game temp=${(+r.temp).toFixed(1)} fis=${(+r.fission).toFixed(1)} turb=${(+r.turbine).toFixed(1)} rods=${r.rods} [${r.rod_cond}] | sim temp=${R.temp.toFixed(1)} fis=${R.fission.toFixed(1)} turb=${R.turbine.toFixed(1)} fuel=${R.availFuel} rods=${R.rods.length}`);
    for (const [k, sk] of VARS) {
      if (r[k] == null) continue;
      const sv = sk === 'cpc' ? -R.cpc : R[sk], d = Math.abs(sv - r[k]);
      const e = err[k]; e.sum2 += d * d; e.n++; if (d > e.max) { e.max = d; e.at = r.t - t0; }
      if (k === 'temp' && d > 5 && !firstDiverge) firstDiverge = { t: +(r.t - t0).toFixed(1), game: r[k], sim: +sv.toFixed(2), row: r };
    }
  }
  for (const e of sim.metrics.events) if (!/brownout/.test(e)) simEvents.push(e);
  const L = ['variable\trms_error\tmax_error\tat_s'];
  for (const [k] of VARS) { const e = err[k]; if (e.n) L.push(`${k}\t${Math.sqrt(e.sum2 / e.n).toFixed(3)}\t${e.max.toFixed(3)}\t${e.at == null ? '-' : e.at.toFixed(1)}`); }
  L.push(firstDiverge ? `FIRST DIVERGENCE (temp off by > 5): t=${firstDiverge.t}s game=${firstDiverge.game} sim=${firstDiverge.sim} (rods=${firstDiverge.row.rods} autotemp=${firstDiverge.row.autotemp} load=${firstDiverge.row.load})` : 'temperature stayed within 5 of the game the whole trace');
  L.push('GAME EVENTS:' + (gameEvents.length ? '\n  ' + gameEvents.slice(0, 40).join('\n  ') : ' none'));
  L.push('SIM EVENTS:' + (simEvents.length ? '\n  ' + simEvents.slice(0, 40).join('\n  ') : ' none') + `\n  sim fires=${sim.metrics.fires} meltdown=${sim.metrics.meltdownAt == null ? 'no' : sim.metrics.meltdownAt.toFixed(1) + 's'}`);
  L.unshift(physics ? 'MODE physics: fission and turbine taken from the recording (any control); checking temperature and output'
    : 'MODE control: ' + (rows[0].powerlog && !rows[0].hasCtl ? 'AutoTemp assumed on (round log has no control columns)' : 'control state from the recording'));
  return L.join('\n') + '\n';
}
module.exports = { verify, parseTrace };
