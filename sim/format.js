// Circuit file I/O.
//  - Blueprints .txt (the in-game export format used by the "Blueprints" workshop mod)  <->  model
//  - .circ compact DSL (token-cheap format for AIs)                                       <->  model
// Model: { name, boxes:[Box], links:[{from:'reactor.out5', to:'battery.in1'}] }
// Box:   { name, pins:{in1:'reactor.load_value_out',...}|null, components:[{id,item,props,pos}],
//          wires:[{from:{c,pin},to:{c,pin},prefab}], labels:[{header,body,color,pos,size}],
//          inLabels:{signal_in1:'..'}, outLabels:{..}, inPos, outPos }
// wire endpoint: c===null -> box IO node (pin = signal_inN / signal_outN), else component id.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./components'));
  else root.BaroFormat = factory(root.BaroComponents);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const SS = '<<<STRINGSTART>>>', SE = '<<<STRINGEND>>>';

  // ---------------- tiny XML reader (handles Blueprints string markers) ----------------
  function decodeEnt(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|amp|lt|gt|apos);/g, (m, e) => {
      if (e[0] === '#') return String.fromCharCode(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" }[e];
    });
  }
  function encEnt(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#xA;');
  }
  function parseXml(text) {
    const raw = [];
    // pull out marker strings first (they may contain quotes / angle brackets)
    text = text.replace(/"?<<<STRINGSTART>>>([\s\S]*?)<<<STRINGEND>>>"?/g, (m, v) => { raw.push(v); return '"\u0001' + (raw.length - 1) + '\u0001"'; });
    const rootN = { tag: '#root', attrs: {}, children: [] }, stack = [rootN];
    const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=\/>]+\s*=\s*"[^"]*")*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
    let m;
    while ((m = re.exec(text))) {
      if (!m[2]) continue;
      if (m[1]) { stack.pop(); continue; }
      const attrs = {};
      m[3].replace(/([^\s=\/>]+)\s*=\s*"([^"]*)"/g, (q, k, v) => {
        const mm = /^\u0001(\d+)\u0001$/.exec(v);
        attrs[k] = mm ? raw[+mm[1]] : decodeEnt(v);
      });
      const n = { tag: m[2], attrs, children: [] };
      stack[stack.length - 1].children.push(n);
      if (!m[4]) stack.push(n);
    }
    return rootN;
  }
  const kids = (n, tag) => n.children.filter(c => c.tag === tag);
  const find = (n, tag) => { if (n.tag === tag) return n; for (const c of n.children) { const r = find(c, tag); if (r) return r; } return null; };
  const xy = s => (s || '0,0').split(',').map(Number);

  // ---------------- Blueprints .txt -> box ----------------
  function parseTxt(text, boxName) {
    const doc = parseXml(text);
    const cb = find(doc, 'CircuitBox');
    if (!cb) throw new Error('No <CircuitBox> found');
    const box = { name: boxName || 'reactor', pins: null, components: [], wires: [], labels: [], inLabels: {}, outLabels: {}, inPos: [-1200, 0], outPos: [1200, 0] };
    const inN = kids(cb, 'InputNode')[0], outN = kids(cb, 'OutputNode')[0];
    if (inN) { box.inPos = xy(inN.attrs.pos); for (const o of kids(inN, 'ConnectionLabelOverride')) box.inLabels[o.attrs.name] = o.attrs.value; }
    if (outN) { box.outPos = xy(outN.attrs.pos); for (const o of kids(outN, 'ConnectionLabelOverride')) box.outLabels[o.attrs.name] = o.attrs.value; }
    for (const c of kids(cb, 'Component')) {
      const a = c.attrs, props = {};
      for (const k in a) if (!['id', 'position', 'backingitemid', 'usedresource', 'Class', 'item'].includes(k)) props[k] = a[k];
      box.components.push({ id: a.id, item: a.item, cls: a.Class, props, pos: xy(a.position) });
    }
    for (const w of kids(cb, 'Wire')) {
      const f = kids(w, 'From')[0].attrs, t = kids(w, 'To')[0].attrs;
      box.wires.push({ from: { c: f.target === '' ? null : f.target, pin: f.name }, to: { c: t.target === '' ? null : t.target, pin: t.name }, prefab: w.attrs.prefab || 'redwire' });
    }
    for (const l of kids(cb, 'Label')) box.labels.push({ header: l.attrs.header || '', body: l.attrs.body || '', color: l.attrs.color || '#7ED3E0', pos: xy(l.attrs.position), size: xy(l.attrs.size || '400,250') });
    // harness from IO labels written as "device.pin" (this is how our exporter writes them)
    const pins = {};
    for (const [k, v] of Object.entries(box.inLabels)) if (/^\w+\.\w[\w%]*$/.test(v)) pins[shortPin(k)] = v;
    for (const [k, v] of Object.entries(box.outLabels)) if (/^\w+\.\w[\w%]*$/.test(v)) pins[shortPin(k)] = v;
    if (Object.keys(pins).length) box.pins = pins;
    return box;
  }

  // ---------------- box -> Blueprints .txt ----------------
  function autoLayout(box) {
    // place components by signal depth so the in-game editor view is readable
    const depth = {}; box.components.forEach(c => depth[c.id] = 0);
    for (let it = 0; it < box.components.length + 1; it++)
      for (const w of box.wires) if (w.from.c !== null && w.to.c !== null && w.from.c !== w.to.c && depth[w.to.c] < depth[w.from.c] + 1 && depth[w.from.c] < 40) depth[w.to.c] = depth[w.from.c] + 1;
    // positions are node CENTRES (as in game); a node is 48 (header) + 64 + 32 per pin row tall
    const nextY = {}, maxD = Math.max(0, ...Object.values(depth));
    for (const c of box.components) {
      const d = depth[c.id], def = C.byItem(c.item), h = 48 + 64 + 32 * Math.max(def ? def.ins.length : 1, def ? def.outs.length : 1);
      if (nextY[d] === undefined) nextY[d] = 600;
      if (!c.pos) c.pos = [-900 + d * 400, nextY[d] - h / 2];
      nextY[d] = Math.min(nextY[d], c.pos[1] - h / 2) - 60;
    }
    box.inPos = box.inPos || [-1400, 0]; box.outPos = box.outPos || [Math.max(1200, -900 + (maxD + 1) * 400 + 300), 0];
  }
  function toTxt(box, opts) {
    opts = opts || {};
    autoLayout(box);
    const idMap = {}; box.components.forEach((c, i) => idMap[c.id] = String(i));
    const baseId = opts.baseId || 1000;
    const usedPins = new Set();
    for (const w of box.wires) { if (w.from.c === null) usedPins.add(w.from.pin); if (w.to.c === null) usedPins.add(w.to.pin); }
    const inLabels = Object.assign({}, box.inLabels), outLabels = Object.assign({}, box.outLabels);
    for (const [k, v] of Object.entries(box.pins || {})) { const full = longPin(k, null); (full.startsWith('signal_in') ? inLabels : outLabels)[full] = v; }
    const extra = [...usedPins, ...Object.keys(inLabels), ...Object.keys(outLabels)].filter(p => /signal_(in|out)[09]$/.test(p));
    const compSlots = box.components.map((c, i) => baseId + i);
    let wireN = 0; const wireBack = box.wires.map(w => (w.from.c === null || w.to.c === null) ? '' : '0,' + (wireN++));
    const wireIds = []; for (let i = 0; i < wireN; i++) wireIds.push(baseId + 200 + i);
    const slots = []; for (let i = 0; i < 64; i++) slots.push(compSlots[i] !== undefined ? compSlots[i] : '');
    const wslots = [wireIds.join(';')]; for (let i = 1; i < 10; i++) wslots.push('');
    const q = v => SS + v + SE;
    const L = [];
    L.push('<Root>');
    L.push(`  <Item name="" identifier="circuitbox" ID="${baseId - 1}" markedfordeconstruction="false" flippedx="true" rect="208,-8,32,32" NonInteractable="False" NonPlayerTeamInteractable="False" AllowSwapping="True" Rotation="0" Scale="0.5" SpriteColor="255,255,255,255" InventoryIconColor="255,255,255,255" ContainerColor="255,255,255,255" InvulnerableToDamage="False" Tags="smallitem" DisplaySideBySideWhenLinked="False" DisallowedUpgrades="" SpriteDepth="0.8" HiddenInGame="False" conditionpercentage="100">`);
    L.push('    <Holdable Attached="True" SpriteDepthWhenDropped="0.55" PickingTime="5" CanBePicked="True" LockGuiFramePosition="False" GuiFrameOffset="0,0" AllowInGameEditing="True" Msg="ItemMsgDetachWrench">');
    L.push('      <requireditem items="wrench" type="Equipped" characterinventoryslottype="None" optional="false" ignoreineditor="false" excludebroken="true" requireempty="false" excludefullcondition="false" targetslot="-1" allowvariants="true" rotation="0" setactive="false" />');
    L.push('    </Holdable>');
    L.push('    <ConnectionPanel Locked="False" PickingTime="0" CanBePicked="False" LockGuiFramePosition="False" GuiFrameOffset="0,0" AllowInGameEditing="True" Msg="ItemMsgRewireScrewdriver">');
    L.push('      <requireditem items="screwdriver" type="Equipped" characterinventoryslottype="None" optional="false" ignoreineditor="false" excludebroken="true" requireempty="false" excludefullcondition="false" targetslot="-1" allowvariants="true" rotation="0" setactive="false" />');
    for (let i = 1; i <= 8; i++) L.push(`      <input name="signal_in${i}" />`);
    for (let i = 1; i <= 8; i++) L.push(`      <output name="signal_out${i}" />`);
    for (const p of [...new Set(extra)].sort()) L.push(`      <${p.includes('_in') ? 'input' : 'output'} name="${p}" />`);
    L.push('    </ConnectionPanel>');
    L.push(`    <ItemContainer QuickUseMovesItemsInside="False" ContainableRestrictions="" AutoFill="True" PickingTime="0" CanBePicked="False" LockGuiFramePosition="False" GuiFrameOffset="0,0" AllowInGameEditing="True" Msg="" contained="${slots.join(',')}" ExtraStackSize="0" />`);
    L.push(`    <ItemContainer QuickUseMovesItemsInside="False" ContainableRestrictions="" AutoFill="True" PickingTime="0" CanBePicked="False" LockGuiFramePosition="False" GuiFrameOffset="0,0" AllowInGameEditing="True" Msg="" contained="${wslots.join(',')}" ExtraStackSize="0" />`);
    L.push('    <CircuitBox Locked="False" PickingTime="0" CanBePicked="False" LockGuiFramePosition="False" GuiFrameOffset="0,0" AllowInGameEditing="True" Msg="ItemMsgInteractSelect">');
    L.push('      <requireditem items="idcard" type="Picked" characterinventoryslottype="None" optional="false" ignoreineditor="true" excludebroken="true" requireempty="false" excludefullcondition="false" targetslot="-1" allowvariants="true" rotation="0" setactive="false" msg="UNAUTHORIZED ACCESS" />');
    const node = (tag, pos, labels) => {
      const ent = Object.entries(labels);
      if (!ent.length) return L.push(`      <${tag} pos="${pos.join(',')}" />`);
      L.push(`      <${tag} pos="${pos.join(',')}">`);
      for (const [k, v] of ent) L.push(`        <ConnectionLabelOverride name="${k}" value="${q(v)}" />`);
      L.push(`      </${tag}>`);
    };
    node('InputNode', box.inPos, inLabels);
    node('OutputNode', box.outPos, outLabels);
    box.components.forEach((c, i) => {
      const def = C.byItem(c.item) || { cls: c.cls, defaults: {} };
      const props = Object.assign({}, def.defaults, c.props);
      let s = `      <Component id="${i}" position="${c.pos.map(Math.round).join(',')}" backingitemid="${i},0" usedresource="fpgacircuit" Class=${q(c.cls || def.cls)}`;
      for (const [k, v] of Object.entries(props)) s += ` ${k}=${q(v)}`;
      s += ` item=${q(c.item)} />`;
      L.push(s);
    });
    box.wires.forEach((w, i) => {
      L.push(`      <Wire id="${i}" backingitemid="${wireBack[i]}" prefab="${w.prefab || 'redwire'}">`);
      L.push(`        <From name="${w.from.pin}" target="${w.from.c === null ? '' : idMap[w.from.c]}" />`);
      L.push(`        <To name="${w.to.pin}" target="${w.to.c === null ? '' : idMap[w.to.c]}" />`);
      L.push('      </Wire>');
    });
    // notes without a saved position go in a row ABOVE the circuit (node centres, y up), so they never cover components
    const topY = Math.max(600, ...box.components.map(c => c.pos[1] + 200)), leftX = Math.min(-900, ...box.components.map(c => c.pos[0]));
    let nx = leftX;
    box.labels.forEach((l, i) => {
      const size = l.size || [Math.min(900, 360 + Math.ceil((l.body || '').length / 6) * 4), Math.min(700, 160 + Math.ceil((l.body || '').length / 55) * 34)];
      const pos = l.pos || [nx + size[0] / 2, topY + 120 + size[1] / 2]; if (!l.pos) nx += size[0] + 60;
      L.push(`      <Label id="${i}" color="${l.color || '#7ED3E0'}" position="${pos.map(v => Math.round(v)).join(',')}" size="${size.map(v => Math.round(v)).join(',')}" header="${encEnt(l.header)}" body="${encEnt(l.body)}" />`);
    });
    L.push('    </CircuitBox>');
    L.push('    <itemstats />');
    L.push('  </Item>');
    L.push('</Root>');
    return L.join('\r\n');
  }

  // ---------------- pins ----------------
  function shortPin(p) { const m = /^signal_(in|out)(\d)$/.exec(p); return m ? m[1] + m[2] : p; }
  function longPin(p, compItem) {
    if (compItem === null) { const m = /^(in|out)(\d)$/.exec(p); return m ? 'signal_' + m[1] + m[2] : p; }
    if (/^\d+$/.test(p)) return 'signal_in' + p;
    if (p === 'in') return 'signal_in';
    if (p === 'out') return 'signal_out';
    const al = C.pinAlias(compItem, p); return al || p;
  }
  function shortCompPin(p) {
    let m = /^signal_in(\d+)$/.exec(p); if (m) return m[1];
    if (p === 'signal_in') return 'in'; if (p === 'signal_out') return 'out';
    return p;
  }

  // ---------------- .circ DSL ----------------
  function tokenize(line) {
    const out = []; const re = /(\w[\w%-]*)="((?:[^"\\]|\\.)*)"|"((?:[^"\\]|\\.)*)"|(\S+)/g; let m;
    while ((m = re.exec(line))) {
      if (m[1] !== undefined) out.push(m[1] + '=' + m[2].replace(/\\(.)/g, (a, b) => b === 'n' ? '\n' : b));
      else if (m[3] !== undefined) out.push(m[3].replace(/\\(.)/g, (a, b) => b === 'n' ? '\n' : b));
      else out.push(m[4]);
    }
    return out;
  }
  function parseCirc(text) {
    const model = { name: 'circuit', boxes: [], links: [], meta: {} };
    let box = null;
    const getBox = () => { if (!box) { box = newBox('reactor'); model.boxes.push(box); } return box; };
    const ep = (s, b, lineNo) => {
      if (/^(in|out)\d$/.test(s)) return { c: null, pin: longPin(s, null) };
      const i = s.lastIndexOf('.'); if (i < 0) throw new Error(`line ${lineNo}: bad pin "${s}" (use compId.pin or inN/outN)`);
      const id = s.slice(0, i), pin = s.slice(i + 1), comp = b.components.find(c => c.id === id);
      if (!comp) throw new Error(`line ${lineNo}: unknown component "${id}"`);
      return { c: id, pin: longPin(pin, comp.item) };
    };
    text.split(/\r?\n/).forEach((rawLine, n) => {
      const line = rawLine.replace(/(^|\s)#.*$/, '').trim(); if (!line) return;
      const t = tokenize(line), k = t[0].toLowerCase(), ln = n + 1;
      if (k === 'name') model.name = t.slice(1).join(' ');
      else if (k === 'set') { for (const kv of t.slice(1)) { const [a, b] = kv.split('='); model.meta[a] = b; } }
      else if (k === 'box') { box = model.boxes.find(b => b.name === t[1]) || newBox(t[1]); if (!model.boxes.includes(box)) model.boxes.push(box); }
      else if (k === 'pin') { const b = getBox(); b.pins = b.pins || {}; b.pins[t[1]] = t[2]; }
      else if (k === 'c') {
        const b = getBox(); const def = C.byAlias(t[2]);
        if (!def) throw new Error(`line ${ln}: unknown component type "${t[2]}". Types: ${C.aliases().join(' ')}`);
        if (b.components.find(c => c.id === t[1])) throw new Error(`line ${ln}: duplicate id ${t[1]}`);
        const props = {}; let pos = null;
        for (const kv of t.slice(3)) {
          const at = /^@(-?[\d.]+),(-?[\d.]+)$/.exec(kv); if (at) { pos = [Number(at[1]), Number(at[2])]; continue; } // @x,y = position in the box
          const i = kv.indexOf('='); props[C.propName(def, kv.slice(0, i))] = kv.slice(i + 1);
        }
        b.components.push({ id: t[1], item: def.item, cls: def.cls, props, pos });
      }
      else if (k === 'w') {
        const b = getBox(); const from = ep(t[1], b, ln); let col = 'redwire';
        for (const s of t.slice(2)) { if (s.startsWith('color=')) { col = s.slice(6); continue; } b.wires.push({ from, to: ep(s, b, ln), prefab: col }); }
      }
      else if (k === 'note') getBox().labels.push({ header: t[1] || '', body: t[2] || '', color: t[3] || '#7ED3E0' });
      else if (k === 'label') { const b = getBox(); const p = longPin(t[1], null); (p.includes('_in') ? b.inLabels : b.outLabels)[p] = t.slice(2).join(' '); }
      else if (k === 'link') model.links.push({ from: t[1], to: t[2] });
      else throw new Error(`line ${ln}: unknown statement "${t[0]}"`);
    });
    return model;
  }
  function newBox(name) { return { name, pins: null, components: [], wires: [], labels: [], inLabels: {}, outLabels: {}, inPos: null, outPos: null }; }

  function toCirc(model, opts) { // opts.positions: keep component positions (@x,y), e.g. from the visual editor
    const L = [`name ${model.name}`];
    if (model.meta) { const m = Object.entries(model.meta); if (m.length) L.push('set ' + m.map(([a, b]) => `${a}=${b}`).join(' ')); }
    const qv = v => /[\s"#]/.test(v) || v === '' ? '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"' : v;
    for (const b of model.boxes) {
      L.push(`box ${b.name}`);
      for (const [k, v] of Object.entries(b.pins || {})) L.push(`pin ${k} ${v}`);
      for (const [k, v] of Object.entries(b.inLabels)) if (!(b.pins && b.pins[shortPin(k)] === v)) L.push(`label ${shortPin(k)} ${v}`);
      for (const [k, v] of Object.entries(b.outLabels)) if (!(b.pins && b.pins[shortPin(k)] === v)) L.push(`label ${shortPin(k)} ${v}`);
      const ids = {}; b.components.forEach(c => { const def = C.byItem(c.item); ids[c.id] = /^\d+$/.test(c.id) ? (def ? def.alias : 'c') + c.id : c.id; });
      for (const c of b.components) {
        const def = C.byItem(c.item);
        const props = Object.entries(c.props).filter(([k, v]) => !def || def.defaults[k] === undefined || String(def.defaults[k]) !== String(v));
        L.push(`c ${ids[c.id]} ${def ? def.alias : c.item}` + props.map(([k, v]) => ` ${k}=${qv(v)}`).join('') + (opts && opts.positions && c.pos ? ` @${Math.round(c.pos[0])},${Math.round(c.pos[1])}` : ''));
      }
      const groups = new Map();
      for (const w of b.wires) {
        const f = w.from.c === null ? shortPin(w.from.pin) : ids[w.from.c] + '.' + shortCompPin(w.from.pin);
        const to = w.to.c === null ? shortPin(w.to.pin) : ids[w.to.c] + '.' + shortCompPin(w.to.pin);
        if (!groups.has(f)) groups.set(f, []); groups.get(f).push(to);
      }
      for (const [f, tos] of groups) L.push(`w ${f} ${tos.join(' ')}`);
      for (const l of b.labels) L.push(`note ${qv(l.header)} ${qv(l.body)}`);
    }
    for (const l of model.links || []) L.push(`link ${l.from} ${l.to}`);
    return L.join('\n') + '\n';
  }

  // Load anything: .circ text or one/two .txt texts. Returns model.
  function load(text, boxName) {
    if (/<CircuitBox/.test(text)) { const b = parseTxt(text, boxName); return { name: boxName || 'imported', boxes: [b], links: [], meta: {} }; }
    return parseCirc(text);
  }
  return { parseTxt, toTxt, parseCirc, toCirc, load, shortPin, longPin, autoLayout, parseXml };
});
