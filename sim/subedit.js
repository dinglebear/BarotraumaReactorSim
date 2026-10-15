// Edits a real Barotrauma submarine file: add/remove/move items, wire/unwire connections, change settings, and build
// circuit boxes (with their components and internal wires) into the sub. Everything not edited stays byte-identical.
// Driven by a small patch language (see SUBEDIT.md) so an AI can redesign a sub's internals cheaply:
//   wire 154.velocity_x_out 180.set_force blue      add @btn button at -900,120      set @btn Controller.State=true
//   unwire 375.signal_out0 373.disable_output       remove 541                      move @btn -880,120
//   box @brain at -950,100 from circuits/x.circ [box reactor]
// Rules from the game's loader (Item.Load / ConnectionPanel.Load / Connection / Wire):
//   - an <Item> needs identifier, ID, rect; component elements are matched by name, missing ones keep prefab defaults
//   - a ConnectionPanel's <input>/<output> elements are matched BY ORDER, so new items that get wires are cloned from a
//     template item of the same identifier (all connections, prefab order); a <link w=wireID i=0|1/> joins a wire end
//   - a wire is an <Item> with a <Wire nodes="x;y;x;y..."/> (sub coordinates); both its ends must be linked
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./subxml'), require('./components'), require('./format'));
  else root.BaroSubEdit = factory(root.BaroSubXml, root.BaroComponents, root.BaroFormat);
})(typeof self !== 'undefined' ? self : this, function (X, C, F) {
  'use strict';
  const SOLID = /^(Shell|Shuttle Shell|Large (Horizontal|Vertical) Inside Wall|Large Inside Wall Cap|Platform|Submarine Bow|Stairs)/i; // structure names that are real walls/floors
  const CIRCUITBOX_MAX_COMPONENTS = 64; // in game: "Circuit box error: failed to find an item in the container" for slot 64 and up
  const WIRE_COLORS = { red: 'redwire', blue: 'bluewire', green: 'greenwire', orange: 'orangewire', yellow: 'yellowwire', black: 'blackwire', brown: 'brownwire', white: 'wire', wire: 'wire' };
  const rectOf = n => (X.get(n, 'rect') || '0,0,0,0').split(',').map(Number);
  const centerOf = n => { const r = rectOf(n); return [r[0] + r[2] / 2, r[1] - r[3] / 2]; };

  class SubDoc {
    // text: the sub's XML; templates: other SubDocs (e.g. vanilla subs) to copy item templates from
    constructor(text, templates) {
      this.eol = /\r\n/.test(text.slice(0, 5000)) ? '\r\n' : '\n';
      this.root = X.parse(text);
      this.sub = this.root.children.find(n => n.tag === 'Submarine' || n.tag === 'ItemAssembly'); // assemblies work as template sources
      if (!this.sub) throw new Error('not a submarine file');
      this.templates = templates || [];
      this.handles = {}; this.log = []; this.reindex();
    }
    reindex() {
      this.items = new Map(); this.maxId = 0;
      for (const n of this.sub.children) { const id = Number(X.get(n, 'ID')); if (Number.isFinite(id)) { this.maxId = Math.max(this.maxId, id); if (n.tag === 'Item') this.items.set(String(id), n); } }
      for (const n of this.sub.children) if (n.tag === 'Hull' || n.tag === 'Structure' || n.tag === 'Gap' || n.tag === 'WayPoint') { const id = Number(X.get(n, 'ID')); if (Number.isFinite(id)) this.maxId = Math.max(this.maxId, id); }
    }
    newId() { return String(++this.maxId); }
    text() { const s = X.serialize(this.root).replace(/\n/g, this.eol); return s; }
    name() { return X.get(this.sub, 'name'); }

    // ---------- lookup ----------
    ref(r) { // "123", "@handle"
      r = String(r);
      const id = r.startsWith('@') ? this.handles[r.slice(1)] : r;
      if (!id) throw new Error(`unknown handle ${r}`);
      const n = this.items.get(String(id)); if (!n) throw new Error(`no item with ID ${id}`);
      return n;
    }
    comp(n, name) { return n.children.find(c => c.tag === name); }
    panel(n) { return this.comp(n, 'ConnectionPanel'); }
    connEl(n, conn) {
      const p = this.panel(n); if (!p) throw new Error(`${X.get(n, 'identifier')} #${X.get(n, 'ID')} has no connection panel`);
      const c = p.children.find(x => (x.tag === 'input' || x.tag === 'output') && X.get(x, 'name') === conn);
      if (!c) throw new Error(`${X.get(n, 'identifier')} #${X.get(n, 'ID')} has no connection "${conn}" (has: ${p.children.filter(x => x.tag === 'input' || x.tag === 'output').map(x => X.get(x, 'name')).join(', ')})`);
      return c;
    }
    template(identifier) { // prefer a placed item (with its connection panel) over one stored inside a circuit box
      let loose = null;
      for (const d of [this, ...this.templates]) for (const n of d.items.values()) if (X.get(n, 'identifier') === identifier) { if (this.panel(n) || /wire$/.test(identifier)) return n; loose = loose || n; }
      return loose;
    }
    // ---------- placement: keep new fittings out of floors, ceilings and walls ----------
    // Solid structure = the sub's real walls (shell, inside walls and caps, platforms, bow, stairs); "Back Wall" and
    // background/deco pieces are only scenery. A room (hull) rectangle includes the thickness of its floor and ceiling,
    // so an item placed at a room's edge would sit inside the floor: nudge it to the nearest free spot in the same room.
    solids() {
      if (!this._solids) this._solids = this.sub.children.filter(n => n.tag === 'Structure' && SOLID.test(X.get(n, 'name') || '')).map(n => { const r = rectOf(n); return { x0: r[0], x1: r[0] + r[2], y1: r[1], y0: r[1] - r[3] }; });
      return this._solids;
    }
    hulls() { if (!this._hulls) this._hulls = this.sub.children.filter(n => n.tag === 'Hull').map(n => { const r = rectOf(n); return { x0: r[0], x1: r[0] + r[2], y1: r[1], y0: r[1] - r[3] }; }); return this._hulls; }
    freeSpot(n) {
      const r = rectOf(n), w = r[2], h = r[3], cx = r[0] + w / 2, cy = r[1] - h / 2;
      const box = (x, y) => ({ x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 });
      const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
      const ok = b => !this.solids().some(s => hit(b, s));
      const inside = this.hulls().some(H => cx >= H.x0 && cx <= H.x1 && cy >= H.y0 && cy <= H.y1);
      if (ok(box(cx, cy)) && inside) return null;
      const dist = H => Math.hypot(Math.max(H.x0 - cx, 0, cx - H.x1), Math.max(H.y0 - cy, 0, cy - H.y1));
      const home = this.hulls().find(H => cx >= H.x0 && cx <= H.x1 && cy >= H.y0 && cy <= H.y1) || this.hulls().slice().sort((a, b) => dist(a) - dist(b))[0]; // outside every room: pull it into the nearest one
      const cands = [];
      for (let dy = -240; dy <= 240; dy += 4) for (let dx = -160; dx <= 160; dx += 8) cands.push([dx, dy, Math.hypot(dx, dy * 1.5)]);
      cands.sort((a, b) => a[2] - b[2]);
      for (const [dx, dy] of cands) {
        const b = box(cx + dx, cy + dy);
        if (home && !(b.x0 >= home.x0 && b.x1 <= home.x1 && b.y0 >= home.y0 && b.y1 <= home.y1)) continue;
        if (ok(b)) return [Math.round(cx + dx), Math.round(cy + dy)];
      }
      return null;
    }
    nudge(n) {
      if (/gun|periscope|loader|hardpoint|turret|coil|laser|cannon|depthcharge|engine|reactor|dockinghatch|door|hatch/i.test(X.get(n, 'identifier'))) return; // mounted through the hull or part of it
      const p = this.freeSpot(n); if (!p) return;
      const r = rectOf(n); X.set(n, 'rect', `${Math.round(p[0] - r[2] / 2)},${Math.round(p[1] + r[3] / 2)},${r[2]},${r[3]}`);
      this.log.push(`  moved ${X.get(n, 'identifier')} #${X.get(n, 'ID')} to ${p[0]},${p[1]} (it was inside a floor or wall)`);
    }
    wiresAt(n, conn) { return X.kids(this.connEl(n, conn), 'link').map(l => X.get(l, 'w')); }

    // ---------- wires ----------
    wire(a, ac, b, bc, color) {
      const A = this.ref(a), B = this.ref(b), ca = this.connEl(A, ac), cb = this.connEl(B, bc);
      const isPower = /^power/.test(ac) && /^power/.test(bc);
      const ident = WIRE_COLORS[color || (isPower ? 'red' : 'blue')] || color;
      const tpl = this.template(ident) || this.template('wire') || this.template('redwire');
      if (!tpl) throw new Error('no wire item to copy (the sub has no wires?)');
      const w = X.clone(tpl), id = this.newId();
      X.set(w, 'ID', id); X.set(w, 'identifier', ident);
      const [ax, ay] = centerOf(A), [bx, by] = centerOf(B), my = Math.round((ay + by) / 2);
      const nodes = [[Math.round(ax), Math.round(ay)], [Math.round(ax), my], [Math.round(bx), my], [Math.round(bx), Math.round(by)]];
      const r = rectOf(tpl); X.set(w, 'rect', `${nodes[0][0]},${nodes[0][1]},${r[2] || 42},${r[3] || 16}`);
      const wc = this.comp(w, 'Wire'); if (wc) X.set(wc, 'nodes', nodes.map(p => p.join(';')).join(';'));
      w.children = w.children.filter(c => c.tag !== 'ConnectionPanel');
      this.sub.children.push(w); this.items.set(id, w);
      ca.children.push(X.el('link', { w: id, i: 0 })); cb.children.push(X.el('link', { w: id, i: 1 }));
      this.log.push(`wire ${X.get(A, 'identifier')}#${X.get(A, 'ID')}.${ac} -> ${X.get(B, 'identifier')}#${X.get(B, 'ID')}.${bc} (${ident} #${id})`);
      return id;
    }
    unwire(a, ac, b, bc) {
      const A = this.ref(a), B = this.ref(b), wa = this.wiresAt(A, ac), wb = new Set(this.wiresAt(B, bc));
      const ws = wa.filter(w => wb.has(w)); if (!ws.length) throw new Error(`no wire between ${X.get(A, 'ID')}.${ac} and ${X.get(B, 'ID')}.${bc}`);
      for (const w of ws) this.removeWire(w);
      this.log.push(`unwire ${X.get(A, 'identifier')}#${X.get(A, 'ID')}.${ac} -/- ${X.get(B, 'identifier')}#${X.get(B, 'ID')}.${bc}`);
    }
    removeWire(wid) {
      for (const n of this.items.values()) { const p = this.panel(n); if (!p) continue; for (const c of p.children) c.children = c.children.filter(l => !(l.tag === 'link' && X.get(l, 'w') === String(wid))); }
      const w = this.items.get(String(wid)); if (w) { this.sub.children = this.sub.children.filter(c => c !== w); this.items.delete(String(wid)); }
    }

    // ---------- items ----------
    add(handle, identifier, x, y, props) {
      const tpl = this.template(identifier);
      let n;
      if (tpl) { n = X.clone(tpl); const p = n.children.find(c => c.tag === 'ConnectionPanel'); if (p) for (const c of p.children) c.children = c.children.filter(l => l.tag !== 'link'); for (const c of n.children) if (c.tag === 'ItemContainer') X.set(c, 'contained', ''); }
      else {
        const def = C.byItem(identifier);
        if (!def) throw new Error(`no template for "${identifier}": it is not in this sub or the template subs (give me a sub that has one, or its item XML)`);
        n = X.el('Item', { name: '', identifier, ID: '0', rect: '0,0,16,16' }, [X.el(def.cls, {}), X.el('Holdable', { Attached: 'True' })]); // logic part on a wall, no wires possible (prefab connection order unknown)
        this.log.push(`note: ${identifier} built from scratch (no template): it can't be wired from outside until a template is available`);
      }
      const hold = n.children.find(c => c.tag === 'Holdable'); if (hold) X.set(hold, 'Attached', 'True'); // placed items hang on the wall (a template saved loose would fall to the floor)
      const id = this.newId(); X.set(n, 'ID', id);
      const r = rectOf(n); X.set(n, 'rect', `${Math.round(x - r[2] / 2)},${Math.round(y + r[3] / 2)},${r[2]},${r[3]}`);
      this.sub.children.push(n); this.items.set(id, n); if (handle) this.handles[handle] = id;
      for (const [k, v] of Object.entries(props || {})) this.setProp(id, k, v);
      this.nudge(n);
      this.log.push(`add ${identifier} #${id}${handle ? ' (@' + handle + ')' : ''} at ${Math.round(x)},${Math.round(y)}`);
      return id;
    }
    remove(r) {
      const n = this.ref(r), id = X.get(n, 'ID'), p = this.panel(n);
      if (p) for (const c of p.children) for (const l of X.kids(c, 'link')) this.removeWire(X.get(l, 'w'));
      for (const c of n.children) if (c.tag === 'ItemContainer') for (const slot of (X.get(c, 'contained') || '').split(',')) for (const cid of slot.split(';').filter(Boolean)) { const ci = this.items.get(cid); if (ci) { this.sub.children = this.sub.children.filter(x => x !== ci); this.items.delete(cid); } }
      for (const o of this.items.values()) for (const c of o.children) if (c.tag === 'ItemContainer') { const v = X.get(c, 'contained'); if (v && v.split(/[,;]/).includes(id)) X.set(c, 'contained', v.split(',').map(s => s.split(';').filter(x => x !== id).join(';')).join(',')); }
      for (const o of this.sub.children) { const l = X.get(o, 'linked'); if (l && l.split(',').includes(String(id))) X.set(o, 'linked', l.split(',').filter(x => x !== String(id)).join(',')); } // e.g. loaders linked to turrets
      this.sub.children = this.sub.children.filter(c => c !== n); this.items.delete(String(id));
      this.log.push(`remove ${X.get(n, 'identifier')} #${id}`);
    }
    move(r, x, y) { const n = this.ref(r), rc = rectOf(n); X.set(n, 'rect', `${Math.round(x - rc[2] / 2)},${Math.round(y + rc[3] / 2)},${rc[2]},${rc[3]}`); }
    setProp(r, key, value) { // "Component.Attr" or an item attribute; a value "@handle" becomes that item's ID (e.g. linked=@loader)
      if (/^@\w+$/.test(String(value))) value = X.get(this.ref(value), 'ID');
      const n = this.ref(r), dot = key.indexOf('.');
      if (dot < 0) { X.set(n, key, value); return; }
      const cn = key.slice(0, dot), attr = key.slice(dot + 1);
      let c = this.comp(n, cn); if (!c) { c = X.el(cn, {}); n.children.splice(Math.max(0, n.children.findIndex(x => x.tag === 'ConnectionPanel')), 0, c); }
      X.set(c, attr, value);
    }

    // ---------- circuit boxes ----------
    // A circuit box item with its components (hidden items in container 0), internal wires (hidden wire items in
    // container 1, stacked 32 per slot) and the CircuitBox layout. bm: a bench box model (sim/format.js).
    box(handle, x, y, bm) {
      const tpl = this.template('circuitbox'); if (!tpl) throw new Error('no circuitbox template (none in this sub or the template subs)');
      const n = X.clone(tpl), id = this.newId(); X.set(n, 'ID', id);
      const rc = rectOf(n); X.set(n, 'rect', `${Math.round(x - rc[2] / 2)},${Math.round(y + rc[3] / 2)},${rc[2]},${rc[3]}`);
      const p = this.panel(n); if (p) for (const c of p.children) c.children = c.children.filter(l => l.tag !== 'link');
      const conts = n.children.filter(c => c.tag === 'ItemContainer');
      const cb = this.comp(n, 'CircuitBox');
      cb.children = [];
      if (bm.components.length > CIRCUITBOX_MAX_COMPONENTS) throw new Error(`circuit box "${bm.name}" has ${bm.components.length} components: the game's circuit box holds at most ${CIRCUITBOX_MAX_COMPONENTS} (the rest are lost on load). Split it into two boxes.`);
      F.autoLayout(bm);
      const slotIds = [], compIdx = {};
      bm.components.forEach((c, i) => {
        const def = C.byItem(c.item); if (!def) throw new Error(`circuit box: unknown component ${c.item}`);
        const ctpl = this.template(def.item), ci = ctpl ? X.clone(ctpl) : X.el('Item', { name: '', identifier: def.item, ID: '0', rect: '0,0,16,16' }, [X.el(def.cls, {})]);
        const cid = this.newId(); X.set(ci, 'ID', cid); X.set(ci, 'rect', `${rc[0]},${rc[1]},16,16`);
        ci.children = ci.children.filter(k => k.tag !== 'ConnectionPanel'); // no outside wires inside a box
        const h = ci.children.find(k => k.tag === 'Holdable'); if (h) X.del(h, 'Attached');
        let comp = this.comp(ci, def.cls); if (!comp) { comp = X.el(def.cls, {}); ci.children.unshift(comp); }
        for (const [k, v] of Object.entries(Object.assign({}, def.defaults, c.props))) X.set(comp, k, v);
        this.sub.children.push(ci); this.items.set(cid, ci); slotIds.push(cid); compIdx[c.id] = i;
      });
      if (conts[0]) X.set(conts[0], 'contained', slotIds.join(','));
      const wireIds = [];
      const io = (tag, pos, labels) => { const e = X.el(tag, { pos: (pos || [0, 0]).join(',') }); for (const [k, v] of Object.entries(labels)) e.children.push(X.el('ConnectionLabelOverride', { name: k, value: v })); return e; };
      const inL = Object.assign({}, bm.inLabels), outL = Object.assign({}, bm.outLabels);
      for (const [k, v] of Object.entries(bm.pins || {})) { if (!v || v === 'none') continue; const full = /^in\d$/.test(k) ? 'signal_' + k : 'signal_' + k; (full.includes('_in') ? inL : outL)[full] = v; }
      cb.children.push(io('InputNode', bm.inPos, inL), io('OutputNode', bm.outPos, outL));
      bm.components.forEach((c, i) => cb.children.push(X.el('Component', { id: i, position: c.pos.map(v => Math.round(v)).join(','), backingitemid: `${i},0`, usedresource: 'fpgacircuit' })));
      let wn = 0;
      bm.wires.forEach((w, k) => {
        const internal = w.from.c !== null && w.to.c !== null;
        let back = '';
        if (internal) { // a real wire item stacked in container 1
          const wtpl = this.template(w.prefab) || this.template('bluewire') || this.template('redwire');
          const wi = X.clone(wtpl), wid = this.newId(); X.set(wi, 'ID', wid); X.set(wi, 'identifier', w.prefab || 'bluewire'); X.set(wi, 'rect', `${rc[0]},${rc[1]},42,16`);
          const wc = this.comp(wi, 'Wire'); if (wc) X.del(wc, 'nodes');
          this.sub.children.push(wi); this.items.set(wid, wi); wireIds.push(wid);
          back = `${Math.floor(wn / 32)},${wn % 32}`; wn++;
        }
        const e = X.el('Wire', { id: k, backingitemid: back, prefab: w.prefab || 'bluewire' }, [
          X.el('From', { name: w.from.pin, target: w.from.c === null ? '' : String(compIdx[w.from.c]) }),
          X.el('To', { name: w.to.pin, target: w.to.c === null ? '' : String(compIdx[w.to.c]) })]);
        cb.children.push(e);
      });
      if (conts[1]) { const slots = []; for (let i = 0; i < wireIds.length; i += 32) slots.push(wireIds.slice(i, i + 32).join(';')); X.set(conts[1], 'contained', slots.join(',')); }
      bm.labels.forEach((l, i) => cb.children.push(X.el('Label', { id: i, color: l.color || '#7ED3E0', position: (l.pos || [-900, 900 + i * 300]).join(','), size: (l.size || [600, 250]).join(','), header: l.header || '', body: l.body || '' })));
      this.sub.children.push(n); this.items.set(id, n); if (handle) this.handles[handle] = id; this.nudge(n);
      this.log.push(`box ${handle ? '@' + handle + ' ' : ''}#${id}: ${bm.components.length} components, ${bm.wires.length} wires (${wireIds.length} inside)`);
      return id;
    }

    // ---------- checks: what the game's loader needs ----------
    check() {
      const problems = [], ids = new Set(), ends = new Map();
      for (const n of this.sub.children) { const id = X.get(n, 'ID'); if (id === undefined) continue; if (ids.has(id)) problems.push(`duplicate ID ${id}`); ids.add(id); }
      for (const n of this.items.values()) { const p = this.panel(n); if (!p) continue; for (const c of p.children) for (const l of X.kids(c, 'link')) { const w = X.get(l, 'w'); if (!ends.has(w)) ends.set(w, []); ends.get(w).push(`${X.get(n, 'ID')}.${X.get(c, 'name')}:${X.get(l, 'i')}`); } }
      for (const [w, e] of ends) {
        const wi = this.items.get(w);
        if (!wi || !this.comp(wi, 'Wire')) problems.push(`link to wire ${w} that does not exist (${e.join(', ')})`);
        else if (e.length !== 2) problems.push(`wire ${w} has ${e.length} ends (${e.join(', ')})`);
        else if (new Set(e.map(x => x.split(':')[1])).size !== 2) problems.push(`wire ${w} ends both use the same index (${e.join(', ')})`);
      }
      if (this.maxId > 65535) problems.push('more than 65535 IDs');
      for (const n of this.items.values()) {
        if (n.children.some(c => c.tag === 'CircuitBox')) { const k = (X.get(X.kids(n, 'ItemContainer')[0] || { attrs: [] }, 'contained') || '').split(',').filter(Boolean).length; if (k > CIRCUITBOX_MAX_COMPONENTS) problems.push(`circuit box ${X.get(n, 'ID')} holds ${k} components (max ${CIRCUITBOX_MAX_COMPONENTS})`); }
      }
      return problems;
    }

    // ---------- audit: everything that went wrong in game so far, checked before a human has to find it ----------
    // base: the original SubDoc (e.g. the vanilla sub) to spot items that moved. Returns [{ level: 'error'|'warn'|'info', msg }].
    audit(base) {
      const out = [], add = (level, msg) => out.push({ level, msg });
      for (const p of this.check()) add('error', p);
      const inBox = new Set();
      for (const n of this.items.values()) if (n.children.some(c => c.tag === 'CircuitBox')) for (const c of X.kids(n, 'ItemContainer')) for (const id of (X.get(c, 'contained') || '').split(/[,;]/)) if (id) inBox.add(id);
      const inCont = new Set(); // items stored in cabinets/lockers etc. are loose on purpose
      for (const n of this.items.values()) if (!n.children.some(c => c.tag === 'CircuitBox')) for (const c of X.kids(n, 'ItemContainer')) for (const id of (X.get(c, 'contained') || '').split(/[,;]/)) if (id) inCont.add(id);
      const baseIds = base ? new Set(base.items.keys()) : new Set();
      const tag = n => `${X.get(n, 'identifier')} #${X.get(n, 'ID')}`;
      for (const n of this.items.values()) {
        const id = X.get(n, 'ID'), idf = X.get(n, 'identifier');
        if (inBox.has(id) || inCont.has(id) || this.comp(n, 'Wire')) continue;
        const h = this.comp(n, 'Holdable');
        if (h && X.get(h, 'Attached') !== 'True' && !baseIds.has(id)) add('error', `${tag(n)} is not attached: it will fall to the floor`);
        if (!baseIds.has(id) && this.freeSpot(n) && !/gun|periscope|loader|hardpoint|turret|coil|laser|cannon|depthcharge|engine|reactor|door|hatch/i.test(idf)) add('warn', `${tag(n)} sits inside a floor or wall`);
        const r = rectOf(n), cx = r[0] + r[2] / 2, cy = r[1] - r[3] / 2;
        if (!baseIds.has(id) && !this.hulls().some(H => cx >= H.x0 && cx <= H.x1 && cy >= H.y0 && cy <= H.y1) && !/gun|turret|coil|laser|cannon|depthcharge|light/i.test(idf)) add('warn', `${tag(n)} is outside every room`);
        const p = this.panel(n); if (p) for (const c of p.children) { const k = X.kids(c, 'link').length; if (k > 5) add('info', `${tag(n)}.${X.get(c, 'name')} has ${k} wires (more than 5: loads fine, can't add more by hand)`); }
      }
      if (base) for (const [id, b] of base.items) {
        const n = this.items.get(id); if (!n || X.get(n, 'identifier') !== X.get(b, 'identifier')) continue;
        for (const k of ['rect', 'flippedx', 'flippedy', 'Rotation', 'Scale']) if (X.get(n, k) !== X.get(b, k)) add('warn', `${tag(n)} changed ${k}: ${X.get(b, k)} -> ${X.get(n, k)}`);
      }
      return out;
    }

    // ---------- patch language ----------
    apply(script, opts) {
      opts = opts || {};
      const lines = String(script).split(/\r?\n/);
      lines.forEach((raw, i) => {
        const line = raw.replace(/(^|\s)#.*$/, '').trim(); if (!line) return;
        const t = [...line.matchAll(/([^\s"=]+=)"([^"]*)"|"([^"]*)"|(\S+)/g)].map(m => m[1] !== undefined ? m[1] + m[2] : m[3] !== undefined ? m[3] : m[4]), cmd = t[0].toLowerCase(); // Key="a b" and "a b" keep spaces; Key="" is empty
        const ep = s => { const d = s.lastIndexOf('.'); if (d < 0) throw new Error(`"${s}": use <id or @handle>.<connection>`); return [s.slice(0, d), s.slice(d + 1)]; };
        const at = () => { const k = t.indexOf('at'); if (k < 0) throw new Error('missing "at x,y"'); const [x, y] = t[k + 1].split(',').map(Number); return [x, y, k]; };
        const kv = arr => { const o = {}; for (const s of arr) { const j = s.indexOf('='); if (j > 0) o[s.slice(0, j)] = s.slice(j + 1); } return o; };
        try {
          if (cmd === 'wire') { const [a, ac] = ep(t[1]), [b, bc] = ep(t[2]); this.wire(a, ac, b, bc, t[3]); }
          else if (cmd === 'unwire') { const [a, ac] = ep(t[1]), [b, bc] = ep(t[2]); this.unwire(a, ac, b, bc); }
          else if (cmd === 'add') { const h = t[1].startsWith('@') ? t[1].slice(1) : null, ident = h ? t[2] : t[1], [x, y, k] = at(); this.add(h, ident, x, y, kv(t.slice(k + 2))); }
          else if (cmd === 'remove') this.remove(t[1]);
          else if (cmd === 'move') { const [x, y] = t[2].split(',').map(Number); this.move(t[1], x, y); }
          else if (cmd === 'set') for (const [k, v] of Object.entries(kv(t.slice(2)))) this.setProp(t[1], k, v);
          else if (cmd === 'name') this.handles[t[1].replace(/^@/, '')] = X.get(this.ref(t[2]), 'ID');
          else if (cmd === 'box') {
            const h = t[1].startsWith('@') ? t[1].slice(1) : null, [x, y, k] = at(), fi = t.indexOf('from'), file = t[fi + 1], which = t.indexOf('box', 1) > 0 ? t[t.indexOf('box', 1) + 1] : null;
            if (!opts.readCircuit) throw new Error('box needs a circuit reader');
            const extra = {}; for (const kv of t.slice(fi + 2)) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(kv); if (m) extra[m[1]] = m[2]; } // box ... from file ROOM=Medbay -> $ROOM
            const model = opts.readCircuit(file, extra), bm = which ? model.boxes.find(b => b.name === which) : model.boxes[0];
            if (!bm) throw new Error(`no box "${which}" in ${file}`);
            this.box(h, x, y, JSON.parse(JSON.stringify(bm)));
          }
          else if (cmd === 'subname') X.set(this.sub, 'name', t.slice(1).join(' '));
          else throw new Error(`unknown command "${t[0]}" (wire, unwire, add, remove, move, set, name, box, subname)`);
        } catch (e) { throw new Error(`line ${i + 1}: ${e.message}\n  ${raw.trim()}`); }
      });
      X.set(this.sub, 'checkval', String(Math.floor(Math.random() * 2147483647))); // the game writes a new one on every save
      return this;
    }
  }
  return { SubDoc, WIRE_COLORS };
});
