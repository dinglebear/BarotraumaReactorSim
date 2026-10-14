// Finds how a circuit box's pins connect to the ship when the file doesn't say (or says it wrong).
// Starts from the .pins file / label guess / default harness; if the reactor doesn't run well on a short test,
// it moves pins around (trial and error) and keeps whatever runs best. Scores outcomes only (power delivered,
// voltage, fires, meltdown), so any control strategy counts, e.g. fission pinned at 100 with turbine throttling.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./project'));
  else root.BaroAutoPins = factory(root.BaroEngine, root.BaroProject);
})(typeof self !== 'undefined' ? self : this, function (E, P) {
  'use strict';
  const CANDS = {
    reactor: {
      ins: ['reactor.temperature_out', 'reactor.power_value_out', 'reactor.load_value_out', 'reactor.fuel_out', 'reactor.fuel_percentage_left', 'junction.load_value_out', 'junction.power_value_out', 'const.1', 'const.0', 'none'],
      roles: ['reactor.set_fissionrate', 'reactor.set_turbineoutput'], extraOuts: ['reactor.shutdown'],
    },
    battery: {
      ins: ['battery.charge_%', 'battery.charge_rate', 'battery.charge', 'battery.power_value_out', 'battery.load_value_out', 'junction.load_value_out', 'junction.power_value_out', 'reactor.load_value_out', 'reactor.power_value_out', 'reactor.temperature_out', 'const.1', 'const.0', 'none'],
      roles: ['battery.set_rate'], extraOuts: ['battery.disable_output'],
    },
  };
  // pins the search never moves: box-to-box links and recorded devices (nav terminal etc.) that the short test can't exercise
  const isFixed = v => !!v && (v.startsWith('link.') || /^(nav|engines|pumps|guns|sonar)\./.test(v) || (v.includes('.') && !/^(reactor|junction|battery\d*|const)\./.test(v)));

  // the short test: load steps and a ramp across the reactor's range (fractions of max output), sub moving ahead
  const STEPS = [[0, .4], [25, .8], [50, .3], [75, .6], [100, .15], [120, .9], [150, .5], [170, .5]];
  function testProfile(maxKW) {
    const L = ['# reactor_max_kw=' + maxKW, 't,demand,nav.velocity_x_out,nav.velocity_y_out,nav.current_velocity_x,nav.current_velocity_y'];
    for (const [t, d] of STEPS) L.push(`${t},${Math.round(d * maxKW)},60,0,6,0`);
    return E.parseProfile(L.join('\n'), 'autopins_test');
  }
  function usedPins(box) {
    const ins = new Set(), outs = new Set(), short = p => (/^signal_((?:in|out)\d)$/.exec(p) || [, p])[1];
    for (const w of box.wires) { if (w.from.c === null) ins.add(short(w.from.pin)); if (w.to.c === null) outs.add(short(w.to.pin)); }
    const n = s => [...s].filter(p => /^(in|out)\d$/.test(p)).sort();
    return { ins: n(ins).filter(p => p.startsWith('in')), outs: n(outs).filter(p => p.startsWith('out')) };
  }
  function cost(r, fuelRef) {
    const T = Math.max(r.duration_s, 1), fuel = fuelRef ? 10 * r.fuel_condition_used / fuelRef : 0; // burning 2x vanilla's fuel costs 10
    const noSig = (r.no_fission_signal_s + r.no_turbine_signal_s) / (2 * T);
    return r.unmet_pct + 100 * r.voltage_mean_abs_dev + 20 * r.fires + (r.meltdown_at_s !== null ? 300 : 0) + 100 * r.temp_critical_s / T + 50 * noSig + fuel;
  }
  // works = no meltdown, the circuit really drives the reactor, and it follows the load better than vanilla AutoTemp
  const works = (r, c, limit) => r.meltdown_at_s === null && c <= limit
    && (r.no_fission_signal_s + r.no_turbine_signal_s) / (2 * Math.max(r.duration_s, 1)) < 0.25;

  // generator: yields {tried, best} after each test run so the web page can stay responsive; returns the result
  function* search(model, cfg, opts) {
    opts = opts || {};
    const maxKW = cfg.reactorMaxKW || 5000;
    const base = Object.assign({}, cfg, { profile: testProfile(maxKW), start: 'warm', wear: false, seed: 1, circuitName: 'autopins', vanilla: false, beforeTick: null, rods: cfg.rods || 2 });
    const hasBatt = model.boxes.some(b => b.name === 'battery');
    if (hasBatt) base.batteries = Object.assign({ count: 2, startCharge: 50 }, cfg.batteries || {}, { enabled: true });
    const vals = P.placeholders(base), cache = new Map(), log = [];
    let tried = 0;
    const key = pins => JSON.stringify(model.boxes.map(b => Object.entries(pins[b.name] || {}).sort()));
    function run(pins) {
      const k = key(pins); if (cache.has(k)) return cache.get(k);
      const m = Object.assign({}, model, { boxes: model.boxes.map(b => Object.assign({}, b, { pins: pins[b.name] })) });
      let res;
      try { const r = new E.Sim(P.substitute(m, vals), Object.assign({}, base)).runToEnd(); const c = cost(r, fuelRef); res = { cost: c + prior(pins), works: works(r, c, limit), r }; }
      catch (e) { res = { cost: 1e9, works: false, error: e.message }; }
      tried++; cache.set(k, res); return res;
    }
    // starting point and label hints for each box
    const start = {}, hint = {}, used = {};
    for (const b of model.boxes) {
      used[b.name] = usedPins(b);
      hint[b.name] = (opts.guess && opts.guess(b)) || {};
      const d = E.DEFAULT_PINS[b.name] || {}, p = {};
      for (const pin of [...used[b.name].ins, ...used[b.name].outs]) p[pin] = (b.pins && b.pins[pin]) || hint[b.name][pin];
      for (const pin of [...used[b.name].ins, ...used[b.name].outs]) if (!p[pin]) p[pin] = !b.pins && d[pin] && !Object.values(p).includes(d[pin]) ? d[pin] : 'none'; // a .pins file leaves the rest unwired; else default harness where it doesn't double up
      for (const [pin, v] of Object.entries(b.pins || {})) if (!(pin in p)) p[pin] = v; // keep links etc.
      start[b.name] = p;
    }
    // small tie-breaker: prefer what the labels say
    function prior(pins) { let c = 0; for (const b in hint) for (const [pin, v] of Object.entries(hint[b])) if (pins[b] && pins[b][pin] !== undefined && pins[b][pin] !== v) c += 3; return c; } // a labelled pin only moves for a clear gain
    const clone = p => JSON.parse(JSON.stringify(p));
    // what "works" means: clearly better than the game's own AutoTemp on the same test
    let ref = null, fuelRef = 0;
    try { const r = new E.Sim({ name: 'vanilla', boxes: [], links: [] }, Object.assign({}, base, { vanilla: true })).runToEnd(); r.no_fission_signal_s = r.no_turbine_signal_s = 0; fuelRef = r.fuel_condition_used; ref = cost(r, fuelRef); } catch (e) { }
    const limit = opts.limit || (ref === null ? 50 : ref * 0.8); // a circuit should load-follow better than AutoTemp
    let best = { pins: clone(start), res: run(start) };
    const initial = best.res;
    log.push(`vanilla AutoTemp on the test: cost ${ref === null ? '?' : ref.toFixed(1)}; works below ${limit.toFixed(1)}`);
    log.push(`start: cost ${best.res.cost.toFixed(1)} ${best.res.works ? 'works' : 'does not work'}`);
    yield { tried, best };
    if (best.res.works && !opts.force) return finish();

    function better(pins) { const res = run(pins); if (res.cost < best.res.cost - 0.01) { best = { pins: clone(pins), res }; return true; } return false; }
    const done = () => best.res.works && !opts.force;
    // inputs: try every source on every free pin (coordinate descent), then swap pairs once
    function* inputs(b) {
      const C = CANDS[b.name], ins = used[b.name].ins.filter(p => !isFixed(start[b.name][p]));
      const srcs = C.ins.filter(x => !x.startsWith('junction.') || hasBatt || Object.values(hint[b.name]).includes(x));
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        for (const pin of ins) for (const src of srcs) {
          if (best.pins[b.name][pin] === src) continue;
          const p = clone(best.pins); p[b.name][pin] = src; if (better(p)) moved = true; yield { tried, best };
        }
        if (pass === 0) for (let i = 0; i < ins.length; i++) for (let j = i + 1; j < ins.length; j++) {
          const p = clone(best.pins), x = p[b.name][ins[i]]; p[b.name][ins[i]] = p[b.name][ins[j]]; p[b.name][ins[j]] = x;
          if (p[b.name][ins[i]] !== x && better(p)) moved = true; yield { tried, best };
        }
        if (!moved || done()) break;
      }
    }
    // outputs: every way of putting the control roles on the used output pins
    function* outputs(b) {
      const C = CANDS[b.name], outs = used[b.name].outs.filter(p => !isFixed(start[b.name][p])), assigns = [];
      (function rec(i, cur, left) {
        if (i === outs.length) { if (left.length === 0 || outs.length < C.roles.length) assigns.push(cur); return; }
        rec(i + 1, Object.assign({}, cur, { [outs[i]]: C.extraOuts.includes(hint[b.name][outs[i]]) ? hint[b.name][outs[i]] : 'none' }), left);
        for (const r of left) rec(i + 1, Object.assign({}, cur, { [outs[i]]: r }), left.filter(x => x !== r));
      })(0, {}, C.roles);
      for (const a of assigns) { const p = clone(best.pins); Object.assign(p[b.name], a); better(p); yield { tried, best }; }
    }
    const boxes = model.boxes.filter(b => CANDS[b.name]);
    for (let round = 0; round < 2 && !done(); round++) {
      for (const b of boxes) { yield* inputs(b); if (done()) break; }
      if (done()) break;
      for (const b of boxes) { yield* outputs(b); if (done()) break; }
    }
    return finish();
    function finish() {
      const changed = [];
      for (const b of model.boxes) for (const [pin, v] of Object.entries(best.pins[b.name] || {})) if ((start[b.name] || {})[pin] !== v) changed.push(`${b.name}.${pin}: ${start[b.name][pin]} -> ${v}`);
      const r = best.res.r || {};
      log.push(`best: cost ${best.res.cost.toFixed(1)} ${best.res.works ? 'works' : 'does not work'} after ${tried} test runs` + (r.unmet_pct != null ? ` (test: unmet ${r.unmet_pct}%, voltage dev ${r.voltage_mean_abs_dev}, temp max ${r.temp_max}${r.fires ? ', fires ' + r.fires : ''}${r.meltdown_at_s !== null ? ', MELTDOWN' : ''})` : ''));
      return { pins: best.pins, works: best.res.works, cost: best.res.cost, initialWorks: initial.works, initialCost: initial.cost, changed, tried, log };
    }
  }
  function solve(model, cfg, opts) { const g = search(model, cfg, opts); let s; do s = g.next(); while (!s.done); return s.value; }
  function pinsText(res, note) {
    const L = [`# pins found by autopins (trial and error on a ${STEPS[STEPS.length - 1][0]} s load-step test): ${res.works ? 'works' : 'best found, still weak'}, cost ${res.cost.toFixed(1)}${note ? ' ' + note : ''}`];
    for (const [b, pins] of Object.entries(res.pins)) for (const [pin, v] of Object.entries(pins).sort()) L.push(`${b} ${pin} ${v}`);
    return L.join('\n') + '\n';
  }
  return { search, solve, pinsText, usedPins, testProfile, cost };
});
