// Shared helpers used by the CLI (sim/cli.js) and the web bench (web/): load circuits, export, format logs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./format'), require('./engine'));
  else root.BaroProject = factory(root.BaroFormat, root.BaroEngine);
})(typeof self !== 'undefined' ? self : this, function (F, E) {
  'use strict';
  // texts: {main: text, mainName, battery?: text}. main may be .circ or Blueprints .txt.
  // pinsText: optional sidecar "<box> <pin> <device.pin>" lines, e.g. "reactor in1 reactor.load_value_out"
  function applyPins(model, pinsText) {
    for (const raw of String(pinsText || '').split(/\r?\n/)) {
      const t = raw.replace(/#.*/, '').trim().split(/\s+/); if (t.length < 3) continue;
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
  // "$MAX" in any component property = reactor max output (kW) of the test.
  function substitute(model, maxKW) {
    const m = JSON.parse(JSON.stringify(model));
    for (const b of m.boxes) for (const c of b.components) for (const k in c.props) if (typeof c.props[k] === 'string' && c.props[k].includes('$MAX')) c.props[k] = c.props[k].replace(/\$MAX/g, String(maxKW));
    return m;
  }
  // -> [{filename, text}]  one box: <name>.txt ; two boxes: <name>_reactor.txt + <name>_battery.txt
  function exportBoxes(model, maxKW) {
    const m = substitute(model, maxKW), out = [];
    m.boxes.forEach((b, bi) => { // in-game note for every value that came from $MAX
      const ids = model.boxes[bi].components.filter(c => Object.values(c.props).some(v => String(v).includes('$MAX'))).map(c => c.id);
      if (ids.length) b.labels.push({ header: 'REACTOR MAX OUTPUT', body: `Exported for a ${maxKW} kW reactor. If your reactor's max output differs, edit: ${ids.join(', ')}`, color: '#FFB000' });
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
  return { loadModel, applyPins, substitute, exportBoxes, fmtReport, timelineCsv };
});
