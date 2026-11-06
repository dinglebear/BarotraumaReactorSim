// The text display's marquee, as the game's client draws it (ItemLabel.cs; reference/TEXT_DISPLAYS.md): which part of
// the text a player actually sees at any moment, including the snap-back that hides the end of a long text that keeps
// changing. Used by the sandbox and the ship mock to warn about displays nobody can read.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaroLabel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const AREA = 53, SPEED = 20; // text area width (world px) and scroll speed (px/s) of the vanilla text display
  // approximate advance widths of Exo2 SemiBold at 12 px (the font file isn't in the open source; see TEXT_DISPLAYS.md)
  const NARROW = new Set([...' il.,:;!|\'`ijI1()[]{}']);
  function charW(c) {
    if (c === ' ') return 3;
    if (NARROW.has(c)) return 3;
    if (c >= '0' && c <= '9') return 6.5;
    if (c >= 'A' && c <= 'Z') return /[MW]/.test(c) ? 9.5 : 7.3;
    if (/[mw]/.test(c)) return 9;
    if (c >= 'a' && c <= 'z') return 6;
    if (c === '%') return 9; if (c === '-' || c === '_' || c === '+' || c === '=' || c === '/') return 5;
    return 6;
  }
  const width = t => { let w = 0; for (const c of String(t)) w += charW(c); return w; };
  const fits = (t, area) => width(t) < (area || AREA);
  // one display's marquee state
  class Marquee {
    constructor(area) { this.area = area || AREA; this.text = ''; this.st = ''; this.idx = 0; this.amt = 0; this.scroll = false; this.changes = 0; }
    set(t) {
      t = String(t); if (t === this.text) return;              // identical text: nothing happens
      this.text = t; this.changes++;
      if (width(t) < this.area) { this.scroll = false; this.idx = 0; this.amt = 0; return; } // fits: static, scroll reset
      const nsp = Math.ceil(this.area / charW(' '));
      const wasScrolling = this.scroll; this.scroll = true; this.st = ' '.repeat(nsp) + t; this.pad = Math.max(...[...this.st].map(charW));
      this.idx = wasScrolling ? Math.min(Math.max(this.idx, 0), t.length) : 0; // the game clamps to the TEXT's length, not the scrolling string's
    }
    tick(dt) { // ItemLabel.Update: one character steps out when it has scrolled its own width; the fraction is dropped
      if (!this.scroll) return;
      this.amt -= SPEED * dt;
      if (this.amt < -charW(this.st[this.idx] || ' ')) { this.idx++; this.amt = 0; if (this.idx >= this.st.length) this.idx = 0; }
    }
    // the characters inside the box right now
    visible() {
      if (!this.scroll) return this.text;
      let x = this.pad + this.amt, s = '';
      for (let i = this.idx; i < this.st.length; i++) { const w = charW(this.st[i]); if (x + w > this.area) break; s += this.st[i]; x += w; }
      return s;
    }
  }
  // fraction of scrolling time the last characters of the shown text are inside the box
  function endFraction(texts, duration) {
    const m = new Marquee(); let i = 0, t = 0, scrollT = 0, endT = 0; const dt = 1 / 60;
    while (t < duration) {
      while (i < texts.length && texts[i].t <= t) m.set(texts[i++].text);
      m.tick(dt);
      if (m.scroll) { scrollT += dt; const tail = m.text.trimEnd().slice(-2); if (tail && m.visible().includes(tail)) endT += dt; }
      t += dt;
    }
    return { scrollT, endShown: scrollT ? endT / scrollT : 1, changes: m.changes };
  }
  // How readable is a display? texts = [{ t, text }] in time order (what set_text received). A text that fits is always
  // readable. A scrolling one is judged against the same text left alone: a full loop shows the end about a fifth of the
  // time, so a display that shows it less than half as often as that is losing its tail to the snap-back.
  // Returns { ok, endShown, baseline, longest, width, changes, reason }.
  function check(texts, duration, minRatio) {
    let longest = ''; for (const x of texts) if (width(x.text) > width(longest)) longest = x.text;
    const r = endFraction(texts, duration);
    if (!r.scrollT) return { ok: true, endShown: 1, baseline: 1, longest, width: width(longest), changes: r.changes, reason: '' };
    const baseline = endFraction([{ t: 0, text: longest }], Math.max(duration, 60)).endShown;
    const ok = r.endShown >= baseline * (minRatio || 0.5);
    return { ok, endShown: r.endShown, baseline, longest, width: width(longest), changes: r.changes,
      reason: ok ? '' : `"${longest}" is wider than the display (${Math.round(width(longest))} px > ${AREA}), so it scrolls, and it changes so often that its end is on screen ${Math.round(r.endShown * 100)} % of the time (${Math.round(baseline * 100)} % if it held still): the game snaps the scroll back on every change. Keep changing values to ~7 characters and put the caption on its own display.` };
  }
  return { Marquee, check, width, fits, charW, AREA, SPEED };
});
