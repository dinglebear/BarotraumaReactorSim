// Reads a Barotrauma submarine file (.sub is gzipped XML; pass the XML text) into a light ship model for the
// electrical mock: hulls (to draw the sub), items that matter electrically (with their saved component settings,
// connections and position), wires between connections, and circuit boxes converted to the bench's box model.
// Decorations, structures, waypoints and loose items are dropped.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./format'), require('./components'));
  else root.BaroSubFile = factory(root.BaroFormat, root.BaroComponents);
})(typeof self !== 'undefined' ? self : this, function (F, C) {
  'use strict';
  const num = v => (v === undefined || v === '' ? undefined : Number(v));
  const rect = s => (s || '0,0,0,0').split(',').map(Number); // x, y(top, y up), w, h
  // components that make an item electrically interesting
  const ELECTRIC = new Set(['Reactor', 'PowerTransfer', 'PowerContainer', 'RelayComponent', 'PowerDistributor', 'Engine', 'Pump', 'Sonar', 'Steering', 'OxygenGenerator',
    'Turret', 'ElectricalDischarger', 'LightComponent', 'Door', 'Fabricator', 'Deconstructor', 'MiniMap', 'Controller', 'MotionSensor', 'WaterDetector', 'SmokeDetector',
    'OxygenDetector', 'Terminal', 'ButtonTerminal', 'TextDisplay', 'CircuitBox', 'WifiComponent', 'Vent', 'Powered', 'StatusMonitor', 'ItemLabel']);

  function parseSub(xml) {
    const doc = F.parseXml(xml), sub = doc.children.find(n => n.tag === 'Submarine' || n.tag === 'ItemAssembly'); // assemblies hold items the same way
    if (!sub) throw new Error('not a submarine file (no <Submarine>)');
    const a = sub.attrs;
    const ship = { name: a.name || 'sub', description: a.description || '', class: a.class || '', tier: num(a.tier), dimensions: a.dimensions || '', hulls: [], items: [], wires: [], warnings: [] };
    const byId = new Map(), wireItems = new Map();
    for (const n of sub.children) {
      if (n.tag === 'Hull') ship.hulls.push({ id: n.attrs.ID, rect: rect(n.attrs.rect), name: n.attrs.roomname || '' });
      if (n.tag !== 'Item') continue;
      const it = { id: n.attrs.ID, identifier: n.attrs.identifier, rect: rect(n.attrs.rect), tags: n.attrs.Tags || n.attrs.tags || '', comps: {}, conns: [], contained: [], flipped: n.attrs.flippedx === 'true' };
      for (const c of n.children) {
        if (c.tag === 'ConnectionPanel') { for (const io of c.children) if (io.tag === 'input' || io.tag === 'output') it.conns.push({ name: io.attrs.name, dir: io.tag, links: io.children.filter(l => l.tag === 'link').map(l => ({ w: l.attrs.w, i: Number(l.attrs.i) })) }); }
        else if (c.tag === 'ItemContainer') it.contained.push((c.attrs.contained || '').split(',').map(s => s.split(';').filter(Boolean)));
        else if (c.tag === 'CircuitBox') it.circuitBoxXml = c;
        else if (c.tag === 'Wire') it.wireNodes = c.attrs.nodes || '';
        else if (!/^(requireditem|itemstats|Holdable|Repairable|Pickable|Wearable|Body|Rope)$/.test(c.tag)) { (it.comps[c.tag] = it.comps[c.tag] || []).push(c.attrs); }
      }
      byId.set(it.id, it);
      if (it.wireNodes !== undefined) wireItems.set(it.id, it);
    }
    // wires: each wire item joins the two connections whose <link w=wireId i=0|1> point at it
    const ends = new Map();
    for (const it of byId.values()) for (const c of it.conns) for (const l of c.links) { if (!ends.has(l.w)) ends.set(l.w, []); ends.get(l.w).push({ item: it.id, conn: c.name, i: l.i }); }
    for (const [w, e] of ends) {
      const wi = wireItems.get(w);
      if (e.length !== 2) { ship.warnings.push(`wire ${w} has ${e.length} connected end(s)`); continue; }
      e.sort((x, y) => x.i - y.i);
      const nodes = wi ? wi.wireNodes.split(';').map(Number) : [];
      const pts = []; for (let k = 0; k + 1 < nodes.length; k += 2) pts.push([nodes[k], nodes[k + 1]]);
      ship.wires.push({ id: w, color: wi ? wi.identifier : 'wire', from: { item: e[0].item, conn: e[0].conn }, to: { item: e[1].item, conn: e[1].conn }, nodes: pts });
    }
    // items held inside circuit boxes are the boxes' components, not separate devices
    const insideBox = new Set();
    for (const it of byId.values()) if (it.circuitBoxXml) for (const cont of it.contained) for (const slot of cont) for (const id of slot) insideBox.add(id);
    for (const it of byId.values()) {
      if (it.wireNodes !== undefined || insideBox.has(it.id)) continue;
      const kinds = Object.keys(it.comps);
      const logic = C.byItem(it.identifier);
      if (!it.conns.length && !kinds.some(k => ELECTRIC.has(k))) continue; // furniture, cabinets, decals
      if (!it.conns.length && !logic && !kinds.some(k => k !== 'LightComponent' && ELECTRIC.has(k)) && !hasPower(it)) continue;
      const out = { id: it.id, identifier: it.identifier, rect: it.rect, kinds, comps: it.comps, conns: it.conns.map(c => ({ name: c.name, dir: c.dir })) };
      if (logic) out.logic = logic.alias;
      if (it.circuitBoxXml) out.box = circuitBox(it, byId, ship);
      if (it.comps.Reactor || it.comps.PowerContainer) out.contained = it.contained.flat().flat().map(id => byId.get(id)).filter(Boolean).map(x => x.identifier);
      ship.items.push(out);
    }
    const keep = new Set(ship.items.map(i => i.id));
    ship.wires = ship.wires.filter(w => keep.has(w.from.item) && keep.has(w.to.item));
    return ship;
  }
  function hasPower(it) { for (const list of Object.values(it.comps)) for (const c of list) if (Number(c.PowerConsumption) > 0) return true; return false; }

  // vanilla circuit box -> bench box model. <Component backingitemid="slot,index"> points into ItemContainer[0];
  // the component's settings live on that contained item.
  function circuitBox(it, byId, ship) {
    const x = it.circuitBoxXml, slots = it.contained[0] || [];
    const box = { name: 'box' + it.id, pins: null, components: [], wires: [], labels: [], inLabels: {}, outLabels: {}, inPos: null, outPos: null };
    for (const n of x.children) {
      if (n.tag === 'InputNode' || n.tag === 'OutputNode') {
        const p = (n.attrs.pos || '0,0').split(',').map(Number); if (n.tag === 'InputNode') box.inPos = p; else box.outPos = p;
        for (const o of n.children) if (o.tag === 'ConnectionLabelOverride') (n.tag === 'InputNode' ? box.inLabels : box.outLabels)[o.attrs.name] = o.attrs.value;
      } else if (n.tag === 'Component') {
        const [s, k] = (n.attrs.backingitemid || '').split(',').map(Number), id = (slots[s] || [])[k || 0], ci = byId.get(id);
        if (s >= 64) { ship.warnings.push(`circuit box ${it.id}: the component in slot ${s} is lost in game (a circuit box holds 64)`); continue; } // the game logs "failed to find an item in the container"
        const ident = ci ? ci.identifier : n.attrs.item;
        const def = C.byItem(ident);
        if (!def) { ship.warnings.push(`circuit box ${it.id}: component "${ident}" is not simulated`); continue; }
        const props = {}, attrs = ci && ci.comps[def.cls] ? ci.comps[def.cls][0] : n.attrs;
        for (const key of Object.keys(def.defaults)) if (attrs[key] !== undefined) props[key] = attrs[key];
        box.components.push({ id: n.attrs.id, item: def.item, cls: def.cls, props, pos: (n.attrs.position || '0,0').split(',').map(Number) });
      } else if (n.tag === 'Wire') {
        const fr = n.children.find(c => c.tag === 'From'), to = n.children.find(c => c.tag === 'To');
        if (fr && to) box.wires.push({ from: { c: fr.attrs.target === '' ? null : fr.attrs.target, pin: fr.attrs.name }, to: { c: to.attrs.target === '' ? null : to.attrs.target, pin: to.attrs.name }, prefab: n.attrs.prefab || 'redwire' });
      } else if (n.tag === 'Label') box.labels.push({ header: n.attrs.header || '', body: n.attrs.body || '', color: n.attrs.color || '#7ED3E0', pos: (n.attrs.position || '0,0').split(',').map(Number), size: (n.attrs.size || '400,250').split(',').map(Number) });
    }
    const ids = new Set(box.components.map(c => c.id));
    box.wires = box.wires.filter(w => (w.from.c === null || ids.has(w.from.c)) && (w.to.c === null || ids.has(w.to.c)));
    return box;
  }

  // one-line-per-thing summary (for people and AIs)
  function summary(ship) {
    const L = [`${ship.name} (${ship.class || '?'}${ship.tier ? ', tier ' + ship.tier : ''}): ${ship.hulls.length} hulls, ${ship.items.length} electrical items, ${ship.wires.length} wires`];
    const count = {}; for (const it of ship.items) count[it.identifier] = (count[it.identifier] || 0) + 1;
    L.push('items: ' + Object.entries(count).sort((a, b) => b[1] - a[1]).map(([k, v]) => v > 1 ? `${k}×${v}` : k).join(', '));
    return L.join('\n');
  }
  return { parseSub, summary };
});
