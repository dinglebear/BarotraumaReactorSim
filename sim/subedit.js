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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./subxml'), require('./components'), require('./format'), require('./shellgeom'));
  else root.BaroSubEdit = factory(root.BaroSubXml, root.BaroComponents, root.BaroFormat, root.BaroShellGeom || { prefab: () => null });
})(typeof self !== 'undefined' ? self : this, function (X, C, F, G) {
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
      const n = this.items.get(String(id)) || this.elById(id); if (!n) throw new Error(`no item with ID ${id}`);
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
    // ---------- sub structure: rooms (hulls), walls/shells (structures), gaps, waypoints ----------
    // Rects are x (left), y (TOP, y up), w, h, like the game's. These are what a sub built from scratch is made of.
    templateEl(tag, identifier) {
      for (const d of [this, ...this.templates]) for (const n of d.sub.children) if (n.tag === tag && (!identifier || X.get(n, 'identifier') === identifier)) return n;
      return null;
    }
    elById(id) { return this.sub.children.find(n => X.get(n, 'ID') === String(id)); }
    addRaw(n, handle) { const id = this.newId(); X.set(n, 'ID', id); this.sub.children.push(n); if (n.tag === 'Item') this.items.set(id, n); if (handle) this.handles[handle] = id; this._solids = this._hulls = null; return id; }
    addHull(x, top, w, h, props, handle) { // Oxygen = full (volume = w x h)
      const t = this.templateEl('Hull'); const n = t ? X.clone(t) : X.el('Hull', {});
      n.children = []; X.set(n, 'rect', `${Math.round(x)},${Math.round(top)},${Math.round(w)},${Math.round(h)}`); X.set(n, 'water', '0'); X.set(n, 'Oxygen', String(Math.round(w * h))); X.del(n, 'linked');
      for (const [k, v] of Object.entries(props || {})) X.set(n, k, v);
      const id = this.addRaw(n, handle); this.log.push(`hull #${id} ${x},${top} ${w}x${h}${props && props.RoomName ? ' ' + props.RoomName : ''}`); return id;
    }
    addStructure(identifier, x, top, w, h, props, handle) { // walls, shells, backgrounds, platforms (resizable)
      let t = this.templateEl('Structure', identifier), generic = false;
      if (!t && G.prefab(identifier)) { t = this.templateEl('Structure', 'shella0deg') || this.templateEl('Structure'); generic = true; } // any vanilla structure from the prefab catalog
      if (!t) throw new Error(`no structure template "${identifier}" (in this sub, the template subs or ships/templates/structure_prefabs.json)`);
      const n = X.clone(t);
      if (generic) { const pf = G.prefab(identifier); X.set(n, 'identifier', identifier); X.set(n, 'name', ''); X.set(n, 'Scale', String(pf.scale || 1)); X.set(n, 'Rotation', '0'); }
      X.set(n, 'rect', `${Math.round(x)},${Math.round(top)},${Math.round(w)},${Math.round(h)}`); X.del(n, 'flippedx'); X.del(n, 'flippedy');
      n.children = n.children.filter(c => c.tag !== 'Upgrade');
      for (const [k, v] of Object.entries(props || {})) X.set(n, k, v);
      const id = this.addRaw(n, handle); return id;
    }
    addGap(x, top, w, h, horizontal, handle) { // horizontal=true: water/air flows sideways (a door in a vertical wall)
      const t = this.templateEl('Gap'); const n = t ? X.clone(t) : X.el('Gap', {});
      n.children = []; X.set(n, 'rect', `${Math.round(x)},${Math.round(top)},${Math.round(w)},${Math.round(h)}`); X.set(n, 'horizontal', horizontal ? 'true' : 'false');
      return this.addRaw(n, handle);
    }
    addWaypoint(x, y, opts, handle) { // opts: { spawn: 'Path'|'Human'|'Cargo'|'Enemy', job, ladders, gap }
      opts = opts || {};
      const n = X.el('WayPoint', { ID: '0', x: Math.round(x), y: Math.round(y), spawn: opts.spawn || 'Path' });
      if (opts.job) X.set(n, 'job', opts.job); if (opts.ladders) X.set(n, 'ladders', opts.ladders); if (opts.gap) X.set(n, 'gap', opts.gap);
      return this.addRaw(n, handle);
    }
    linkWaypoints(a, b) { // linkedto0, linkedto1... on both ends
      const A = this.elById(a), B = this.elById(b);
      const addTo = (n, id) => { const ks = n.attrs.filter(x => /^linkedto\d+$/.test(x[0])); if (ks.some(x => x[1] === String(id))) return; X.set(n, 'linkedto' + ks.length, String(id)); };
      addTo(A, b); addTo(B, a);
    }

    // ---------- placement: keep new fittings out of floors, ceilings and walls ----------
    // Solid structure = the sub's real walls (shell, inside walls and caps, platforms, bow, stairs); "Back Wall" and
    // background/deco pieces are only scenery. A room (hull) rectangle includes the thickness of its floor and ceiling,
    // so an item placed at a room's edge would sit inside the floor: nudge it to the nearest free spot in the same room.
    // solid pieces as their real collision shapes (sim/shellgeom.js: rotated, offset, flipped like the game), so a slope's
    // big sprite box doesn't push fittings away from the room it only clips
    solids() {
      if (!this._solids) this._solids = this.sub.children.filter(n => n.tag === 'Structure').map(n => {
        const id = X.get(n, 'identifier'), pf = G.prefab && G.prefab(id), r = rectOf(n);
        if (pf ? !(pf.body || pf.platform || pf.stairs) : !SOLID.test(X.get(n, 'name') || '')) return null;
        const q = pf ? G.body({ identifier: id, rect: r, flippedx: X.get(n, 'flippedx') === 'true', flippedy: X.get(n, 'flippedy') === 'true', scale: Number(X.get(n, 'Scale')) || 0, rotation: Number(X.get(n, 'Rotation')) || 0 }).quad
          : [[r[0], r[1] - r[3]], [r[0] + r[2], r[1] - r[3]], [r[0] + r[2], r[1]], [r[0], r[1]]];
        const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
        return { q, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      }).filter(Boolean);
      return this._solids;
    }
    hulls() { if (!this._hulls) this._hulls = this.sub.children.filter(n => n.tag === 'Hull').map(n => { const r = rectOf(n); return { x0: r[0], x1: r[0] + r[2], y1: r[1], y0: r[1] - r[3] }; }); return this._hulls; }
    // tol: how far an item may already overlap a wall and still count as fine (0 when placing; 16 when auditing a
    // finished sub: an attached item clipping a slope's plate by a few units is harmless in game)
    freeSpot(n, tol = 0) {
      const r = rectOf(n), w = r[2], h = r[3], cx = r[0] + w / 2, cy = r[1] - h / 2;
      const box = (x, y) => ({ x0: x - w / 2 - 2, x1: x + w / 2 + 2, y0: y - h / 2 - 2, y1: y + h / 2 + 2 }); // 2 px margin: rects are rounded when written
      const hit = (a, b) => { // box a against solid b: bounding boxes first, then separating axes against b's real shape
        if (!(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0)) return false;
        if (!b.q) return true;
        const A = [[a.x0, a.y0], [a.x1, a.y0], [a.x1, a.y1], [a.x0, a.y1]];
        for (const P of [A, b.q]) for (let i = 0; i < 4; i++) {
          const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % 4], nx = y2 - y1, ny = x1 - x2;
          const pa = A.map(p => p[0] * nx + p[1] * ny), pb = b.q.map(p => p[0] * nx + p[1] * ny);
          if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
        }
        return true;
      };
      const ok = b => !this.solids().some(s => hit(b, s));
      const inside = this.hulls().some(H => cx >= H.x0 && cx <= H.x1 && cy >= H.y0 && cy <= H.y1);
      const shrink = b => ({ x0: b.x0 + tol, x1: b.x1 - tol, y0: b.y0 + tol, y1: b.y1 - tol });
      if (ok(tol ? shrink(box(cx, cy)) : box(cx, cy)) && inside) return null;
      const dist = H => Math.hypot(Math.max(H.x0 - cx, 0, cx - H.x1), Math.max(H.y0 - cy, 0, cy - H.y1));
      const home = this.hulls().find(H => cx >= H.x0 && cx <= H.x1 && cy >= H.y0 && cy <= H.y1) || this.hulls().slice().sort((a, b) => dist(a) - dist(b))[0]; // outside every room: pull it into the nearest one
      const cands = [];
      for (let dy = -240; dy <= 240; dy += 4) for (let dx = -160; dx <= 160; dx += 8) cands.push([dx, dy, Math.hypot(dx, dy * 1.5)]);
      cands.sort((a, b) => a[2] - b[2]);
      for (const [dx, dy] of cands) {
        const b = box(cx + dx, cy + dy);
        if (home && !(b.x0 + 2 >= home.x0 && b.x1 - 2 <= home.x1 && b.y0 + 2 >= home.y0 && b.y1 - 2 <= home.y1)) continue;
        if (ok(b)) return [Math.round(cx + dx), Math.round(cy + dy)];
      }
      return null;
    }
    nudge(n) {
      if (/gun|periscope|loader|hardpoint|turret|coil|laser|cannon|depthcharge|engine|reactor|dockinghatch|dockingport|door|hatch|ladder/i.test(X.get(n, 'identifier'))) return; // mounted through the hull or part of it
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
      const nodes = this.route(centerOf(A), centerOf(B));
      const r = rectOf(tpl); X.set(w, 'rect', `${nodes[0][0]},${nodes[0][1]},${r[2] || 42},${r[3] || 16}`);
      const wc = this.comp(w, 'Wire'); if (wc) X.set(wc, 'nodes', nodes.map(p => p.join(';')).join(';'));
      w.children = w.children.filter(c => c.tag !== 'ConnectionPanel');
      this.sub.children.push(w); this.items.set(id, w);
      ca.children.push(X.el('link', { w: id, i: 0 })); cb.children.push(X.el('link', { w: id, i: 1 }));
      this.log.push(`wire ${X.get(A, 'identifier')}#${X.get(A, 'ID')}.${ac} -> ${X.get(B, 'identifier')}#${X.get(B, 'ID')}.${bc} (${ident} #${id})`);
      return id;
    }
    // Wire path like a tidy builder would run it (the nodes are what you see in game; they don't change what the wire does):
    // up from the device to a cable lane under its room's ceiling, along the lane, down/up along the wall of the target
    // room to that room's lane, along it, then down to the target. Parallel wires in a lane are spread 6 apart.
    // underside of the ceiling slab over the middle of room H (the hull rect includes part of the slab)
    ceiling(H) {
      this._ceil = this._ceil || new Map(); const key = H.x0 + ',' + H.y1; if (this._ceil.has(key)) return this._ceil.get(key);
      const m = (H.x0 + H.x1) / 2; let c = H.y1;
      for (const s of this.solids()) if (s.x0 < m + 48 && s.x1 > m - 48 && s.y0 < H.y1 && s.y0 > H.y1 - 80 && s.y1 >= H.y1 - 4) c = Math.min(c, s.y0);
      this._ceil.set(key, c); return c;
    }
    route(pa, pb) {
      const R = v => Math.round(v), hull = p => this.hulls().find(H => p[0] >= H.x0 && p[0] <= H.x1 && p[1] >= H.y0 && p[1] <= H.y1);
      const ha = hull(pa), hb = hull(pb);
      if (!ha || !hb) { const my = R((pa[1] + pb[1]) / 2); return [[R(pa[0]), R(pa[1])], [R(pa[0]), my], [R(pb[0]), my], [R(pb[0]), R(pb[1])]]; } // outside the rooms: the old dog-leg
      this._lanes = this._lanes || new Map();
      // up to 8 lanes, 5 apart, starting 8 below the room's real ceiling (the slab's underside, not the hull rect's top):
      // keep wall-mounted displays and boxes at least 50 below the ceiling and the bundles never cross them
      const lane = H => { const base = this.ceiling(H) - 8, k = this._lanes.get(base) || 0; this._lanes.set(base, k + 1); return Math.max(H.y0 + 30, base - 5 * (k % 8)); };
      const la = lane(ha), pts = [[pa[0], pa[1]], [pa[0], la]];
      if (ha === hb || Math.abs(ha.y1 - hb.y1) < 1 && Math.abs(ha.y0 - hb.y0) < 1) { pts.push([pb[0], la], [pb[0], pb[1]]); }
      else {
        const lb = lane(hb), xr = pa[0] >= hb.x0 && pa[0] <= hb.x1 ? Math.min(Math.max(pa[0], hb.x0 + 24), hb.x1 - 24) : (pa[0] < hb.x0 ? hb.x0 + 24 : hb.x1 - 24);
        pts.push([xr, la], [xr, lb], [pb[0], lb], [pb[0], pb[1]]);
      }
      const out = []; for (const p of pts.map(q => [R(q[0]), R(q[1])])) { const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); }
      // drop middle points that sit on a straight line
      return out.filter((p, i) => i === 0 || i === out.length - 1 || !((out[i - 1][0] === p[0] && p[0] === out[i + 1][0]) || (out[i - 1][1] === p[1] && p[1] === out[i + 1][1])));
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
      const n = this.ref(r), id = X.get(n, 'ID');
      if (n.tag !== 'Item') { this.sub.children = this.sub.children.filter(c => c !== n); this._solids = this._hulls = null; this.log.push(`remove ${n.tag} #${id}`); return; }
      const p = this.panel(n);
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
      const lp = F.layoutProblems(bm); if (lp.length) throw new Error(`circuit box "${bm.name}": ${lp.join('; ')}`);
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
      bm.labels.forEach((l, i) => cb.children.push(X.el('Label', { id: i, color: l.color || '#7ED3E0', position: (l.pos || [-3000, 3500]).map(v => Math.round(v)).join(','), size: (l.size || [1400, 300]).join(','), header: l.header || '', body: l.body || '' })));
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
        const cbx = n.children.find(c => c.tag === 'CircuitBox'); if (cbx) for (const c of cbx.children) { const p = (X.get(c, 'position') || X.get(c, 'pos') || '0,0').split(',').map(Number); if (Math.abs(p[0]) > 4096 || Math.abs(p[1]) > 4096) { problems.push(`circuit box ${X.get(n, 'ID')}: a ${c.tag} sits at ${p.join(',')}, outside the +-4096 area (it piles up at the border in game)`); break; } }
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
      for (const n of this.items.values()) { // long new wires (the nodes' length)
        const wc = this.comp(n, 'Wire'), id = X.get(n, 'ID'); if (!wc || baseIds.has(id)) continue;
        const v = (X.get(wc, 'nodes') || '').split(';').map(Number); let L = 0; for (let i = 2; i + 1 < v.length; i += 2) L += Math.hypot(v[i] - v[i - 2], v[i + 1] - v[i - 1]);
        if (L > 5000) add('info', `${tag(n)} is ${Math.round(L)} long: works, but nobody can re-run it by hand (Wire.MaxLength 5000); wifi is tidier at that distance`);
      }
      for (const n of this.items.values()) {
        const id = X.get(n, 'ID'), idf = X.get(n, 'identifier');
        if (inBox.has(id) || inCont.has(id) || this.comp(n, 'Wire')) continue;
        const h = this.comp(n, 'Holdable');
        if (h && X.get(h, 'Attached') !== 'True' && !baseIds.has(id)) add('error', `${tag(n)} is not attached: it will fall to the floor`);
        if (!baseIds.has(id) && this.freeSpot(n, 16) && !/gun|periscope|loader|hardpoint|turret|coil|laser|cannon|depthcharge|engine|reactor|door|hatch|ladder|dockingport/i.test(idf)) add('warn', `${tag(n)} sits inside a floor or wall`);
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
          else if (cmd === 'subattr') X.set(this.sub, t[1], raw.replace(/^\s*subattr\s+\S+\s+/, '').trim()); // any <Submarine> attribute, rest of the line verbatim (description, price, class...)
          // structure editing: hull @h x,top,w,h [RoomName=..]  |  structure @h <identifier> x,top,w,h [SpriteColor=..]
          //                    gap @h x,top,w,h horizontal|vertical  |  waypoint @h x,y [spawn=Human job=engineer gap=@g ladders=@l]  |  wplink @a @b
          else if (cmd === 'hull' || cmd === 'structure' || cmd === 'gap' || cmd === 'waypoint' || cmd === 'wplink') {
            const h = t[1] && t[1].startsWith('@') ? t[1].slice(1) : null, rest = h ? t.slice(2) : t.slice(1);
            const kv = {}; for (const x of rest) { const j = x.indexOf('='); if (j > 0) kv[x.slice(0, j)] = /^@\w+$/.test(x.slice(j + 1)) ? X.get(this.ref(x.slice(j + 1)), 'ID') : x.slice(j + 1); }
            const nums = rest.find(x => /^-?[\d.]+(,-?[\d.]+)+$/.test(x)); const r = nums ? nums.split(',').map(Number) : [];
            if (cmd === 'hull') this.addHull(r[0], r[1], r[2], r[3], kv, h);
            else if (cmd === 'structure') this.addStructure(rest[0], r[0], r[1], r[2], r[3], kv, h);
            else if (cmd === 'gap') this.addGap(r[0], r[1], r[2], r[3], rest.includes('horizontal'), h);
            else if (cmd === 'waypoint') this.addWaypoint(r[0], r[1], kv, h);
            else this.linkWaypoints(X.get(this.ref(t[1]), 'ID'), X.get(this.ref(t[2]), 'ID'));
          }
          else throw new Error(`unknown command "${t[0]}" (wire, unwire, add, remove, move, set, name, box, subname, hull, structure, gap, waypoint, wplink)`);
        } catch (e) { throw new Error(`line ${i + 1}: ${e.message}\n  ${raw.trim()}`); }
      });
      X.set(this.sub, 'checkval', String(Math.floor(Math.random() * 2147483647))); // the game writes a new one on every save
      return this;
    }
  }
  return { SubDoc, WIRE_COLORS };
});
