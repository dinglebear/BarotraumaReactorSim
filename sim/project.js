// Shared helpers used by the CLI (sim/cli.js) and the web bench (web/): load circuits, export, format logs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./format'), require('./engine'));
  else root.BaroProject = factory(root.BaroFormat, root.BaroEngine);
})(typeof self !== 'undefined' ? self : this, function (F, E) {
  'use strict';
  // texts: {main: text, mainName, battery?: text}. main may be .circ or Blueprints .txt.
  // pinsText: optional sidecar "<box> <pin> <device.pin>" lines, e.g. "reactor in1 reactor.load_value_out"
  //   or "prop <box> <componentId> <Property> <value>" to retune a community circuit per ship (value may use $MAX etc.)
  function applyPins(model, pinsText) {
    for (const raw of String(pinsText || '').split(/\r?\n/)) {
      const t = raw.replace(/#.*/, '').trim().split(/\s+/); if (t.length < 3) continue;
      if (t[0] === 'prop') { const b = model.boxes.find(x => x.name === t[1]); const c = b && b.components.find(x => String(x.id) === t[2]); if (c) c.props[t[3]] = t.slice(4).join(' '); continue; }
      const b = model.boxes.find(x => x.name === t[0]); if (!b) continue;
      b.pins = b.pins || {}; b.pins[t[1]] = t[2];
    }
    return model;
  }
  function loadModel(main, mainName, batteryText, pinsText) {
    let model;
    if (!/<CircuitBox/.test(main)) model = F.parseCirc(main);
    else {
      model = F.load(main, 'reactor'); model.name = (mainName || 'imported').replace(/(_reactor)?\.txt$/i, '');
      if (batteryText) model.boxes.push(F.parseTxt(batteryText, 'battery'));
      // rebuild box-to-box links from "link.<box>_<pin>" labels written by exportBoxes
      for (const b of model.boxes) for (const [p, v] of Object.entries(b.pins || {})) {
        const m = /^link\.(\w+?)_((?:in|out)\d)$/.exec(v);
        if (m && p.startsWith('out')) model.links.push({ from: `${b.name}.${p}`, to: `${m[1]}.${m[2]}` });
      }
    }
    if (pinsText) applyPins(model, pinsText);
    return model;
  }
  // Placeholders usable in any component property value (filled from the test settings):
  //   $MAX      reactor max output kW          $BATT_N    number of batteries
  //   $BATT_KW  total max recharge kW (all)    $BATT_OUT  total max output kW (all)    $BATT_CAP total capacity kW·min
  function placeholders(cfg) {
    const bc = (cfg && cfg.batteries) || {}, spec = E.batterySpec(cfg, cfg && cfg.profile), n = bc.enabled ? spec.count : 0, t = spec.type; // settings, or the ship's own
    return { MAX: (cfg && cfg.reactorMaxKW) || 5000, BATT_N: n, BATT_KW: n * t.maxRecharge, BATT_OUT: n * t.maxOut, BATT_CAP: n * t.capacity };
  }
  const PH = /\$([A-Z_][A-Z0-9_]*)/g; // $MAX, $BATT_*, or any name given per box (e.g. $ROOM)
  function substitute(model, vals) {
    if (typeof vals !== 'object') vals = { MAX: vals };
    const m = JSON.parse(JSON.stringify(model));
    for (const b of m.boxes) for (const c of b.components) for (const k in c.props) {
      const v = c.props[k]; if (typeof v !== 'string' || !PH.test(v)) continue; PH.lastIndex = 0;
      let out = v.replace(PH, (x, n) => vals[n] == null ? x : String(vals[n]));
      // simple formulas like "$BATT_KW*0.5" or "-$BATT_OUT/2" are calculated
      if (/^[\d.+\-*/() eE]+$/.test(out) && /[*/+]|\d-/.test(out)) { try { const r = Function('"use strict";return (' + out + ')')(); if (Number.isFinite(r)) out = String(Math.round(r * 1000) / 1000); } catch (e) { } }
      c.props[k] = out;
    }
    return m;
  }
  // -> [{filename, text}]  one box: <name>.txt ; two boxes: <name>_reactor.txt + <name>_battery.txt
  function exportBoxes(model, vals) {
    if (typeof vals !== 'object') vals = { MAX: vals };
    const m = substitute(model, vals), out = [];
    m.boxes.forEach((b, bi) => { // in-game note for every value that came from a placeholder
      // say which parts hold sub-specific numbers, by kind and current value (component ids aren't visible in game)
      const WORDS = { MAX: 'reactor max output (kW)', BATT_KW: 'total battery max recharge (kW)', BATT_OUT: 'total battery max output (kW)', BATT_N: 'number of batteries', BATT_CAP: 'total battery capacity (kW*min)' };
      const KIND = { memorycomponent: 'Memory', multiplycomponent: 'Multiply', dividecomponent: 'Divide', addercomponent: 'Adder', subtractcomponent: 'Subtract' };
      const lines = [];
      model.boxes[bi].components.forEach((c, ci) => {
        for (const [k, v] of Object.entries(c.props)) {
          if (typeof v !== 'string' || !/\$[A-Z_]+/.test(v)) continue;
          const now = m.boxes[bi].components[ci].props[k], what = v.replace(/\$(BATT_KW|BATT_OUT|BATT_CAP|BATT_N|MAX)/g, (x, n) => WORDS[n]).replace(/\*/g, ' x ').replace(/\//g, ' / ');
          lines.push(`${KIND[c.item] || c.item} ${k} = ${now}: ${what}`);
        }
      });
      if (lines.length) b.labels.push({ header: 'VALUES FOR THIS SUB', body: `Set for: reactor ${vals.MAX} kW` + (vals.BATT_N ? `, ${vals.BATT_N} batteries (${vals.BATT_KW} kW recharge, ${vals.BATT_OUT} kW output, ${vals.BATT_CAP} kW*min)` : '') + `. On another sub change:\n` + [...new Set(lines)].join('\n'), color: '#FFB000' });
    });
    for (const b of m.boxes) if (!b.pins) { // label used pins with the default harness so the in-game wiring is obvious
      const used = new Set(); for (const w of b.wires) { if (w.from.c === null) used.add(F.shortPin(w.from.pin)); if (w.to.c === null) used.add(F.shortPin(w.to.pin)); }
      const d = E.DEFAULT_PINS[b.name] || {}; b.pins = {}; for (const p of used) if (d[p]) b.pins[p] = d[p];
    }
    for (const b of m.boxes) for (const l of m.links || []) { const [fb, fp] = l.from.split('.'), [tb, tp] = l.to.split('.'); if (fb === b.name) b.pins[fp] = `link.${tb}_${tp}`; if (tb === b.name) b.pins[tp] = `link.${fb}_${fp}`; }
    if (m.boxes.length === 1) out.push({ filename: m.name + '.txt', text: F.toTxt(m.boxes[0]) });
    else for (const b of m.boxes) out.push({ filename: `${m.name}_${b.name}.txt`, text: F.toTxt(b, { baseId: b.name === 'battery' ? 3000 : 1000 }) });
    return out;
  }
  function fmtReport(r) {
    const L = [];
    for (const [k, v] of Object.entries(r)) if (k !== 'events' && k !== 'warnings' && v !== null && v !== '') L.push(`${k}=${v}`);
    let s = L.join('\n');
    if (r.warnings && r.warnings.length) s += '\nWARNINGS:\n' + r.warnings.map(w => '  ' + w).join('\n');
    s += '\nEVENTS' + (r.events && r.events.length ? ':\n' + r.events.map(e => '  ' + e).join('\n') : ': none');
    return s + '\n';
  }
  function timelineCsv(tl) {
    const cols = ['t', 'demand', 'power', 'voltage', 'temp', 'fission', 'turbine', 'tf', 'tt', 'cto', 'fuel', 'batt', 'battOut', 'battIn'];
    return cols.join(',') + '\n' + tl.map(p => cols.map(c => p[c] == null ? '' : (Math.round(p[c] * 100) / 100)).join(',')).join('\n') + '\n';
  }
  return { loadModel, applyPins, placeholders, substitute, exportBoxes, fmtReport, timelineCsv };
});
