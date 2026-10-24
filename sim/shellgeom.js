// Structure geometry the way the game builds it (Barotrauma Map/Structure.cs): every wall, shell piece and slope has a
// collision rectangle ("body") defined by its prefab (StructurePrefabs.xml): size bodywidth x bodyheight (0 = the rect's
// size), an offset from the rect centre, and a rotation. Flipping mirrors the offset and the angle. The catalog is
// ships/templates/structure_prefabs.json.
//
//   body(st)      -> { quad: 4 corners, seg: long-axis end points, cx, cy, len, thick, angle } in sub coordinates (y up)
//   solid(st)     -> does it collide (walls, shells, slopes; not backgrounds or decoration)
//   leaks(ship)   -> rays from every room that escape without hitting anything solid (a watertight check)
//   slopePieces() -> the slanted shell pieces as segment vectors, for the sub builder's corner smoothing
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../ships/templates/structure_prefabs.json'));
  else root.BaroShellGeom = factory(root.BaroStructurePrefabs || { prefabs: {} });
})(typeof self !== 'undefined' ? self : this, function (CAT) {
  'use strict';
  let P = CAT.prefabs || {};
  const lc = {}; for (const k of Object.keys(P)) lc[k.toLowerCase()] = P[k];
  const prefab = id => P[id] || lc[String(id || '').toLowerCase()] || null;
  const rad = d => d * Math.PI / 180;

  // Structure.IsHorizontal: the prefab's own flag, else resize direction, else the longer body side
  function isHorizontal(p, w, h) {
    if (p.horiz !== undefined) return p.horiz;
    if (p.rh && !p.rv) return true;
    if (p.rv && !p.rh) return false;
    if (p.bw > 0 && p.bh > 0) return p.bw > p.bh;
    return w > h; // no body size given: the rect decides (the game defaults to false here; only matters for flips)
  }
  // st: { identifier, rect: [x, top, w, h], flippedx, flippedy, scale, rotation (deg) }
  function body(st) {
    const p = prefab(st.identifier) || { bw: 0, bh: 0, off: [0, 0], rot: 0 };
    const [x, top, w, h] = st.rect, sc = st.scale || p.scale || 1, fx = !!st.flippedx, fy = !!st.flippedy, rotI = rad(st.rotation || 0);
    if (p.stairs) return stairBody(p, x, top, w, h, fx, fy);
    const horiz = isHorizontal(p, w, h);
    const bw = p.bw > 0 ? p.bw * sc : w, bh = p.bh > 0 ? p.bh * sc : h;
    // BodyRotation (radians, flips applied), then the body is set to -BodyRotation (Structure.CreateSections)
    let r = rad(p.rot || 0) + rotI;
    if (horiz) { if (fx) r = -Math.PI - r; if (fy) r = -r; } else { if (fx) r = -r; if (fy) r = -Math.PI - r; }
    const angle = -r;
    // BodyOffset: rotated by -RotationRad, then mirrored by the flips; scaled
    let [ox, oy] = p.off || [0, 0];
    if (rotI) { const c = Math.cos(-rotI), s = Math.sin(-rotI); [ox, oy] = [ox * c - oy * s, ox * s + oy * c]; }
    if (fx) ox = -ox; if (fy) oy = -oy;
    const cx = x + w / 2 + ox * sc, cy = top - h / 2 + oy * sc;
    const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy, vy = ux;
    const quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + ux * a * bw / 2 + vx * b * bh / 2, cy + uy * a * bw / 2 + vy * b * bh / 2]);
    const long = bw >= bh, L = long ? bw : bh, T = long ? bh : bw, dx = long ? ux : vx, dy = long ? uy : vy;
    const seg = [[cx - dx * L / 2, cy - dy * L / 2], [cx + dx * L / 2, cy + dy * L / 2]];
    return { quad, seg, cx, cy, len: L, thick: T, angle, horiz };
  }
  // Structure.CreateStairBodies: one 10 px plank at the stair angle (45 degrees), as wide as the rect, sitting in the
  // square at the bottom of the rect (the rest of the sprite is railing). "Right" stairs rise to the right; a flip in
  // either axis swaps the direction.
  function stairBody(p, x, top, w, h, fx, fy) {
    const right = (p.stairs === 'Right') !== (fx !== fy), a = rad(45), L = w / Math.cos(a), T = 10;
    const cx = x + w / 2, cy = fy ? top - w / 2 : top - h + w / 2, angle = right ? a : -a;
    const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy, vy = ux;
    const quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [cx + ux * i * L / 2 + vx * j * T / 2, cy + uy * i * L / 2 + vy * j * T / 2]);
    return { quad, seg: [[cx - ux * L / 2, cy - uy * L / 2], [cx + ux * L / 2, cy + uy * L / 2]], cx, cy, len: L, thick: T, angle, horiz: true, stairs: right ? 'Right' : 'Left' };
  }
  const SOLID_NAME = /^(Shell|Shuttle Shell|Large (Horizontal|Vertical) Inside Wall|Large Inside Wall Cap|Platform|Submarine Bow|Stairs)/i;
  function solid(st) { const p = prefab(st.identifier); if (p) return !!p.body && !p.platform && !p.stairs; return SOLID_NAME.test(st.name || ''); }

  // ---------- watertight check ----------
  function segHitsQuad(ax, ay, bx, by, q) { // does segment a-b cross the convex quad (or start inside it)?
    let inside = true;
    for (let i = 0; i < 4; i++) {
      const [px, py] = q[i], [qx, qy] = q[(i + 1) % 4];
      const s = (qx - px) * (ay - py) - (qy - py) * (ax - px); if (s < 0) inside = false;
      const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), d2 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      const d3 = (qx - px) * (ay - py) - (qy - py) * (ax - px), d4 = (qx - px) * (by - py) - (qy - py) * (bx - px);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
    return inside;
  }
  // Rays from points in every room; a ray that gets REACH units away without crossing a solid body is a leak.
  // Doors and hatches count as closed (their gaps are interior or airlocks). Returns [{ hull, from, to }].
  function leaks(ship, opts) {
    const o = Object.assign({ rays: 48, reach: 6000 }, opts || {});
    const quads = ship.structures.filter(solid).map(st => body(st).quad);
    for (const it of ship.props || []) if (/door|hatch/i.test(it.identifier)) { const [x, t, w, h] = it.rect; quads.push([[x, t - h], [x + w, t - h], [x + w, t], [x, t]]); }
    for (const it of ship.items || []) if (/door|hatch/i.test(it.identifier)) { const [x, t, w, h] = it.rect; quads.push([[x, t - h], [x + w, t - h], [x + w, t], [x, t]]); }
    const out = [];
    for (const h of ship.hulls) {
      const [x, t, w, hh] = h.rect, pts = [[x + w / 2, t - hh / 2], [x + 40, t - hh + 40], [x + w - 40, t - hh + 40], [x + 40, t - 40], [x + w - 40, t - 40]];
      for (const [px, py] of pts) for (let i = 0; i < o.rays; i++) {
        const a = 2 * Math.PI * i / o.rays, ex = px + Math.cos(a) * o.reach, ey = py + Math.sin(a) * o.reach;
        if (!quads.some(q => segHitsQuad(px, py, ex, ey, q))) { out.push({ hull: h.id, name: h.label || h.name, from: [Math.round(px), Math.round(py)], dir: Math.round(a * 180 / Math.PI) }); break; }
      }
    }
    return out;
  }

  // ---------- slanted pieces for the builder ----------
  // Every shell piece with a rotated body, as the vector along its body for the TOP-LEFT orientation ("/", outside
  // up-left), with the flips that give that orientation. Native orientation: the top side; "/" pieces are left-handed,
  // "\" pieces right-handed (vanilla subs place them that way: Camel humps, Dugong bow and stern).
  function slopePieces(filter) {
    const out = [];
    for (const [id, p] of Object.entries(P)) {
      if (!p.body || !p.rot || !/^s?shell/i.test(id) || (filter && !filter.test(id))) continue;
      const sc = p.scale || 1, b = body({ identifier: id, rect: [0, 0, p.w * sc, p.h * sc] });
      const [[x0, y0], [x1, y1]] = b.seg, slash = (x1 - x0) * (y1 - y0) > 0; // "/" when x and y grow together
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      if (dx < 20 || dy < 20) continue; // nearly straight
      out.push({ id, w: p.w * sc, h: p.h * sc, dx, dy, deg: Math.round(Math.atan2(dy, dx) * 180 / Math.PI), thick: b.thick, native: slash ? 'TL' : 'TR' });
    }
    return out.sort((a, b) => a.deg - b.deg || a.dx - b.dx);
  }
  // Place a piece so its body runs from point a to point b (the direction must match the piece's slope for the corner).
  // corner: 'TL' | 'TR' | 'BL' | 'BR' (which corner of the outline it smooths; outside is that way). Returns the
  // structure fields { identifier, rect, flippedx, flippedy } with the body centred on the a-b midpoint.
  function place(piece, corner, a, b) {
    const left = corner[1] === 'L', top = corner[0] === 'T', nativeLeft = piece.native === 'TL';
    const flippedx = left !== nativeLeft, flippedy = !top;
    const probe = body({ identifier: piece.id, rect: [0, 0, piece.w, piece.h], flippedx, flippedy });
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ox = probe.cx - piece.w / 2, oy = probe.cy + piece.h / 2; // body centre relative to the rect centre
    const cx = mx - ox, cy = my - oy;
    return { identifier: piece.id, rect: [Math.round(cx - piece.w / 2), Math.round(cy + piece.h / 2), Math.round(piece.w), Math.round(piece.h)], flippedx, flippedy };
  }
  return { body, solid, leaks, slopePieces, place, prefab, isHorizontal, setCatalog: c => { P = c.prefabs || {}; for (const k of Object.keys(P)) lc[k.toLowerCase()] = P[k]; } };
});
