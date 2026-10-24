// Draws a submarine as SVG, the same picture for the command line (`node sim/cli.js sub render`) and the web Sub Studio.
// What you see is the game's geometry, not a sketch:
//   * the outer shape = every exterior piece's real collision body (sim/shellgeom.js: rotated, offset and flipped like
//     Structure.cs), so slopes, humps and caps look like the sub's silhouette in game;
//   * inside walls, floor slabs, platforms and stairs the same way;
//   * rooms (hulls) as the space you walk in, with their names and sizes;
//   * doors, hatches and ladders; electrical items coloured by job; props (cabinets, deco) as outlines;
//   * wires along their saved nodes in the game's wire colours.
// The textures aren't part of the game's open-source code, so purely decorative sprites (fins, boards, bow plates with no
// collision) are drawn as their sprite boxes, clearly marked.
// Pass `base` (another parsed ship, e.g. the vanilla sub) to highlight what was ADDED: new items get an orange outline,
// new wires are drawn bright and the originals dimmed (or hidden with wires: 'added').
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shellgeom'));
  else root.BaroSubRender = factory(root.BaroShellGeom);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const r1 = v => Math.round(v * 10) / 10;
  // the game's wire item colours
  const WIRE = { redwire: '#c8392b', bluewire: '#2f6fd6', orangewire: '#e2862c', greenwire: '#3aa14a', blackwire: '#2b2b2b', whitewire: '#e8e8e8', yellowwire: '#e0c832', brownwire: '#7a5230', wire: '#9aa3a8' };
  const PALETTE = {
    sea: '#0a1c27', room: '#2a3a44', roomWet: '#24465a', roomText: '#c9d6dc', shell: '#8d7360', shellEdge: '#3a2c22', wall: '#7c8a93', wallEdge: '#3a454c',
    platform: '#9aa7ae', deco: 'rgba(141,115,96,.28)', decoEdge: 'rgba(141,115,96,.7)', gap: 'rgba(57,197,214,.55)', door: '#b7c2c8', ladder: '#d9b45a',
    added: '#ff8a3d', addedWire: '#ffb347', prop: 'rgba(200,190,170,.35)', grid: 'rgba(255,255,255,.06)',
    kind: { power: '#e8b13c', battery: '#7fd16a', reactor: '#ff6b4a', logic: '#5ed0c8', circuitbox: '#4fb3e8', light: '#f4e27a', door: '#b7c2c8', machine: '#b48cf0', sensor: '#7ac8ff', terminal: '#9be89b', weapon: '#e86a8a', other: '#c0c8cc' },
  };
  const EXTERIOR = /shell|bow|front|tail|fin|hatchcap|^ext|sshell/i;
  function itemKind(it) {
    const k = it.kinds || [], id = it.identifier || '';
    if (k.includes('Reactor')) return 'reactor';
    if (k.includes('PowerContainer')) return 'battery';
    if (k.includes('PowerTransfer') || k.includes('RelayComponent')) return 'power';
    if (it.box || k.includes('CircuitBox')) return 'circuitbox';
    if (it.logic || k.includes('WifiComponent')) return 'logic';
    if (k.includes('Door')) return 'door';
    if (k.includes('Turret') || /gun|coil|loader|periscope|railgun/i.test(id)) return 'weapon';
    if (k.includes('Terminal') || k.includes('Steering') || k.includes('ItemLabel') || k.includes('TextDisplay')) return 'terminal';
    if (k.some(c => /Detector|MotionSensor/.test(c))) return 'sensor';
    if (k.some(c => /Engine|Pump|OxygenGenerator|Fabricator|Deconstructor|Sonar|Vent/.test(c))) return 'machine';
    if (k.includes('LightComponent')) return 'light';
    return 'other';
  }
  function bounds(ship, pad) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (const h of ship.hulls) { add(h.rect[0], h.rect[1]); add(h.rect[0] + h.rect[2], h.rect[1] - h.rect[3]); }
    for (const s of ship.structures || []) if (G.solid(s)) for (const p of G.body(s).quad) add(p[0], p[1]);
    if (!isFinite(x0)) for (const it of ship.items) { add(it.rect[0], it.rect[1]); add(it.rect[0] + it.rect[2], it.rect[1] - it.rect[3]); }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  // what changed against a base sub (same IDs = original)
  function diff(ship, base) {
    if (!base) return null;
    const bi = new Set(base.items.map(i => i.id)), bw = new Set(base.wires.map(w => w.id)), bp = new Set((base.props || []).map(p => p.id));
    const bs = new Set((base.structures || []).map(s => s.id)), bh = new Set(base.hulls.map(h => h.id));
    return { items: new Set(ship.items.filter(i => !bi.has(i.id)).map(i => i.id)), wires: new Set(ship.wires.filter(w => !bw.has(w.id)).map(w => w.id)),
      props: new Set((ship.props || []).filter(p => !bp.has(p.id)).map(p => p.id)), structures: new Set((ship.structures || []).filter(s => !bs.has(s.id)).map(s => s.id)), hulls: new Set(ship.hulls.filter(h => !bh.has(h.id)).map(h => h.id)) };
  }
  // opts: { base, crop: [x0, y0, x1, y1] (sub coords, y up), width (px), wires: 'all'|'added'|'none', items: true, props: true,
  //         nav: false (gaps, ladders' waypoints), labels: 'rooms'|'added'|'all'|'none', grid: false, title }
  function render(ship, opts) {
    const o = Object.assign({ wires: 'all', items: true, props: true, nav: false, labels: 'rooms', grid: false, width: 2400, pad: 220 }, opts || {});
    const P = Object.assign({}, PALETTE, o.palette || {});
    const D = diff(ship, o.base), added = (set, id) => D && set.has(id);
    const [bx0, by0, bx1, by1] = o.crop || bounds(ship, o.pad);
    const W = bx1 - bx0, H = by1 - by0, k = W / o.width; // sub units per pixel
    const out = [];
    const rectPath = (r, extra) => `<rect x="${r1(r[0])}" y="${r1(-r[1])}" width="${r1(r[2])}" height="${r1(r[3])}" ${extra || ''}/>`;
    const poly = (q, extra) => `<polygon points="${q.map(p => r1(p[0]) + ',' + r1(-p[1])).join(' ')}" ${extra || ''}/>`;
    out.push(`<rect x="${r1(bx0)}" y="${r1(-by1)}" width="${r1(W)}" height="${r1(H)}" fill="${P.sea}"/>`);
    if (o.grid) { // 1 m grid, every 5 m stronger
      const g = []; for (let x = Math.ceil(bx0 / 100) * 100; x <= bx1; x += 100) g.push(`<line x1="${x}" y1="${-by1}" x2="${x}" y2="${-by0}" stroke="${P.grid}" stroke-width="${(x % 500 ? 1 : 2.5) * k}"/>`);
      for (let y = Math.ceil(by0 / 100) * 100; y <= by1; y += 100) g.push(`<line x1="${bx0}" y1="${-y}" x2="${bx1}" y2="${-y}" stroke="${P.grid}" stroke-width="${(y % 500 ? 1 : 2.5) * k}"/>`);
      out.push(`<g class="grid">${g.join('')}</g>`);
    }
    // rooms
    out.push('<g class="rooms">');
    for (const h of ship.hulls) out.push(rectPath(h.rect, `fill="${/ballast|tank|airlock|bilge|wet/i.test(h.label || h.name) ? P.roomWet : P.room}" data-k="hull" data-id="${h.id}"`));
    out.push('</g>');
    // decorative exterior sprites (no collision): their boxes, faint
    const structs = ship.structures || [];
    out.push('<g class="deco">');
    for (const s of structs) if (!G.solid(s) && EXTERIOR.test(s.identifier) && !insideAnyHull(ship, s.rect)) out.push(rectPath(s.rect, `fill="${P.deco}" stroke="${P.decoEdge}" stroke-width="${k}" stroke-dasharray="${4 * k} ${3 * k}" data-k="struct" data-id="${s.id}"`));
    out.push('</g>');
    // solid structure: shell (exterior) and inside walls, by their real bodies
    out.push('<g class="walls">');
    for (const s of structs) {
      const sp = G.prefab(s.identifier);
      if (sp && sp.stairs) { // the walkable plank, plus faint treads so it reads as stairs
        const b = G.body(s), [[x0, y0], [x1, y1]] = b.seg, n = Math.max(3, Math.round(b.len / 36)), tr = [];
        for (let i = 1; i < n; i++) { const tx = x0 + (x1 - x0) * i / n, ty = y0 + (y1 - y0) * i / n; tr.push(`M${tx.toFixed(1)} ${(-ty).toFixed(1)}h${(x1 > x0 ? -1 : 1) * 12}`); }
        out.push(poly(b.quad, `fill="${P.platform}" stroke="${added(D && D.structures, s.id) ? P.added : P.wallEdge}" stroke-width="${k}" data-k="struct" data-id="${s.id}"`) + `<path d="${tr.join('')}" stroke="${P.platform}" stroke-width="${2 * k}" fill="none"/>`);
        continue;
      }
      if (!G.solid(s)) continue;
      const pf = sp || {}, b = G.body(s), ext = EXTERIOR.test(s.identifier) || /shell/i.test(s.name || '');
      if (pf.platform) { out.push(poly(b.quad, `fill="none" stroke="${P.platform}" stroke-width="${3 * k}" data-k="struct" data-id="${s.id}"`)); continue; }
      const a = added(D && D.structures, s.id);
      out.push(poly(b.quad, `fill="${ext ? P.shell : P.wall}" stroke="${a ? P.added : ext ? P.shellEdge : P.wallEdge}" stroke-width="${(a ? 3 : 1) * k}" data-k="struct" data-id="${s.id}"`));
    }
    out.push('</g>');
    if (o.nav) { // gaps (openings) and the AI path
      out.push('<g class="nav">');
      for (const g of ship.gaps || []) out.push(rectPath(g.rect, `fill="${P.gap}"`));
      const wp = new Map((ship.waypoints || []).map(w => [w.id, w]));
      for (const w of ship.waypoints || []) for (const l of w.links) { const b = wp.get(l); if (b && w.id < b.id) out.push(`<line x1="${w.x}" y1="${-w.y}" x2="${b.x}" y2="${-b.y}" stroke="#9b7be0" stroke-width="${1.5 * k}" opacity=".6"/>`); }
      for (const w of ship.waypoints || []) if (w.spawn !== 'Path') out.push(`<circle cx="${w.x}" cy="${-w.y}" r="${6 * k}" fill="#e0457b"/>`);
      out.push('</g>');
    }
    // props: ladders and doors stand out, everything else is a faint outline
    if (o.props) {
      out.push('<g class="props">');
      for (const p of ship.props || []) {
        const lad = /ladder/i.test(p.identifier);
        out.push(rectPath(p.rect, lad ? `fill="none" stroke="${P.ladder}" stroke-width="${2 * k}" data-k="prop" data-id="${p.id}"` : `fill="none" stroke="${added(D && D.props, p.id) ? P.added : P.prop}" stroke-width="${k}" data-k="prop" data-id="${p.id}"`));
      }
      out.push('</g>');
    }
    // wires (the saved nodes; a wire without nodes is drawn straight between its two items)
    const byId = new Map(ship.items.map(i => [i.id, i])), centre = it => [it.rect[0] + it.rect[2] / 2, it.rect[1] - it.rect[3] / 2];
    if (o.wires !== 'none') {
      out.push('<g class="wires">');
      for (const w of ship.wires) {
        const isNew = added(D && D.wires, w.id); if (o.wires === 'added' && D && !isNew) continue;
        let pts = w.nodes && w.nodes.length >= 2 ? w.nodes : null;
        if (!pts) { const a = byId.get(w.from.item), b = byId.get(w.to.item); if (!a || !b) continue; pts = [centre(a), centre(b)]; }
        const col = isNew ? P.addedWire : (WIRE[w.color] || WIRE.wire), op = D ? (isNew ? .95 : .25) : .8;
        out.push(`<polyline points="${pts.map(p => r1(p[0]) + ',' + r1(-p[1])).join(' ')}" fill="none" stroke="${col}" stroke-width="${(isNew ? 2.2 : 1.6) * k}" opacity="${op}" stroke-linejoin="round" data-k="wire" data-id="${w.id}"/>`);
      }
      out.push('</g>');
    }
    // electrical items
    if (o.items) {
      out.push('<g class="items">');
      const mn = 10 * k;
      for (const it of ship.items) {
        const r = it.rect, w = Math.max(r[2], mn), h = Math.max(r[3], mn), x = r[0] + r[2] / 2 - w / 2, y = r[1] - r[3] / 2 + h / 2, kind = itemKind(it), a = added(D && D.items, it.id);
        const big = w * h > 40000 ? .35 : 1; // engines, reactors: a lighter fill so the room still shows
        out.push(`<rect x="${r1(x)}" y="${r1(-y)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(2 * k)}" fill="${P.kind[kind]}" fill-opacity="${(D && !a ? .45 : .9) * big}" stroke="${a ? P.added : '#000'}" stroke-width="${r1((a ? 3 : .8) * k)}" data-k="item" data-id="${it.id}" data-kind="${kind}"><title>${esc(it.identifier)} #${it.id}</title></rect>`);
      }
      out.push('</g>');
    }
    // labels
    if (o.labels !== 'none') {
      out.push('<g class="labels" font-family="DejaVu Sans, Arial, sans-serif">');
      const fs = 13 * k;
      for (const h of ship.hulls) {
        const [x, t, w, hh] = h.rect, name = h.label || h.name; if (!name || w < 60 * k) continue;
        out.push(`<text x="${r1(x + 6 * k)}" y="${r1(-t + fs + 5 * k)}" font-size="${r1(fs)}" fill="${P.roomText}" opacity=".85">${esc(name)}</text>`);
      }
      if (o.labels === 'added' || o.labels === 'all') for (const it of ship.items) {
        if (o.labels === 'added' && !(D && D.items.has(it.id))) continue;
        const [x, t] = it.rect; out.push(`<text x="${r1(x)}" y="${r1(-t - 3 * k)}" font-size="${r1(fs * .75)}" fill="${D && D.items.has(it.id) ? P.added : P.roomText}">${esc(it.identifier)}</text>`);
      }
      out.push('</g>');
    }
    if (o.title) out.push(`<text x="${r1(bx0 + 20 * k)}" y="${r1(-by1 + 34 * k)}" font-size="${r1(26 * k)}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" fill="#fff">${esc(o.title)}</text>`);
    const hpx = Math.round(o.width * H / W);
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(bx0)} ${r1(-by1)} ${r1(W)} ${r1(H)}" width="${o.width}" height="${hpx}">${out.join('')}</svg>`, width: o.width, height: hpx, view: [bx0, by0, bx1, by1], diff: D };
  }
  function insideAnyHull(ship, r) { const cx = r[0] + r[2] / 2, cy = r[1] - r[3] / 2; return ship.hulls.some(h => cx > h.rect[0] && cx < h.rect[0] + h.rect[2] && cy < h.rect[1] && cy > h.rect[1] - h.rect[3]); }
  return { render, itemKind, bounds, diff, PALETTE, WIRE };
});
