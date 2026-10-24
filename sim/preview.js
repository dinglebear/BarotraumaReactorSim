// The sub's own picture. Every .sub carries the image the sub editor renders for the selection screen (previewimage, a
// 640 x 368 PNG drawn with the game's real sprites: SubEditorScreen.CreateImage). It is the only place the game's
// textures are available to us, so the Sub Studio and `sub render` draw it under everything else.
//
// CreateImage fits Submarine.CalculateDimensions(onlyHulls: false) into the image, centred. Our copy of that box (walls,
// items that aren't wires or inside something, rooms, gaps) comes out about 6 % smaller than the game's (turret barrels
// and things we don't model widen it), and an old picture can lag behind the sub. So instead of trusting the formula
// we line the picture up: start from the formula and search scale and offset for the best overlap between the
// picture's drawn pixels and the sub's pieces (intersection over union).
//
//   decodePng(buffer)                 -> { w, h, rgba }  (Node; the browser draws the image on a canvas instead)
//   register(rgba, w, h, ship)        -> { box: [x0, y0, x1, y1], scale, score }: the sub coordinates the image covers
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaroPreview = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // ---------- a small PNG reader (8-bit greyscale, RGB, RGBA, grey+alpha; no interlace) ----------
  function decodePng(buf) {
    const zlib = require('zlib');
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let p = 8, w = 0, h = 0, depth = 0, type = 0, inter = 0; const idat = [];
    while (p < buf.length) {
      const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
      if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
      else if (t === 'IDAT') idat.push(d);
      else if (t === 'IEND') break;
      p += 12 + len;
    }
    const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
    if (depth !== 8 || !ch || inter) throw new Error(`PNG type ${type}/${depth}${inter ? ' interlaced' : ''} not supported`);
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? out[dst + x - ch] : 0, b = y ? out[dst - stride + x] : 0, c = x >= ch && y ? out[dst - stride + x - ch] : 0, v = raw[src + x];
        let r;
        if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
        else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        out[dst + x] = r & 255;
      }
    }
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const s = i * ch;
      if (ch >= 3) { rgba[i * 4] = out[s]; rgba[i * 4 + 1] = out[s + 1]; rgba[i * 4 + 2] = out[s + 2]; rgba[i * 4 + 3] = ch === 4 ? out[s + 3] : 255; }
      else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = out[s]; rgba[i * 4 + 3] = ch === 2 ? out[s + 1] : 255; }
    }
    return { w, h, rgba };
  }
  // the rectangles CalculateDimensions looks at (as far as our model goes), in sub coordinates (y up)
  function pieces(ship) {
    const r = [];
    for (const s of ship.structures || []) r.push(s.rect);
    for (const it of ship.items || []) r.push(it.rect);
    for (const it of ship.props || []) r.push(it.rect);
    for (const h of ship.hulls || []) r.push(h.rect);
    for (const g of ship.gaps || []) r.push(g.rect);
    return r.filter(x => x && x[2] > 0 && x[3] > 0);
  }
  function register(rgba, w, h, ship) {
    const R = pieces(ship); if (!R.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of R) { x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1]); y0 = Math.min(y0, r[1] - r[3]); }
    // what the picture drew: anything that isn't the editor's background colour (the top-left pixel)
    const bg = [rgba[0], rgba[1], rgba[2]], mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = Math.abs(rgba[i * 4] - bg[0]) + Math.abs(rgba[i * 4 + 1] - bg[1]) + Math.abs(rgba[i * 4 + 2] - bg[2]) > 12 ? 1 : 0;
    // the sub's pieces on a grid of G units
    const G = 8, MW = Math.ceil((x1 - x0) / G) + 1, MH = Math.ceil((y1 - y0) / G) + 1, M = new Uint8Array(MW * MH);
    for (const r of R) {
      const a = Math.floor((r[0] - x0) / G), b = Math.ceil((r[0] + r[2] - x0) / G), c = Math.floor((y1 - r[1]) / G), d = Math.ceil((y1 - r[1] + r[3]) / G);
      for (let yy = Math.max(0, c); yy < Math.min(MH, d); yy++) M.fill(1, yy * MW + Math.max(0, a), yy * MW + Math.min(MW, b));
    }
    const s0 = Math.min(w / (x1 - x0), h / (y1 - y0)), cx0 = (x0 + x1) / 2, cy0 = (y0 + y1) / 2;
    const score = (s, dx, dy, step) => { // image pixel (px, py) shows sub point ((px - w/2 - dx) / s + cx0, -(py - h/2 - dy) / s + cy0)
      let inter = 0, uni = 0;
      for (let py = 0; py < h; py += step) {
        const wy = -((py + 0.5 - h / 2 - dy) / s) + cy0, my = Math.floor((y1 - wy) / G), rowOk = my >= 0 && my < MH;
        for (let px = 0; px < w; px += step) {
          const wx = (px + 0.5 - w / 2 - dx) / s + cx0, mx = Math.floor((wx - x0) / G);
          const m = rowOk && mx >= 0 && mx < MW ? M[my * MW + mx] : 0, c = mask[py * w + px];
          if (m && c) inter++; if (m || c) uni++;
        }
      }
      return uni ? inter / uni : 0;
    };
    let best = { sc: -1 };
    for (let k = 0.86; k <= 1.021; k += 0.01) for (let dx = -48; dx <= 48; dx += 4) for (let dy = -48; dy <= 48; dy += 4) {
      const sc = score(s0 * k, dx, dy, 4); if (sc > best.sc) best = { sc, k, dx, dy };
    }
    const c = best; best = Object.assign({}, c, { sc: score(s0 * c.k, c.dx, c.dy, 2) }); // finer sampling from here on
    for (let k = c.k - 0.01; k <= c.k + 0.0101; k += 0.002) for (let dx = c.dx - 4; dx <= c.dx + 4; dx++) for (let dy = c.dy - 4; dy <= c.dy + 4; dy++) {
      const sc = score(s0 * k, dx, dy, 2); if (sc > best.sc) best = { sc, k, dx, dy };
    }
    const s = s0 * best.k, cx = cx0 - best.dx / s, cy = cy0 + best.dy / s;
    return { box: [cx - w / 2 / s, cy - h / 2 / s, cx + w / 2 / s, cy + h / 2 / s].map(v => Math.round(v * 10) / 10), scale: s, score: Math.round(best.sc * 1000) / 1000, formula: s0 };
  }
  return { decodePng, register, pieces };
});
