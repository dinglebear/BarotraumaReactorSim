// SVG -> PNG with Playwright's Chromium when it's installed (the cloud dev box has it; it's optional elsewhere).
'use strict';
function playwright() {
  for (const p of ['playwright', process.env.PW, '/opt/node-tools/node_modules/playwright']) { if (!p) continue; try { return require(p); } catch (e) { } }
  return null;
}
async function svgToPng(svg, out, w, h) {
  const pw = playwright(); if (!pw) return false;
  const b = await pw.chromium.launch(); try {
    const p = await b.newPage({ viewport: { width: Math.min(w, 8000), height: Math.min(h, 8000) } });
    await p.setContent(`<html><body style="margin:0;background:#000">${svg}</body></html>`);
    await p.screenshot({ path: out, clip: { x: 0, y: 0, width: Math.min(w, 8000), height: Math.min(h, 8000) } });
  } finally { await b.close(); }
  return true;
}
module.exports = { svgToPng, playwright };
