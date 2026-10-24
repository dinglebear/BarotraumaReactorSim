// Circuit components: catalog (names/defaults/pins for file I/O) + runtime behaviour.
// Behaviour mirrors Barotrauma's SharedSource/Items/Components/Signal/*.cs (see reference/BAROTRAUMA_MECHANICS.md).
// Runtime contract: comp.recv(pin, sig) is called the instant a signal arrives (same frame, recursive like the game);
// comp.update(dt) is called once per 1/60 s frame. comp.send(pin, valueOrSig) emits.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaroComponents = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const f32 = Math.fround;

  // ---- C# number parsing / formatting (InvariantCulture) ----
  // signals repeat a lot (steady state), so parsing/formatting is cached; results are frozen and shared
  const parseCache = new Map(), fmtCache = [new Map(), new Map()];
  const remember = (m, k, v) => { if (m.size > 20000) m.clear(); m.set(k, v); return v; };
  function parseF(s) { // float.TryParse(NumberStyles.Float) -> {ok, v}
    if (s == null) return { ok: false, v: 0 };
    const hit = parseCache.get(s); if (hit) return hit;
    return remember(parseCache, s, Object.freeze(parseF0(s)));
  }
  function parseF0(s) {
    const t = String(s).trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return { ok: true, v: f32(Number(t)) };
    const m = /^([+-]?)(Infinity|∞)$/i.exec(t); if (m) return { ok: true, v: m[1] === '-' ? -Infinity : Infinity };
    if (/^[+-]?NaN$/i.test(t)) return { ok: true, v: NaN };
    return { ok: false, v: 0 };
  }
  function parseI(s) { const t = String(s).trim(); if (!/^[+-]?\d+$/.test(t)) return { ok: false, v: 0 }; const v = Number(t); return (v > 2147483647 || v < -2147483648) ? { ok: false, v: 0 } : { ok: true, v }; }
  function shortest(x, maxP, round) { for (let p = 1; p <= maxP; p++) { const s = x.toPrecision(p); if (round(Number(s)) === x) return s; } return x.toPrecision(maxP); }
  // .NET Core "G" (shortest round-trip). sciAbove: 9 for float, 15 for double.
  function fmtG(x, isFloat) {
    if (Number.isInteger(x) && Math.abs(x) < 1e7 && !Object.is(x, -0)) return String(x); // fewer than 9 digits: plain
    const m = fmtCache[isFloat ? 1 : 0], hit = m.get(x); if (hit !== undefined) return hit;
    return remember(m, x, fmtG0(x, isFloat));
  }
  function fmtG0(x, isFloat) {
    if (Number.isNaN(x)) return 'NaN';
    if (x === Infinity) return 'Infinity'; if (x === -Infinity) return '-Infinity';
    if (x === 0) return Object.is(x, -0) ? '-0' : '0';
    const s = shortest(Math.abs(x), isFloat ? 9 : 17, isFloat ? f32 : (v => v));
    const m = /^(\d)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(Number(s).toExponential());
    const digits = (m[1] + (m[2] || '')).replace(/0+$/, '') || '0', exp = Number(m[3] || 0);
    const digPos = exp + 1, sign = x < 0 ? '-' : '';
    if (digPos > Math.max(digits.length, isFloat ? 9 : 17) || digPos < -3) {
      const e = exp; return sign + digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
    }
    if (digPos <= 0) return sign + '0.' + '0'.repeat(-digPos) + digits;
    if (digPos >= digits.length) return sign + digits + '0'.repeat(digPos - digits.length);
    return sign + digits.slice(0, digPos) + '.' + digits.slice(digPos);
  }
  const fmtF = x => fmtG(f32(x), true), fmtD = x => fmtG(x, false);
  const roundEven = x => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; };
  const clamp = (v, a, b) => { v = v > b ? b : v; return v < a ? a : v; }; // MathHelper.Clamp order: min wins when min > max
  const nearlyEq = (a, b, eps = 1e-4) => { // MathUtils.NearlyEqual
    if (a === b) return true; const d = Math.abs(a - b), s = Math.abs(a) + Math.abs(b);
    if (a === 0 || b === 0 || s < eps) return d < eps; return d / s < eps;
  };
  const bool = v => String(v).toLowerCase() === 'true';
  const STEP = 1 / 60;
  const F01 = Math.fround(0.1), TWO_PI_F = Math.fround(Math.PI * 2); // 0.1f, MathHelper.TwoPi

  // ---- catalog ----
  // alias: what you type in .circ; item: in-game identifier; cls: Class attr; defaults: InGameEditable props saved in .txt
  const CAT = [];
  function def(alias, item, cls, defaults, ins, outs, make, extra) { const d = Object.assign({ alias, item, cls, defaults, ins, outs, make }, extra || {}); CAT.push(d); return d; }
  const boolDefs = { TimeFrame: '0', Output: '1', FalseOutput: '0' };
  const arithDefs = { ClampMax: '999999', ClampMin: '-999999', TimeFrame: '0' };
  const IN12 = ['signal_in1', 'signal_in2'], OUT = ['signal_out'];

  // Boolean (And/Or/Xor): Update() each frame; output if state true (or false output non-empty).
  function makeBool(test) {
    return (c) => {
      const tf = () => Math.max(0, parseF(c.p.TimeFrame).v);
      const init = Math.max(f32(tf() * 2), F01); c.t = [init, init];
      c.recv = (pin, s) => {
        if (pin === 'signal_in1' || pin === 'signal_in2') { if (s.v === '0') return; c.t[pin === 'signal_in1' ? 0 : 1] = 0; }
        else if (pin === 'set_output') c.p.Output = s.v;
      };
      c.update = (dt) => {
        let n = 0; const T = tf();
        dt = f32(dt); for (let i = 0; i < 2; i++) { if (c.t[i] <= T) n++; c.t[i] = f32(c.t[i] + dt); }
        const out = test(n) ? c.p.Output : c.p.FalseOutput;
        if (out == null || out === '') return;
        c.send('signal_out', out);
      };
    };
  }
  def('and', 'andcomponent', 'AndComponent', boolDefs, [...IN12, 'set_output'], OUT, makeBool(n => n >= 2));
  def('or', 'orcomponent', 'OrComponent', boolDefs, [...IN12, 'set_output'], OUT, makeBool(n => n > 0));
  def('xor', 'xorcomponent', 'XorComponent', boolDefs, [...IN12, 'set_output'], OUT, makeBool(n => n === 1));

  // Arithmetic: Update() each frame; needs BOTH inputs received within TimeFrame (0 = since last update).
  function makeArith(calc) {
    return (c) => {
      const tf = () => Math.max(0, parseF(c.p.TimeFrame).v);
      const init = Math.max(f32(tf() * 2), F01); c.t = [init, init]; c.r = [0, 0];
      c.recv = (pin, s) => {
        if (pin === 'signal_in1') { c.r[0] = parseF(s.v).v; c.t[0] = 0; }
        else if (pin === 'signal_in2') { c.r[1] = parseF(s.v).v; c.t[1] = 0; }
      };
      c.update = (dt) => {
        let early = false; const T = tf();
        dt = f32(dt); for (let i = 0; i < 2; i++) { if (c.t[i] > T) early = true; c.t[i] = f32(c.t[i] + dt); }
        if (early) return;
        const o = calc(c.r[0], c.r[1]);
        if (!Number.isFinite(o)) return; // MathUtils.IsValid
        c.send('signal_out', fmtF(clamp(o, parseF(c.p.ClampMin).v, parseF(c.p.ClampMax).v)));
      };
    };
  }
  def('add', 'addercomponent', 'AdderComponent', arithDefs, IN12, OUT, makeArith((a, b) => f32(a + b)));
  def('sub', 'subtractcomponent', 'SubtractComponent', arithDefs, IN12, OUT, makeArith((a, b) => f32(a - b)));
  def('mul', 'multiplycomponent', 'MultiplyComponent', arithDefs, IN12, OUT, makeArith((a, b) => f32(a * b)));
  def('div', 'dividecomponent', 'DivideComponent', arithDefs, IN12, OUT, makeArith((a, b) => nearlyEq(b, 0) ? NaN : f32(a / b)));

  // Instant (ReceiveSignal) single-input math
  def('mod', 'modulocomponent', 'ModuloComponent', { Modulus: '1' }, ['signal_in', 'set_modulus'], OUT, (c) => {
    const setM = v => { c.m = nearlyEq(v, 0) ? 1 : v; }; setM(parseF(c.p.Modulus).v);
    c.recv = (pin, s) => {
      if (pin === 'set_modulus' || pin === 'modulus') setM(parseF(s.v).v);
      else if (pin === 'signal_in') { const v = parseF(s.v).v; c.fwd(s, 'signal_out', fmtF(f32(v % c.m))); }
    };
  });
  def('pow', 'powcomponent', 'ExponentiationComponent', { Exponent: '1' }, ['signal_in', 'set_exponent'], OUT, (c) => {
    c.e = parseF(c.p.Exponent).v;
    c.recv = (pin, s) => {
      if (pin === 'set_exponent' || pin === 'exponent') c.e = parseF(s.v).v;
      else if (pin === 'signal_in') c.fwd(s, 'signal_out', fmtF(f32(Math.pow(parseF(s.v).v, c.e))));
    };
  });
  const FN = {
    round: v => { v = f32(roundEven(v)); return v === 0 ? 0 : v; }, ceil: v => { v = Math.ceil(v); return v === 0 ? 0 : v; }, floor: v => Math.floor(v),
    factorial: v => { let n = Math.trunc(Math.min(v, 20)), r = 1n; for (let i = n; i > 0; i--) r *= BigInt(i); return f32(Number(r)); },
    abs: v => Math.abs(v), sqrt: v => v < 0 ? null : f32(Math.sqrt(v)),
  };
  for (const [a, item] of [['round', 'roundcomponent'], ['ceil', 'ceilcomponent'], ['floor', 'floorcomponent'], ['factorial', 'factorialcomponent'], ['abs', 'abscomponent'], ['sqrt', 'squarerootcomponent']])
    def(a, item, 'FunctionComponent', {}, ['signal_in'], OUT, (c) => {
      c.recv = (pin, s) => { if (pin !== 'signal_in') return; const p = parseF(s.v); if (!p.ok) return; const r = FN[a](p.v); if (r === null) return; c.fwd(s, 'signal_out', fmtF(r)); };
    });
  const D2R = Math.PI / 180;
  for (const [a, item] of [['sin', 'sincomponent'], ['cos', 'coscomponent'], ['tan', 'tancomponent'], ['asin', 'asincomponent'], ['acos', 'acoscomponent'], ['atan', 'atancomponent']])
    def(a, item, 'TrigonometricFunctionComponent', { UseRadians: 'false' }, a === 'atan' ? ['signal_in', 'signal_in_x', 'signal_in_y'] : ['signal_in'], OUT, (c) => {
      const rad = () => bool(c.p.UseRadians); c.r = [0, 0]; c.t = [0, 0]; // float[] fields start at 0
      c.recv = (pin, s) => {
        let v = parseF(s.v).v;
        if (a === 'sin') v = f32(Math.sin(rad() ? v : f32(v * D2R)));
        else if (a === 'cos') v = f32(Math.cos(rad() ? v : f32(v * D2R)));
        else if (a === 'tan') { if (!rad()) v = f32(v * D2R); if (!nearlyEq(v % Math.PI, Math.PI / 2)) v = f32(Math.tan(v)); }
        else if (a === 'asin' || a === 'acos') { if (v >= -1 && v <= 1) { const g = f32((a === 'asin' ? Math.asin : Math.acos)(v)); v = rad() ? g : f32(g / D2R); } }
        else if (a === 'atan') {
          if (pin === 'signal_in_x') { c.t[0] = 0; c.r[0] = v; return; }
          if (pin === 'signal_in_y') { c.t[1] = 0; c.r[1] = v; return; }
          const g = f32(Math.atan(v)); v = rad() ? g : f32(g / D2R);
        }
        c.fwd(s, 'signal_out', fmtF(v));
      };
      if (a === 'atan') c.update = (dt) => {
        dt = f32(dt); for (let i = 0; i < 2; i++) { c.t[i] = f32(c.t[i] + dt); if (c.t[i] > F01) c.r[i] = NaN; }
        if (!Number.isNaN(c.r[0]) && !Number.isNaN(c.r[1])) { let g = f32(Math.atan2(c.r[1], c.r[0])); if (!rad()) g = f32(g / D2R); c.send('signal_out', fmtF(g)); }
      };
    });

  // Not: instant; with ContinuousOutput also outputs "1" each frame nothing was received.
  def('not', 'notcomponent', 'NotComponent', { ContinuousOutput: 'false' }, ['signal_in'], OUT, (c) => {
    c.got = false;
    c.recv = (pin, s) => { if (pin !== 'signal_in') return; c.fwd(s, 'signal_out', (s.v === '0' || s.v === '') ? '1' : '0'); c.got = true; };
    c.update = () => { if (!bool(c.p.ContinuousOutput)) return; if (!c.got) c.send('signal_out', '1'); c.got = false; };
  });

  // Greater / Equals: Update() each frame while ANY input is fresh (within TimeFrame).
  function makeCmp(isGreater) {
    return (c) => {
      const tf = () => Math.max(0, parseF(c.p.TimeFrame).v);
      const init = Math.max(f32(tf() * 2), F01); c.t = [init, init]; c.r = isGreater ? [0, 0] : [undefined, undefined];
      c.recv = (pin, s) => {
        if (pin === 'signal_in1' || pin === 'signal_in2') { const i = pin === 'signal_in1' ? 0 : 1; c.r[i] = isGreater ? parseF(s.v).v : s.v; c.t[i] = 0; }
        else if (pin === 'set_output') c.p.Output = s.v;
      };
      c.update = (dt) => {
        let send = false; const T = tf();
        dt = f32(dt); for (let i = 0; i < 2; i++) { if (c.t[i] <= T) send = true; c.t[i] = f32(c.t[i] + dt); }
        if (!send) return;
        const out = (isGreater ? c.r[0] > c.r[1] : c.r[0] === c.r[1]) ? c.p.Output : c.p.FalseOutput;
        if (out == null || out === '') return;
        c.send('signal_out', out);
      };
    };
  }
  def('greater', 'greatercomponent', 'GreaterComponent', boolDefs, [...IN12, 'set_output'], OUT, makeCmp(true));
  def('equals', 'equalscomponent', 'EqualsComponent', boolDefs, [...IN12, 'set_output'], OUT, makeCmp(false));

  def('check', 'signalcheckcomponent', 'SignalCheckComponent', { Output: '1', FalseOutput: '0', TargetSignal: '' }, ['signal_in', 'set_output', 'set_targetsignal'], OUT, (c) => {
    c.recv = (pin, s) => {
      if (pin === 'signal_in') { const o = s.v === c.p.TargetSignal ? c.p.Output : c.p.FalseOutput; if (o == null || o === '') return; c.fwd(s, 'signal_out', o); }
      else if (pin === 'set_output') c.p.Output = s.v;
      else if (pin === 'set_targetsignal') c.p.TargetSignal = s.v;
    };
  });

  // Memory: outputs its value every frame. Writeable is an [Editable] prop (not in-game editable), default true.
  def('mem', 'memorycomponent', 'MemoryComponent', { Value: '' }, ['signal_in', 'signal_store', 'lock_state'], OUT, (c) => {
    c.w = c.p.Writeable === undefined ? true : bool(c.p.Writeable);
    c.recv = (pin, s) => {
      if (pin === 'signal_in') { if (c.w) c.p.Value = String(s.v).slice(0, 200); }
      else if (pin === 'signal_store' || pin === 'lock_state') c.w = s.v === '1';
    };
    c.update = () => c.send('signal_out', c.p.Value);
  });

  // Delay: tick based queue (delayTicks = (int)(Delay / (1/60))). Note: Delay 0 never outputs (queue size 0 quirk).
  def('delay', 'delaycomponent', 'DelayComponent', { Delay: '1', ResetWhenSignalReceived: 'false', ResetWhenDifferentSignalReceived: 'false' }, ['signal_in', 'set_delay'], OUT, (c) => {
    c.q = []; c.prev = null; c.delay = 0; c.ticks = 0; c.qsize = 0;
    const setDelay = (v) => { if (v === c.delay) return; c.delay = v; c.ticks = Math.trunc(f32(v) / STEP); c.qsize = Math.max(c.ticks, 1) * 2; c.q = []; };
    setDelay(parseF(c.p.Delay).v);
    c.recv = (pin, s) => {
      if (pin === 'signal_in') {
        if (c.q.length >= c.qsize) return;
        if (bool(c.p.ResetWhenSignalReceived)) { c.prev = null; c.q = []; }
        if (bool(c.p.ResetWhenDifferentSignalReceived) && c.q.length && c.q[0].v !== s.v) { c.prev = null; c.q = []; }
        const p = c.prev;
        if (p && p.v === s.v && ((p.timer + p.dur === c.ticks) || (p.timer <= 0 && p.dur > 0))) { p.dur++; return; }
        c.prev = { v: s.v, timer: c.ticks, dur: 1 }; c.q.push(c.prev);
      } else if (pin === 'set_delay') {
        const r = parseF(String(s.v).replace(/,/g, '')); if (!r.ok) return; const nd = clamp(r.v, 0, 60); // NumberStyles.Any
        if (c.q.length && nd !== c.delay) { c.prev = null; c.q = []; }
        setDelay(nd); c.p.Delay = fmtF(nd);
      }
    };
    c.update = () => {
      if (!c.q.length) return;
      for (const e of c.q) e.timer--;
      while (c.q.length && c.q[0].timer <= 0) {
        const e = c.q[0]; e.dur--; c.send('signal_out', e.v);
        if (e.dur <= 0) c.q.shift(); else break;
      }
    };
  });

  def('osc', 'oscillator', 'OscillatorComponent', { OutputType: 'Pulse', Frequency: '1' }, ['set_frequency', 'set_outputtype'], OUT, (c) => {
    c.ph = 0; c.f = clamp(parseF(c.p.Frequency).v, 0, 240);
    c.recv = (pin, s) => {
      if (pin === 'set_frequency' || pin === 'frequency_in') { const r = parseF(s.v); if (r.ok) { c.f = clamp(r.v, 0, 240); c.p.Frequency = fmtF(c.f); } }
      else if (pin === 'set_outputtype' || pin === 'set_wavetype') { if (/^(Pulse|Sawtooth|Sine|Square|Triangle|[0-4])$/.test(s.v)) c.p.OutputType = /^\d$/.test(s.v) ? ['Pulse', 'Sawtooth', 'Sine', 'Square', 'Triangle'][+s.v] : s.v; }
    };
    c.update = (dt) => { // all float, like OscillatorComponent.Update
      const t = c.p.OutputType; dt = f32(dt);
      if (t === 'Pulse') { if (c.f <= 0) return; c.ph = f32(c.ph + dt); const iv = f32(1 / c.f); while (c.ph >= iv) { c.send('signal_out', '1'); c.ph = f32(c.ph - iv); } return; }
      c.ph = f32(f32(c.ph + f32(dt * c.f)) % 1);
      if (t === 'Sawtooth') c.send('signal_out', fmtF(c.ph));
      else if (t === 'Square') c.send('signal_out', c.ph < 0.5 ? '0' : '1');
      else if (t === 'Sine') c.send('signal_out', fmtD(Math.sin(f32(c.ph * TWO_PI_F))));
      else if (t === 'Triangle') { const a = f32(c.ph - 0.25), pm = f32(f32(f32(a % 1) + 1) % 1); c.send('signal_out', fmtF(f32(f32(4 * Math.abs(f32(pm - 0.5))) - 1))); }
    };
  });

  def('relay', 'relaycomponent', 'RelayComponent', { IsOn: 'true' }, ['signal_in1', 'signal_in2', 'toggle', 'set_state'], ['signal_out1', 'signal_out2', 'state_out', 'load_value_out', 'power_value_out'], (c) => {
    c.on = bool(c.p.IsOn);
    c.recv = (pin, s) => {
      const m = /^signal_in(\d?)$/.exec(pin);
      if (m) { if (c.on) c.fwd(s, 'signal_out' + m[1], s.v); }
      else if (pin === 'toggle') { if (s.v !== '0') c.on = !c.on; }
      else if (pin === 'set_state') c.on = s.v !== '0';
    };
    c.update = () => { c.send('state_out', c.on ? '1' : '0'); c.send('power_value_out', '0'); c.send('load_value_out', '0'); }; // no power grid on a signal relay
  });

  def('concat', 'concatcomponent', 'ConcatComponent', { Separator: '', TimeFrame: '0' }, IN12, OUT, (c) => {
    const tf = () => Math.max(0, parseF(c.p.TimeFrame).v);
    const init = Math.max(f32(tf() * 2), F01); c.t = [init, init]; c.r = ['', ''];
    c.recv = (pin, s) => { if (pin === 'signal_in1') { c.r[0] = s.v; c.t[0] = 0; } else if (pin === 'signal_in2') { c.r[1] = s.v; c.t[1] = 0; } };
    c.update = (dt) => {
      let early = false; const T = tf();
      dt = f32(dt); for (let i = 0; i < 2; i++) { if (c.t[i] > T) early = true; c.t[i] = f32(c.t[i] + dt); }
      if (early) return;
      const o = c.p.Separator ? c.r[0] + c.p.Separator + c.r[1] : c.r[0] + c.r[1];
      c.send('signal_out', o.slice(0, 256));
    };
  });

  def('color', 'colorcomponent', 'ColorComponent', { UseHSV: 'false' }, ['signal_r', 'signal_g', 'signal_b', 'signal_a'], OUT, (c) => {
    c.r = [0, 0, 0, 0]; c.out = '0,0,0,0';
    c.recv = (pin, s) => {
      const i = ['signal_r', 'signal_g', 'signal_b', 'signal_a'].indexOf(pin); if (i < 0) return; c.r[i] = parseF(s.v).v;
      if (bool(c.p.UseHSV)) { // ToolBoxCore.HSVToRGB in float: hue clamped (not wrapped) to 0-360, s and v not clamped; Color() truncates to 0-255
        const v = c.r[2], ch = f32(v * c.r[1]), h = f32(clamp(c.r[0], 0, 360) / 60), x = f32(ch * f32(1 - Math.abs(f32(f32(h % 2) - 1))));
        let rgb = [0, 0, 0];
        if (0 <= h && h <= 1) rgb = [ch, x, 0]; else if (1 < h && h <= 2) rgb = [x, ch, 0]; else if (2 < h && h <= 3) rgb = [0, ch, x];
        else if (3 < h && h <= 4) rgb = [0, x, ch]; else if (4 < h && h <= 5) rgb = [x, 0, ch]; else if (5 < h && h <= 6) rgb = [ch, 0, x];
        const m = f32(v - ch), byte = q => { const n = Math.trunc(f32(f32(q + m) * 255)); return Number.isNaN(n) ? 0 : Math.max(0, Math.min(255, n)); };
        c.out = rgb.map(q => String(byte(q))).concat(fmtF(c.r[3])).join(',');
      } else c.out = c.r.map(fmtF).join(',');
    };
    c.update = () => c.send('signal_out', c.out);
  });

  def('regex', 'regexcomponent', 'RegExFindComponent', { Output: '1', UseCaptureGroup: 'false', OutputEmptyCaptureGroup: 'false', FalseOutput: '0', ContinuousOutput: 'true', Expression: '' }, ['signal_in', 'set_output'], OUT, (c) => {
    c.sent = true; c.prevIn = ''; c.res = false; c.groups = null; c.rx = null; c.rxSrc = null;
    c.recv = (pin, s) => { if (pin === 'signal_in') { c.inp = s.v; c.sent = false; } else if (pin === 'set_output') c.p.Output = s.v; };
    c.update = () => {
      if (c.rxSrc !== c.p.Expression) { c.rxSrc = c.p.Expression; c.prevIn = ''; try { let fl = ''; const src = c.p.Expression.replace(/\(\?([ims]+)\)/g, (a, f) => { for (const ch of f) if (!fl.includes(ch)) fl += ch; return ''; }); c.rx = new RegExp(src, fl); } catch (e) { c.rx = null; } } // .NET inline (?i) (?m) (?s) -> JS flags
      if (!c.p.Expression || !c.p.Expression.trim() || !c.rx) return;
      const cont = bool(c.p.ContinuousOutput);
      if (!cont && c.sent) return;
      if (c.inp !== c.prevIn && c.inp != null) { const m = c.rx.exec(c.inp); c.res = !!m; c.groups = bool(c.p.UseCaptureGroup) && m ? m : null; c.prevIn = c.inp; }
      let out, allowEmpty = false;
      if (c.res) {
        if (bool(c.p.UseCaptureGroup)) { // Groups.TryGetValue: a group that exists but didn't take part gives "" (sent only with OutputEmptyCaptureGroup)
          const m = c.groups, k = c.p.Output, has = m && ((/^\d+$/.test(k) && Number(k) < m.length) || (m.groups && Object.prototype.hasOwnProperty.call(m.groups, k)));
          if (has) { const g = /^\d+$/.test(k) && Number(k) < m.length ? m[Number(k)] : m.groups[k]; out = g == null ? '' : g; allowEmpty = bool(c.p.OutputEmptyCaptureGroup); } else out = c.p.FalseOutput; }
        else out = c.p.Output;
      } else out = c.p.FalseOutput;
      if ((out != null && out !== '') || (allowEmpty && out === '')) c.send('signal_out', out);
      if (!cont) c.sent = true;
    };
  });

  // Multiplexer / Demultiplexer (10 numbered pins: 0..9)
  function makeSel(isMux) {
    return (c) => {
      const N = 10; const nameOf = i => (isMux ? 'signal_in' : 'signal_out') + i;
      c.sel = Math.min(Math.max(0, parseI(c.p.SelectedConnection).v), N - 1);
      const set = (v) => { c.sel = Math.min(Math.max(0, v), N - 1); c.p.SelectedConnection = String(c.sel); };
      const move = (a) => { if (bool(c.p.WrapAround)) set(((c.sel + a) % N + N) % N); else set(c.sel + a); };
      c.recv = (pin, s) => {
        if (isMux && /^signal_in\d$/.test(pin)) { if (pin === nameOf(c.sel)) c.fwd(s, 'signal_out', s.v); return; }
        if (!isMux && pin === 'signal_in') { c.fwd(s, nameOf(c.sel), s.v); return; }
        if (pin === (isMux ? 'set_input' : 'set_output')) { const r = parseI(s.v); if (r.ok) set(r.v); }
        else if (pin === (isMux ? 'move_input' : 'move_output')) {
          const r = parseI(s.v); if (!r.ok) return;
          if (bool(c.p.SkipEmptyConnections)) { for (let i = 0; i < N; i++) { move(r.v); if (c.isWired(nameOf(c.sel))) break; } }
          else move(r.v);
        }
      };
      c.update = () => { const o = isMux ? 'selected_input_out' : 'selected_output_out'; if (c.isWired(o)) c.send(o, String(c.sel)); };
    };
  }
  const selDefs = { SelectedConnection: '0', WrapAround: 'true', SkipEmptyConnections: 'true' };
  def('mux', 'multiplexercomponent', 'MultiplexerComponent', selDefs, ['signal_in0', 'signal_in1', 'signal_in2', 'signal_in3', 'signal_in4', 'signal_in5', 'signal_in6', 'signal_in7', 'signal_in8', 'signal_in9', 'set_input', 'move_input'], ['signal_out', 'selected_input_out'], makeSel(true));
  def('demux', 'demultiplexercomponent', 'DemultiplexerComponent', selDefs, ['signal_in', 'set_output', 'move_output'], ['signal_out0', 'signal_out1', 'signal_out2', 'signal_out3', 'signal_out4', 'signal_out5', 'signal_out6', 'signal_out7', 'signal_out8', 'signal_out9', 'selected_output_out'], makeSel(false));

  // Wifi: forwards signal_in instantly to every other wifi on the same channel whose signal_out is wired (stepsTaken+1).
  def('wifi', 'wificomponent', 'WifiComponent', { Channel: '0', LinkToChat: 'false', MinChatMessageInterval: '1', DiscardDuplicateChatMessages: 'true' }, ['signal_in', 'set_channel'], OUT, (c) => {
    c.recv = (pin, s) => {
      if (pin === 'signal_in') c.wifiTx(s);
      else if (pin === 'set_channel') { const r = parseI(s.v); if (r.ok) { c.p.Channel = String(clamp(r.v, 0, 10000)); if (c.onChannel) c.onChannel(); } }
    };
  });

  // ---- lookups ----
  const byAliasMap = {}, byItemMap = {};
  for (const d of CAT) { byAliasMap[d.alias] = d; byItemMap[d.item] = d; }
  // extra aliases (item ids and class-ish names also work)
  for (const d of CAT) { byAliasMap[d.item] = byAliasMap[d.item] || d; byAliasMap[d.item.replace(/component$/, '')] = byAliasMap[d.item.replace(/component$/, '')] || d; }
  Object.assign(byAliasMap, { adder: byAliasMap.add, subtract: byAliasMap.sub, multiply: byAliasMap.mul, divide: byAliasMap.div, memory: byAliasMap.mem, oscillator: byAliasMap.osc, signalcheck: byAliasMap.check, modulo: byAliasMap.mod, exponent: byAliasMap.pow, exponentiation: byAliasMap.pow, exponentiationcomponent: byAliasMap.pow, multiplexer: byAliasMap.mux, demultiplexer: byAliasMap.demux, squareroot: byAliasMap.sqrt });
  function byAlias(a) { return byAliasMap[String(a).toLowerCase()]; }
  function byItem(i) { return byItemMap[i]; }
  function aliases() { return CAT.map(d => d.alias); }
  function propName(d, k) { const want = k.toLowerCase(); for (const p of Object.keys(d.defaults)) if (p.toLowerCase() === want) return p; return k; }
  function pinAlias(item, p) { // short pin names accepted in .circ
    const d = byItem(item); if (!d) return null;
    const all = [...d.ins, ...d.outs];
    if (all.includes(p)) return p;
    const cand = all.filter(x => x === 'signal_' + p || x === 'set_' + p || x === 'signal_in_' + p || x.endsWith('_' + p));
    return cand.length === 1 ? cand[0] : null;
  }

  return { CAT, byAlias, byItem, aliases, propName, pinAlias, parseF, parseI, fmtF, fmtD, roundEven, clamp, STEP };
});
