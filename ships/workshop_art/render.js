// Renders the Workshop art in src/thumbs.html to PNGs next to this file (one per .card).
// node ships/workshop_art/render.js   (needs Playwright with Chromium)
'use strict';
const path = require('path');
let pw; try { pw = require('playwright'); } catch (e) { pw = require(process.env.PW || '/opt/node-tools/node_modules/playwright'); }
(async () => {
  const b = await pw.chromium.launch(), p = await b.newPage({ viewport: { width: 2100, height: 1200 } });
  await p.goto('file://' + path.join(__dirname, 'src', 'thumbs.html'));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  for (const id of await p.$$eval('.card', cs => cs.map(c => c.id))) {
    const out = path.join(__dirname, (id === 'main' ? 'PreviewImage' : id) + '.png');
    await (await p.$('#' + id)).screenshot({ path: out });
    console.log('wrote', path.relative(process.cwd(), out));
  }
  await b.close();
})();
