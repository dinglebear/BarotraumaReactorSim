// Barotrauma reactor / power / circuit-box mock. Fixed 60 Hz step (Timing.Step), deterministic.
// Frame order mirrors MapEntity.UpdateAll: Powered.UpdatePower() first, then every item's Update() in item-list order
// (reactor -> fuel rods -> junction box -> batteries -> circuit boxes' components -> external wifi).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./components'));
  else root.BaroEngine = factory(root.BaroComponents);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const STEP = 1 / 60;
  const f = Math.fround;
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const cl = (v, a, b) => { v = v > b ? b : v; return v < a ? a : v; }; // MathHelper.Clamp (min wins), keeps NaN
  const lerp = (a, b, t) => f(a + f(f(b - a) * t));
  const nearlyEq = (a, b, eps = 1e-4) => { if (a === b) return true; const d = Math.abs(a - b), s = Math.abs(a) + Math.abs(b); if (a === 0 || b === 0 || s < eps) return d < eps; return d / s < eps; };
  const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
  const trunc = v => (Number.isFinite(v) ? Math.trunc(v) : 0);
  const adjustNoOvershoot = (cur, tgt, spd) => tgt < cur ? Math.max(tgt, f(cur - spd)) : Math.min(tgt, f(cur + spd));
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // vanilla item presets (reference/BAROTRAUMA_MECHANICS.md §7): fuel = AvailableFuel per rod (condition > 0), cond = max condition
  const FUEL = { uranium: { fuel: 80, cond: 100 }, thorium: { fuel: 100, cond: 200 }, fulgurium: { fuel: 150, cond: 150 }, volatile: { fuel: 150, cond: 400 } };
  const BATT = { battery: { capacity: 2000, maxRecharge: 500, maxOut: 1000 }, supercapacitor: { capacity: 20, maxRecharge: 1000, maxOut: 20000000, efficiency: 0.1, exponential: true } };

  // Default wiring between box pins and devices (used when a box has no `pin` lines).
  const DEFAULT_PINS = {
    reactor: { in1: 'reactor.load_value_out', in2: 'reactor.power_value_out', in3: 'reactor.temperature_out', in4: 'reactor.fuel_out', in5: 'reactor.fuel_percentage_left', in6: 'junction.load_value_out', in7: 'junction.power_value_out', out1: 'reactor.set_fissionrate', out2: 'reactor.set_turbineoutput' },
    battery: { in1: 'battery.charge_%', in2: 'battery.charge_rate', in3: 'junction.load_value_out', in4: 'junction.power_value_out', in5: 'reactor.load_value_out', in6: 'reactor.power_value_out', out1: 'battery.set_rate' },
  };
  const DEVICE_OUTS = {
    reactor: ['temperature_out', 'power_value_out', 'load_value_out', 'fuel_out', 'fuel_percentage_left', 'meltdown_warning'],
    junction: ['power_value_out', 'load_value_out'],
    battery: ['power_value_out', 'load_value_out', 'charge', 'charge_%', 'charge_rate'],
  };
  const DEVICE_INS = { reactor: ['set_fissionrate', 'set_turbineoutput', 'shutdown'], battery: ['set_rate', 'disable_output'], junction: [] };

  // Community circuits label their pins in their own words: map them to devices by keyword.
  const GUESS = [
    [/fuel.*(%|perc|left)|rod.*(%|cond)/i, 'reactor.fuel_percentage_left', 'in'], [/fuel/i, 'reactor.fuel_out', 'in'], [/temp/i, 'reactor.temperature_out', 'in'],
    [/charge.*rate|rate/i, 'battery.charge_rate', 'in'], [/charge|batt/i, 'battery.charge_%', 'in'],
    [/junction.*load|jb.*load/i, 'junction.load_value_out', 'in'], [/load/i, 'reactor.load_value_out', 'in'], [/power|output|out/i, 'reactor.power_value_out', 'in'],
    [/fission/i, 'reactor.set_fissionrate', 'out'], [/turbine/i, 'reactor.set_turbineoutput', 'out'], [/shut|scram/i, 'reactor.shutdown', 'out'],
    [/rate|charge|batt/i, 'battery.set_rate', 'out'], [/disable/i, 'battery.disable_output', 'out'],
  ];
  function guessPins(bm) {
    const out = {};
    for (const [labels, dir] of [[bm.inLabels || {}, 'in'], [bm.outLabels || {}, 'out']])
      for (const [pin, label] of Object.entries(labels)) { const g = GUESS.find(([re, , d]) => d === dir && re.test(label)); if (g) out[pin.replace(/^signal_/, '')] = g[1]; }
    return Object.keys(out).length ? out : null;
  }

  const RECORDED = ['nav', 'engines', 'pumps', 'guns', 'sonar'];
  const FUEL_IDS = { fuelrod: 'uranium', thoriumfuelrod: 'thorium', fulguriumfuelrod: 'fulgurium', fulguriumfuelrodvolatile: 'volatile' };
  function fmtChannel(pin, v) {
    if (/load_value_out|power_value_out/.test(pin)) return String(C.roundEven(v));   // (int)Math.Round
    if (/^current_/.test(pin)) return v.toFixed(4);                                  // nav terminal "0.0000"
    return C.fmtF(v);                                                                // float.ToString()
  }

  class Sim {
    constructor(model, cfg) {
      cfg = cfg || {};
      this.cfg = cfg;
      this.frame = 0; this.time = 0;
      this.rand = rng(cfg.seed || 12345);
      this.profile = cfg.profile || { points: [{ t: 0, demand: 2000 }], duration: 600 };
      this.pIdx = 0;
      this.items = []; this.pending = []; this.wifis = []; this.recorded = {};
      this.warnings = [];
      // ---- reactor ----
      const fuelType = cfg.fuelType || (this.profile.meta || {}).fuel_type || 'uranium'; this.fuelType = fuelType; // test file's rod type unless overridden
      const rodType = FUEL[fuelType] || FUEL.uranium;
      const p0 = (this.profile.points || [])[0] || {};
      const rodCount = cfg.rods != null ? cfg.rods : p0.rods !== undefined ? p0.rods : (Number((this.profile.meta || {}).fuel_rods) || 1); // starting rods: setting, else the test file
      this.reactor = this.mkItem('reactor', {
        maxPower: cfg.reactorMaxKW || this.profile.reactorMaxKW || 5000, fuelRate: cfg.fuelConsumptionRate || 0.2,
        meltdownDelay: 120, fireDelay: 20, dos: clamp(cfg.skill || 0, 0, 1),
        fission: 0, turbine: 0, temp: 0, tf: 0, tt: 0, autoTemp: false, powerOn: true, load: 0, cpc: 0, cto: 0,
        availFuel: 0, prevAvailFuel: 0, sigF: null, sigT: null, lastF: -1e9, lastT: -1e9, melt: 0, fire: 0, boost: 0,
        cond: 100, wearDelay: 120 + this.rand() * 600, minOut: 0, maxOut: 0, optT: [0, 0], allT: [0, 0], optTemp: [40, 60], allTemp: [30, 70], optF: [0, 0], allF: [0, 0],
        rods: Array.from({ length: rodCount }, () => ({ fuel: (cfg.rodFuel || rodType.fuel), cond: rodType.cond, max: rodType.cond })),
      });
      this.reactor.availFuel = this.rodFuel();
      // ---- junction box ----
      this.junction = this.mkItem('junction', { cond: 100, wearDelay: 120 + this.rand() * 600, overloadV: 2, prevP: 0, pSig: null, prevL: 0, lSig: null, cooldown: 0, breaks: 0 });
      // ---- batteries ----
      this.batteries = [];
      const bc = cfg.batteries || {};
      if (bc.enabled) {
        const bt = Object.assign({}, BATT[bc.type || 'battery'] || BATT.battery, bc.custom || {});
        for (let i = 0; i < (bc.count || 1); i++) {
          const b = this.mkItem('battery' + (i + 1), {
            capacity: bt.capacity, maxRecharge: bt.maxRecharge, maxOut: bt.maxOut, eff: bt.efficiency == null ? 0.95 : bt.efficiency, exp: !!bt.exponential,
            charge: bt.capacity * clamp(bc.startCharge == null ? 0.5 : bc.startCharge, 0, 1), prevCharge: 0, rate: 0, cpc: 0, out: 0, disabled: false,
          });
          b.prevCharge = b.charge; this.setRecharge(b, (bc.startRate == null ? 0 : bc.startRate) / 100 * b.maxRecharge);
          this.batteries.push(b);
        }
      }
      // ---- circuit boxes ----
      this.boxes = [];
      for (const bm of (model && model.boxes) || []) {
        if (bm.name === 'battery' && !this.batteries.length) { this.warnings.push('battery box ignored: batteries are disabled'); continue; }
        this.boxes.push(this.buildBox(bm));
      }
      this.wireHarness(model || { links: [] });
      this.wear = cfg.wear !== false; // vanilla: reactor and junction box wear down unless repaired (cfg.repairBelow = crew repair threshold %)
      this.metrics = new Metrics(this);
      if ((cfg.start || 'warm') === 'warm') this.warmStart();
      if (cfg.vanilla) this.reactor.autoTemp = true; // baseline: the game's own automatic control, no circuit
      this.metrics.reset();
    }

    // ---------- item / connection plumbing ----------
    mkItem(name, props) { const it = Object.assign({ name, lsr: [], conns: {} }, props); this.items.push(it); return it; }
    conn(item, pin) { return item.conns[pin] || (item.conns[pin] = { item, pin, wires: [], cb: [] }); }
    wire(a, b) { a.wires.push(b); b.wires.push(a); }
    // Item.SendSignal
    itemSend(item, sig, conn) {
      item.lsr.length = 0;
      sig = { v: sig.v, steps: sig.steps + 1, src: sig.src };
      if (sig.steps > 5 && sig.src) { let d = 0; for (const r of sig.src.lsr) if (r === conn && ++d > 2) return; }
      if (sig.steps > 10) {
        sig.steps = 0;
        if (!this.pending.some(p => p.conn === conn && p.sig.src === sig.src && p.sig.v === sig.v)) this.pending.push({ sig, conn, frame: this.frame });
        return;
      }
      if (!sig.src) sig.src = item;
      this.connSend(conn, sig);
    }
    // Connection.SendSignal
    connSend(conn, sig) {
      for (const r of conn.wires) {
        if (r.item === conn.item || (sig.src && sig.src.lsr[sig.src.lsr.length - 1] === r)) continue;
        if (sig.src) sig.src.lsr.push(r);
        this.deliver(r, sig);
      }
      for (const t of conn.cb) t(sig);
    }
    deliver(conn, sig) { const h = conn.item.recv; if (h) h(conn.pin, sig); }

    // ---------- circuit box ----------
    buildBox(bm) {
      const box = this.mkItem('box:' + bm.name, { model: bm, comps: [], compById: {}, inputs: {}, outputs: {} });
      const sim = this;
      box.recv = (pin, sig) => { const t = box.inputs[pin]; if (t) for (const f of t) f(sig); };
      for (const cm of bm.components) {
        const d = C.byItem(cm.item);
        if (!d) { this.warnings.push(`box ${bm.name}: unsupported component "${cm.item}" (ignored)`); continue; }
        const ci = this.mkItem(`${bm.name}/${cm.id}`, { def: d, id: cm.id });
        const comp = { p: Object.assign({}, d.defaults, cm.props), item: ci };
        comp.send = (pin, v) => sim.itemSend(ci, { v: String(v), steps: 0, src: null }, sim.conn(ci, pin));
        comp.fwd = (sig, pin, v) => sim.itemSend(ci, { v: String(v), steps: sig.steps, src: sig.src }, sim.conn(ci, pin));
        comp.isWired = (pin) => { const c = ci.conns[pin]; return !!c && (c.wires.length > 0 || c.cb.length > 0); };
        comp.wifiTx = (sig) => sim.wifiTx(ci, comp, sig);
        d.make(comp);
        ci.recv = (pin, sig) => comp.recv && comp.recv(pin, sig);
        ci.comp = comp;
        if (d.alias === 'wifi') this.wifis.push(comp);
        box.comps.push(ci); box.compById[cm.id] = ci;
      }
      for (const w of bm.wires) {
        const f = w.from, t = w.to;
        if (f.c === null) { // input node -> component pin or output node
          const target = t.c === null ? (sig => sim.itemSend(box, sig, sim.conn(box, t.pin))) : this.cbInto(box, t);
          if (!target) continue;
          (box.inputs[f.pin] = box.inputs[f.pin] || []).push(target);
        } else {
          const src = box.compById[f.c]; if (!src) continue;
          const target = t.c === null ? (sig => sim.itemSend(box, sig, sim.conn(box, t.pin))) : this.cbInto(box, t);
          if (target) this.conn(src, f.pin).cb.push(target);
        }
      }
      return box;
    }
    cbInto(box, ep) { const ci = box.compById[ep.c]; if (!ci) return null; return sig => ci.recv(ep.pin, sig); }
    wifiTx(srcItem, srcComp, sig) {
      for (const w of this.wifis) {
        if (w === srcComp || w.p.Channel !== srcComp.p.Channel || !w.isWired('signal_out')) continue;
        const inConn = w.item.conns.signal_in;
        if (sig.src && inConn) { if (sig.src.lsr.includes(inConn)) continue; sig.src.lsr.push(inConn); }
        this.itemSend(w.item, { v: sig.v, steps: sig.steps + 1, src: sig.src }, this.conn(w.item, 'signal_out'));
      }
    }
    devices(name) {
      if (name === 'reactor') return [this.reactor];
      if (name === 'junction') return [this.junction];
      if (name === 'battery') return this.batteries;
      const m = /^battery(\d+)$/.exec(name); if (m) return this.batteries[+m[1] - 1] ? [this.batteries[+m[1] - 1]] : [];
      // recorded devices: test-file columns named "<device>.<pin>" (nav terminal, engines, pumps, guns, sonar, ...)
      const chans = (this.profile.channels || []).filter(c => c.startsWith(name + '.'));
      if (chans.length || RECORDED.includes(name)) {
        if (!this.recorded[name]) this.recorded[name] = this.mkItem(name, { recordedDevice: true });
        return [this.recorded[name]];
      }
      return null;
    }
    wireHarness(model) {
      for (const box of this.boxes) {
        let pins = box.model.pins;
        if (!pins) { const g = guessPins(box.model); if (g) { pins = g; this.warnings.push(`${box.model.name} box: pin wiring guessed from labels: ${Object.entries(g).map(([k, v]) => k + '=' + v).join(' ')} (add 'pin' lines or a .pins file to fix)`); } }
        pins = pins || DEFAULT_PINS[box.model.name] || {};
        for (const [p, ep] of Object.entries(pins)) {
          if (!ep || ep === 'none' || ep.startsWith('link.')) continue; // links are wired below
          const [dev, dpin] = ep.split('.');
          const ds = this.devices(dev);
          if (!ds) { this.warnings.push(`unknown device "${dev}" in pin ${box.model.name}.${p}`); continue; }
          const full = /^in\d$/.test(p) ? 'signal_' + p : /^out\d$/.test(p) ? 'signal_' + p : p;
          for (const d of ds) this.wire(this.conn(box, full), this.conn(d, dpin));
          if (ds[0] && ds[0].recordedDevice && !(this.profile.channels || []).includes(ep)) this.warnings.push(`test file has no "${ep}" column: ${box.model.name}.${p} gets no signal (record it with the PowerLogger mod)`);
        }
      }
      let wifiCh = 9000;
      for (const l of model.links || []) {
        const [ab, ap] = l.from.split('.'), [bb, bp] = l.to.split('.');
        const A = this.boxes.find(b => b.model.name === ab), B = this.boxes.find(b => b.model.name === bb);
        if (!A || !B) { this.warnings.push(`link ${l.from} -> ${l.to}: box missing`); continue; }
        const ca = this.conn(A, 'signal_' + ap), cb = this.conn(B, 'signal_' + bp);
        if (l.wifi || this.cfg.linkMode === 'wifi') { // two external wifi components, one per box
          const ch = String(l.wifi || wifiCh++);
          const mk = (nm) => { const it = this.mkItem(nm, {}); const comp = { p: { Channel: ch }, item: it }; comp.isWired = pin => !!it.conns[pin] && it.conns[pin].wires.length > 0; comp.wifiTx = s => this.wifiTx(it, comp, s); C.byAlias('wifi').make(comp); it.recv = (pin, s) => comp.recv(pin, s); this.wifis.push(comp); return it; };
          const wa = mk(`wifi:${l.from}`), wb = mk(`wifi:${l.to}`);
          this.wire(ca, this.conn(wa, 'signal_in')); this.wire(this.conn(wb, 'signal_out'), cb);
        } else this.wire(ca, cb);
      }
      // device signal inputs
      const R = this.reactor, sim = this;
      R.recv = (pin, sig) => {
        if (pin === 'shutdown') { if (R.tf > 0 || R.tt > 0) { R.powerOn = false; R.autoTemp = false; R.tf = 0; R.tt = 0; sim.metrics.ev('reactor shutdown signal'); } }
        else if (pin === 'set_fissionrate') { if (!R.powerOn) return; const r = C.parseF(sig.v); if (r.ok) { R.sigF = cl(r.v, 0, 100); R.lastF = sim.time; } }
        else if (pin === 'set_turbineoutput') { if (!R.powerOn) return; const r = C.parseF(sig.v); if (r.ok) { R.sigT = cl(r.v, 0, 100); R.lastT = sim.time; } }
      };
      for (const b of this.batteries) b.recv = (pin, sig) => {
        if (pin === 'disable_output') b.disabled = sig.v !== '0';
        else if (pin === 'set_rate') { const r = C.parseF(String(sig.v).replace(/,/g, '')); /* NumberStyles.Any */ if (r.ok && Number.isFinite(r.v)) this.setRecharge(b, f(cl(f(r.v / 100), 0, 1) * b.maxRecharge)); }
      };
    }
    setRecharge(b, v) { v = cl(f(v), 0, b.maxRecharge); const div = Math.max(f(b.maxRecharge * 0.1), 1); b.rate = f(C.roundEven(f(v / div)) * div); } // RoundTowardsClosest: 10% steps, banker's rounding
    rodFuel() { let f = 0; for (const r of this.reactor.rods) if (r.cond > 0) f += r.fuel; return f; }

    // ---------- demand profile ----------
    demandAt(t) {
      const pts = this.profile.points;
      while (this.pIdx + 1 < pts.length && pts[this.pIdx + 1].t <= t) this.pIdx++;
      return pts[this.pIdx].demand;
    }

    // ---------- power grid (Powered.UpdatePower) ----------  (float32 like the game: f() after every operation)
    updatePower() {
      const R = this.reactor, g = { power: 0, load: 0 };
      const demand = this.demand = f(this.demandAt(this.time));
      // loads: battery power_in draws its recharge rate; power_out registers a source when it holds charge
      for (const b of this.batteries) { b.cpc = this.batteryConsumption(b); g.load = f(g.load + b.cpc); b.out = 0; b.isSrc = b.charge > 0; }
      g.load = f(g.load + demand);
      // source groups by priority: Reactor (1) then Battery (5)
      if (R.cond > 0) { const mm = this.reactorMinMax(); g.power = f(g.power + this.reactorPowerOut(g.power, mm, g.load)); } else R.cpc = 0;
      const bs = this.batteries.filter(b => b.isSrc);
      if (bs.length) {
        let max = 0; for (const b of bs) max = f(max + this.battMinMax(b));
        let added = 0;
        for (const b of bs) { if (b.disabled || !(max > 0)) { b.out = 0; continue; } b.out = f(cl(f(f(g.load - g.power) / max), 0, 1) * this.battMinMax(b)); added = f(added + b.out); }
        g.power = f(g.power + added);
      }
      let v = Math.min(f(g.power / Math.max(g.load, 1e-10)), 1000); if (v < 0) v = 0;
      g.voltage = f(v);
      // GridResolved: charge gets CurrPowerConsumption * Voltage (overvoltage charges faster), output drains it
      for (const b of this.batteries) {
        b.charge = cl(f(b.charge + f(f(f(f(b.cpc * g.voltage) / 60) * f(STEP)) * b.eff)), 0, b.capacity);
        b.charge = cl(f(b.charge - f(f(b.out / 60) * f(STEP))), 0, b.capacity); b.prevCharge = b.charge;
      }
      this.grid = g;
    }
    batteryConsumption(b) {
      if (b.charge >= b.capacity) { b.charge = b.capacity; return 0; }
      const missing = f(b.capacity - b.charge);
      let t = b.rate; if (b.exp) t = f(f(Math.pow(f(b.rate / b.maxRecharge), 2)) * b.maxRecharge);
      if (missing < 1) t = f(t * missing);
      return cl(t, 0, b.maxRecharge);
    }
    battMinMax(b) {
      if (b.disabled) return 0;
      const ratio = f(b.prevCharge / b.capacity);
      const m = ratio < 0.1 ? f(Math.max(f(ratio * 10), 0) * b.maxOut) : b.maxOut;
      return Math.min(m, f(f(b.prevCharge * 60) / f(STEP)));
    }
    reactorMinMax() {
      const R = this.reactor;
      let tol = 1;
      if (R.turbine > R.optT[0] && R.turbine < R.optT[1] && R.temp > R.optTemp[0] && R.temp < R.optTemp[1]) tol = 3;
      const tf = Math.min(f(R.temp / 50), 1), mx = R.maxPower;
      R.minOut = f(mx * cl(Math.min(f(f(R.turbine - tol) / 100), tf), 0, 1));
      R.maxOut = f(mx * Math.min(f(f(R.turbine + tol) / 100), tf));
      return { min: R.minOut, max: R.maxOut, rmax: R.powerOn ? mx : R.maxOut };
    }
    reactorPowerOut(power, mm, load) {
      const R = this.reactor;
      const loadLeft = Math.max(f(load - power), 0);
      const expected = cl(loadLeft, mm.min, mm.max);
      let ratio = Math.max(f(f(loadLeft - mm.min) / f(mm.max - mm.min)), 0);
      if (!Number.isFinite(ratio)) ratio = 0; // game only catches Infinity; 0/0 NaN guarded here (cold reactor, zero load)
      const out = cl(f(f(ratio * f(R.maxOut - R.minOut)) + R.minOut), R.minOut, R.maxOut);
      let newLoad = loadLeft; const mx = R.maxPower;
      if (mx !== mm.rmax && mm.rmax > 0) {
        const ideal = f(f(mx / mm.rmax) * loadLeft);
        const adj = cl(f(f(f(f(ratio - 0.5) * 25) + ideal) - f(f(R.turbine / 100) * mx)), f(-mx / 100), f(mx / 100));
        newLoad = cl(f(f(loadLeft - f(expected - out)) + adj), 0, loadLeft);
      }
      R.load = newLoad < 0 ? 0 : newLoad;
      R.cpc = f(-out);
      return out;
    }

    // ---------- reactor (Reactor.Update) ----------
    updateReactor(dt) {
      const R = this.reactor, T = this.time;
      dt = f(dt);
      if (R.cond <= 0) { // UpdateBroken
        this.send(R, 'temperature_out', String(trunc(f(R.temp * 100))));
        R.cpc = 0; R.temp = cl(f(R.temp - f(dt * 1000)), 0, 100);
        R.tf = Math.max(f(R.tf - f(dt * 10)), 0); R.tt = Math.max(f(R.tt - f(dt * 10)), 0);
        return;
      }
      const fCtl = R.sigF !== null && R.lastF > T - 1, tCtl = R.sigT !== null && R.lastT > T - 1;
      this.metrics.ctl(fCtl, tCtl);
      // round-start fast sync: first 5 s of a round, AutoTemp on, no player user, no signal control
      if (T + (this.cfg.roundTimeOffset || 0) < 5 && R.powerOn && R.autoTemp && !fCtl && !tCtl) this.autoTemp(100, f(STEP * 10));
      const mx = R.maxPower;
      if (fCtl) R.tf = adjustNoOvershoot(R.tf, R.sigF, f(dt * 5)); else R.sigF = null;
      if (tCtl) R.tt = adjustNoOvershoot(R.tt, R.sigT, f(dt * 5)); else R.sigT = null;
      R.prevAvailFuel = R.availFuel;
      if (!nearlyEq(mx, 0)) R.cto = f(R.cto + f(cl(f(f(f(R.load / mx) * 100) - R.cto), -20, 20) * dt));
      const d = R.dos;
      let tol = lerp(2.5, 10, d); R.optT = [f(R.cto - tol), f(R.cto + tol)];
      tol = lerp(5, 20, d); R.allT = [f(R.cto - tol), f(R.cto + tol)];
      R.optTemp = [lerp(40, 30, d), lerp(60, 70, d)]; R.allTemp = [lerp(30, 10, d), lerp(70, 90, d)];
      R.optF = [lerp(30, 20, d), lerp(f(R.availFuel - 20), f(R.availFuel - 10), d)]; R.optF[0] = Math.min(R.optF[0], f(R.optF[1] - 10));
      R.allF = [lerp(20, 10, d), R.availFuel]; R.allF[0] = Math.min(R.allF[0], f(R.allF[1] - 10));
      const heat = f(f(f(R.fission * f(R.prevAvailFuel / 100)) * 2) + R.boost);
      const td = f(f(heat - R.turbine) - R.temp);
      R.temp = cl(f(R.temp + cl(f(sign(td) * 10 * dt), -Math.abs(td), Math.abs(td))), 0, 100);
      R.boost = adjustNoOvershoot(R.boost, 0, dt);
      R.fission = cl(lerp(R.fission, Math.min(R.tf, R.availFuel), dt), 0, 100);
      R.turbine = cl(lerp(R.turbine, R.tt, dt), 0, 100);
      if (!R.powerOn) { R.tf = 0; R.tt = 0; }
      else if (R.autoTemp) this.autoTemp(2, dt);
      let fuelLeft = 0;
      for (const rod of R.rods) {
        if (R.fission > 0) { const before = rod.cond; rod.cond = Math.max(0, f(rod.cond - f(f(f(R.fission / 100) * R.fuelRate) * dt))); this.metrics.fuel += before - rod.cond; }
        fuelLeft = f(fuelLeft + f(f(rod.cond / rod.max) * 100));
      }
      this.send(R, 'temperature_out', String(trunc(f(R.temp * 100))));
      this.send(R, 'power_value_out', String(trunc(-R.cpc)));
      this.send(R, 'load_value_out', String(trunc(R.load)));
      this.send(R, 'fuel_out', String(trunc(R.availFuel)));
      this.send(R, 'fuel_percentage_left', String(trunc(fuelLeft)));
      // UpdateFailures
      if (R.temp > R.allTemp[1]) {
        this.send(R, 'meltdown_warning', '1');
        R.melt = f(R.melt + lerp(f(dt * 2), dt, R.cond / 100));
        if (R.melt > R.meltdownDelay) { this.meltdown(); return; }
      } else { this.send(R, 'meltdown_warning', '0'); R.melt = Math.max(0, f(R.melt - dt)); }
      if (R.temp > R.optTemp[1]) {
        R.fire = f(R.fire + lerp(f(dt * 2), dt, R.cond / 100));
        if (R.fire >= R.fireDelay) { this.metrics.fires++; this.metrics.ev('FIRE started at reactor (temp > ' + R.optTemp[1].toFixed(0) + ' for ' + R.fireDelay + 's)'); R.fire = 0; }
      } else R.fire = Math.max(0, f(R.fire - dt));
      // fuel rods update after the reactor: OnContaining adds their fuel to AvailableFuel for next tick
      R.availFuel = this.rodFuel();
      // Repairable (updates after Reactor): wear while running; lower condition makes the fire/meltdown timers up to 2x faster
      if (this.wear && R.temp > 0.1) this.deteriorate(R, 0.125, dt);
      this.metrics.reactorCondMin = Math.min(this.metrics.reactorCondMin, R.cond);
    }
    deteriorate(it, speed, dt) {
      if (it.wearDelay > 0) { it.wearDelay -= dt; return; }
      if (it.cond > 10) it.cond = Math.max(10, f(it.cond - f(speed * dt)));
      if (this.cfg.repairBelow > 0 && it.cond < this.cfg.repairBelow) { it.cond = 100; it.wearDelay = 120 + this.rand() * 600; this.metrics.ev(`${it.name} repaired by crew (was below ${this.cfg.repairBelow}%)`); }
    }
    autoTemp(speed, dt) {
      const R = this.reactor;
      const dT = f(f(R.optT[0] + R.optT[1]) / 2);
      R.tt = cl(f(R.tt + f(cl(f(dT - R.tt), -speed, speed) * dt)), 0, 100);
      const dF = f(f(R.optF[0] + R.optF[1]) / 2);
      R.tf = f(R.tf + f(cl(f(dF - R.tf), -speed, speed) * dt));
      if (R.temp > f(f(R.optTemp[0] + R.optTemp[1]) / 2)) R.tf = Math.min(f(R.tf - f(f(speed * 2) * dt)), R.allF[1]);
      else if (-R.cpc < R.load) R.tf = Math.min(f(R.tf + f(f(speed * 2) * dt)), 100);
      R.tf = cl(R.tf, 0, 100);
      R.tf = cl(R.tf, f(R.fission - 5), f(R.fission + 5));
    }
    meltdown() {
      const R = this.reactor;
      R.cond = 0; R.fire = 0; R.melt = 0; for (const r of R.rods) r.cond = 0;
      this.metrics.meltdownAt = this.time; this.metrics.ev('MELTDOWN (temperature above ' + R.allTemp[1].toFixed(0) + ' for too long)');
    }
    // Game start state: like Reactor.PowerUpImmediately() (vanilla autotemp pre-heats), then automatic control is switched OFF.
    // Warm start = the sub was saved mid-round running steadily at the starting load (what a campaign round starts from):
    // temperature 50, turbine at the ideal output, fission giving exactly enough heat. If AutoTemp is on, the game's
    // round-start fast sync then runs for 5 s. (The old PowerUpImmediately() warm-up is only used by outposts/NPC subs.)
    warmStart() {
      const R = this.reactor, load = this.demandAt(0);
      R.load = load; R.cto = f(cl(load / R.maxPower * 100, 0, 100)); R.tt = R.turbine = R.cto;
      R.temp = 50; R.prevAvailFuel = R.availFuel;
      R.tf = R.fission = R.availFuel > 0 ? f(cl((50 + R.turbine) / (R.availFuel / 100 * 2), 0, Math.min(100, R.availFuel))) : 0;
      R.temp = R.availFuel > 0 ? cl(f(R.fission * (R.availFuel / 100) * 2 - R.turbine), 0, 100) : 0;
    }
    send(item, pin, v) { const c = item.conns[pin]; if (c) this.itemSend(item, { v, steps: 0, src: null }, c); }

    // rods added/removed during the recorded round (test-file "rods" column): new rods are fresh, removed ones are the most used
    updateRods() {
      const pt = this.profile.points[this.pIdx]; if (!pt || pt.rods === undefined || this.cfg.lockRods) return;
      const R = this.reactor, want = Math.max(0, Math.min(4, Math.round(pt.rods)));
      if (want === R.rods.length) return;
      const from = R.rods.length, t = FUEL[this.fuelType] || FUEL.uranium;
      while (R.rods.length < want) R.rods.push({ fuel: t.fuel, cond: t.cond, max: t.cond });
      while (R.rods.length > want) { let k = 0; R.rods.forEach((r, i) => { if (r.cond < R.rods[k].cond) k = i; }); R.rods.splice(k, 1); }
      this.metrics.ev(`rods ${from} -> ${want} (as in the recorded round)`);
    }

    // recorded devices replay their test-file value every tick, formatted like the game does
    updateRecorded() {
      const pt = this.profile.points[this.pIdx]; if (!pt || !pt.ch) return;
      for (const [name, it] of Object.entries(this.recorded)) for (const pin of Object.keys(it.conns)) {
        const v = pt.ch[name + '.' + pin]; if (v === undefined) continue;
        this.send(it, pin, fmtChannel(pin, v));
      }
    }

    // ---------- junction box / batteries (Update) ----------
    updateJunction(dt) {
      const J = this.junction, g = this.grid;
      const p = g.power, l = g.load;
      if (J.prevP !== trunc(p) || J.pSig === null) { J.prevP = trunc(C.roundEven(p)); J.pSig = String(J.prevP); }
      if (J.prevL !== trunc(l) || J.lSig === null) { J.prevL = trunc(C.roundEven(l)); J.lSig = String(J.prevL); }
      this.send(J, 'power_value_out', J.pSig); this.send(J, 'load_value_out', J.lSig);
      if (this.wear && g.voltage > 0.1) this.deteriorate(J, 0.1, dt);
      // UpdateOvervoltage (OverloadVoltage 2.0): 1%/frame chance of random damage while overloaded
      if (g.voltage > Math.max(J.overloadV, 1) && this.time >= 5) {
        this.metrics.overloadT += dt;
        if (J.cooldown > 0) { J.cooldown -= dt; return; }
        if (this.rand() < 0.01) { J.cond -= dt * (10 + this.rand() * 490) * lerp(5, 1, J.cond / 100); }
        if (J.cond <= 0) { J.breaks++; this.metrics.junctionBreaks++; this.metrics.ev('JUNCTION BOX BROKE from overvoltage (auto-repaired to continue test)'); J.cond = 100; J.cooldown = 5; }
      }
    }
    updateBattery(b) {
      const r = C.roundEven;
      this.send(b, 'power_value_out', String(r(b.out)));
      this.send(b, 'load_value_out', String(r(this.grid.load)));
      this.send(b, 'charge', String(r(b.charge)));
      this.send(b, 'charge_%', String(r(b.charge / b.capacity * 100)));
      this.send(b, 'charge_rate', String(r(b.rate / b.maxRecharge * 100)));
    }

    // ---------- one frame ----------
    step() {
      const dt = STEP;
      if (this.cfg.beforeTick) this.cfg.beforeTick(this); // used by sim/verify.js to drive the reactor from a recorded game trace
      this.updatePower();
      // delayed (stepsTaken > 10) signals from the previous frame
      if (this.pending.length) { const p = this.pending; this.pending = []; for (const e of p) this.connSend(e.conn, e.sig); }
      this.updateRecorded();
      this.updateRods();
      this.updateReactor(dt);
      this.updateJunction(dt);
      for (const b of this.batteries) this.updateBattery(b);
      for (const box of this.boxes) for (const ci of box.comps) if (ci.comp.update) ci.comp.update(dt);
      this.metrics.sample(dt);
      this.frame++; this.time = this.frame * STEP;
    }
    get done() { return this.time >= this.profile.duration; }
    runToEnd(onProgress) { while (!this.done) { this.step(); if (onProgress && this.frame % 3600 === 0) onProgress(this); } return this.metrics.report(); }
    snapshot() {
      const R = this.reactor, g = this.grid || { power: 0, load: 0, voltage: 0 };
      return { t: this.time, demand: this.demand || 0, power: g.power, load: g.load, voltage: g.voltage, temp: R.temp, fission: R.fission, turbine: R.turbine, tf: R.tf, tt: R.tt, out: -R.cpc, cto: R.cto,
        fuel: R.rods.reduce((a, r) => a + r.cond / r.max * 100, 0), batt: this.batteries.length ? this.batteries.reduce((a, b) => a + b.charge / b.capacity, 0) / this.batteries.length * 100 : null,
        battOut: this.batteries.reduce((a, b) => a + b.out, 0), battIn: this.batteries.reduce((a, b) => a + b.cpc, 0), fCtl: R.sigF !== null, tCtl: R.sigT !== null };
    }
  }

  // ---------- metrics / log ----------
  class Metrics {
    constructor(sim) { this.sim = sim; this.reset(); }
    reset() {
      Object.assign(this, { t: 0, fuel: 0, eDemand: 0, eUnmet: 0, eSurplus: 0, eReactor: 0, eBattOut: 0, eBattIn: 0, eRSurplus: 0, eRShort: 0, eAbsorbed: 0, eCovered: 0, eChargeInShort: 0, vAbsDev: 0, vSq: 0, vMin: Infinity, vMax: 0, tLow90: 0, tLow50: 0, tHigh110: 0, tBand: 0, fluct: 0, inBand: true,
        overloadT: 0, junctionBreaks: 0, reactorCondMin: 100, fires: 0, meltdownAt: null, tempMax: 0, tAboveOpt: 0, tCritical: 0, noCtlF: 0, noCtlT: 0, events: [], timeline: [], nextTl: 0, outAbs: 0, battMin: Infinity, battMax: -Infinity, lowRun: 0, worstLow: 0 });
      if (this.sim.reactor) this.fuelStart = this.sim.reactor.rods.reduce((a, r) => a + r.cond, 0);
      Object.assign(this, { socSum: 0, tFull: 0, tEmpty: 0, tLow20: 0, tHigh90: 0, eLostFull: 0, eLostEmpty: 0, fullRun: 0, emptyRun: 0 });
      this.chargeStart = (this.sim.batteries || []).reduce((a, b) => a + b.charge, 0);
    }
    ev(msg) { if (this.events.length < 60) this.events.push(fmtT(this.sim.time) + ' ' + msg); }
    ctl(f, t) { if (this.sim.reactor.powerOn && this.sim.time > 1) { if (!f) this.noCtlF += 1 / 60; if (!t) this.noCtlT += 1 / 60; } }
    sample(dt) {
      const s = this.sim, g = s.grid, R = s.reactor, v = g.voltage, dem = s.demand;
      this.t += dt;
      this.eDemand += dem * dt; this.eReactor += -R.cpc * dt;
      const sh = Math.max(0, g.load - g.power), su = Math.max(0, g.power - g.load);
      this.eUnmet += Math.min(sh, dem) * dt; this.eSurplus += su * dt;
      // battery buffering: surplus = reactor output above demand (would be overvoltage), shortfall = demand above reactor output
      const rOut = -R.cpc, rs = Math.max(0, rOut - dem), rd = Math.max(0, dem - rOut);
      this.eRSurplus += rs * dt; this.eRShort += rd * dt;
      let bIn = 0, bOut = 0; for (const b of s.batteries) { bIn += b.cpc * v; bOut += b.out; }
      this.eAbsorbed += Math.min(rs, bIn) * dt; this.eCovered += Math.min(rd, bOut) * dt;
      if (rd > 0 && bIn > 0) this.eChargeInShort += Math.min(bIn, bOut) * dt;
      if (s.batteries.length) { // state-of-charge management: full = no room to soak up surplus, empty = nothing to cover shortfalls
        let soc = 0, full = true, empty = true;
        for (const b of s.batteries) { const r = b.charge / b.capacity; soc += r; if (r < 0.99) full = false; if (r > 0.01) empty = false; }
        this.socSum += soc / s.batteries.length * 100 * dt;
        const socPct = soc / s.batteries.length * 100; if (socPct < 20) this.tLow20 += dt; if (socPct > 90) this.tHigh90 += dt;
        if (full) { this.tFull += dt; this.eLostFull += rs * dt; if (this.fullRun === 0) this.ev('batteries FULL (cannot absorb surplus)'); this.fullRun += dt; } else this.fullRun = 0;
        if (empty) { this.tEmpty += dt; this.eLostEmpty += rd * dt; if (this.emptyRun === 0) this.ev('batteries EMPTY (cannot cover shortfall)'); this.emptyRun += dt; } else this.emptyRun = 0;
      }
      for (const b of s.batteries) { this.eBattOut += b.out * dt; this.eBattIn += b.cpc * dt; const pc = b.charge / b.capacity * 100; this.battMin = Math.min(this.battMin, pc); this.battMax = Math.max(this.battMax, pc); }
      const vv = g.load > 0 ? v : 1;
      this.vAbsDev += Math.abs(vv - 1) * dt; this.vSq += (vv - 1) * (vv - 1) * dt; this.vMin = Math.min(this.vMin, vv); this.vMax = Math.max(this.vMax, vv);
      if (vv < 0.9) this.tLow90 += dt; if (vv < 0.5) this.tLow50 += dt; if (vv > 1.1) this.tHigh110 += dt;
      const inB = vv >= 0.95 && vv <= 1.05; if (inB) this.tBand += dt;
      if (this.inBand && !inB && s.time > 0) this.fluct++;
      this.inBand = inB;
      if (vv < 0.9) { this.lowRun += dt; } else { if (this.lowRun > 1) this.ev(`brownout ${this.lowRun.toFixed(1)}s (voltage < 0.9)`); this.worstLow = Math.max(this.worstLow, this.lowRun); this.lowRun = 0; }
      this.tempMax = Math.max(this.tempMax, R.temp);
      if (R.temp > R.optTemp[1]) this.tAboveOpt += dt;
      if (R.temp > R.allTemp[1]) this.tCritical += dt;
      if (s.time >= this.nextTl) { this.nextTl += 1; const n = s.snapshot(); this.timeline.push(n); }
    }
    report() {
      const s = this.sim, T = Math.max(this.t, 1e-9), kwh = x => x / 3600;
      const fuelUsed = this.fuel, delivered = kwh(this.eDemand - this.eUnmet);
      const r = {
        circuit: s.cfg.circuitName || '', profile: s.profile.name || '', duration_s: +T.toFixed(1), reactor_max_kw: s.reactor.maxPower,
        rods: `${s.reactor.rods.length}x ${s.fuelType}`, batteries: s.batteries.length ? `${s.batteries.length}x ${(s.cfg.batteries || {}).type || 'battery'}` : 'off',
        demand_kwh: +kwh(this.eDemand).toFixed(1), unmet_kwh: +kwh(this.eUnmet).toFixed(2), unmet_pct: +(this.eUnmet / Math.max(this.eDemand, 1e-9) * 100).toFixed(2),
        surplus_kwh: +kwh(this.eSurplus).toFixed(2), reactor_kwh: +kwh(this.eReactor).toFixed(1),
        fuel_condition_used: +fuelUsed.toFixed(2), fuel_rods_used: +(fuelUsed / (s.reactor.rods[0] ? s.reactor.rods[0].max : 100)).toFixed(3),
        fuel_per_mwh: delivered > 0 ? +(fuelUsed / (delivered / 1000)).toFixed(2) : null,
        voltage_mean_abs_dev: +(this.vAbsDev / T).toFixed(4), voltage_rms_dev: +Math.sqrt(this.vSq / T).toFixed(4), voltage_min: +this.vMin.toFixed(3), voltage_max: +this.vMax.toFixed(3),
        pct_time_in_band_0_95_1_05: +(this.tBand / T * 100).toFixed(2), fluctuation_events: this.fluct,
        brownout_s_v_lt_0_9: +this.tLow90.toFixed(1), blackout_s_v_lt_0_5: +this.tLow50.toFixed(1), worst_brownout_s: +Math.max(this.worstLow, this.lowRun).toFixed(1), overvolt_s_v_gt_1_1: +this.tHigh110.toFixed(1),
        junction_overload_s_v_gt_2: +this.overloadT.toFixed(1), junction_breaks: this.junctionBreaks,
        temp_max: +this.tempMax.toFixed(1), temp_above_optimal_s: +this.tAboveOpt.toFixed(1), temp_critical_s: +this.tCritical.toFixed(1), fires: this.fires, meltdown_at_s: this.meltdownAt === null ? null : +this.meltdownAt.toFixed(1),
        reactor_condition_min_pct: +this.reactorCondMin.toFixed(1), // worn reactor: fire/meltdown timers run up to 2x faster
        no_fission_signal_s: +this.noCtlF.toFixed(1), no_turbine_signal_s: +this.noCtlT.toFixed(1),
        battery_charge_min_pct: s.batteries.length ? +this.battMin.toFixed(1) : null, battery_charge_max_pct: s.batteries.length ? +this.battMax.toFixed(1) : null,
        battery_out_kwh: +kwh(this.eBattOut).toFixed(2), battery_in_kwh: +kwh(this.eBattIn).toFixed(2),
        reactor_surplus_kwh: +kwh(this.eRSurplus).toFixed(2), reactor_shortfall_kwh: +kwh(this.eRShort).toFixed(2),
        surplus_into_batteries_pct: s.batteries.length && this.eRSurplus > 0 ? +(this.eAbsorbed / this.eRSurplus * 100).toFixed(1) : null,
        shortfall_covered_by_batteries_pct: s.batteries.length && this.eRShort > 0 ? +(this.eCovered / this.eRShort * 100).toFixed(1) : null,
        battery_self_drain_kwh: s.batteries.length ? +kwh(this.eChargeInShort).toFixed(2) : null, // charging while also discharging (wasted cycle)
        battery_soc_avg_pct: s.batteries.length ? +(this.socSum / T).toFixed(1) : null,
        battery_soc_end_pct: s.batteries.length ? +(s.batteries.reduce((a, b) => a + b.charge / b.capacity, 0) / s.batteries.length * 100).toFixed(1) : null,
        battery_full_s: s.batteries.length ? +this.tFull.toFixed(1) : null, battery_empty_s: s.batteries.length ? +this.tEmpty.toFixed(1) : null,
        battery_below20_s: s.batteries.length ? +this.tLow20.toFixed(1) : null, battery_above90_s: s.batteries.length ? +this.tHigh90.toFixed(1) : null,
        surplus_lost_while_full_kwh: s.batteries.length ? +kwh(this.eLostFull).toFixed(2) : null, shortfall_while_empty_kwh: s.batteries.length ? +kwh(this.eLostEmpty).toFixed(2) : null,
        battery_net_kwh: s.batteries.length ? +((s.batteries.reduce((a, b) => a + b.charge, 0) - this.chargeStart) / 60).toFixed(2) : null, // + = ended with more stored energy
      };
      // scores 0-100 (higher is better)
      r.score_reliability = +Math.max(0, 100 - r.unmet_pct * 10 - r.voltage_mean_abs_dev * 200 - r.fluctuation_events / (T / 60) * 2 - (r.meltdown_at_s !== null ? 100 : 0) - r.fires * 10 - r.junction_breaks * 10).toFixed(1);
      r.kwh_per_rod = r.fuel_rods_used > 0 ? +(delivered / r.fuel_rods_used).toFixed(0) : null; // fuel efficiency: higher is better
      // fair fuel efficiency: energy borrowed from (or banked into) the batteries is counted, so draining them is not free
      if (s.batteries.length) r.kwh_per_rod_adjusted = r.fuel_rods_used > 0 ? +((delivered + r.battery_net_kwh) / r.fuel_rods_used).toFixed(0) : null;
      if (s.batteries.length) {
        const sip = r.surplus_into_batteries_pct ?? 100, scp = r.shortfall_covered_by_batteries_pct ?? 100;
        const selfPct = this.eBattIn > 0 ? this.eChargeInShort / this.eBattIn * 100 : 0;
        const startPct = this.chargeStart / s.batteries.reduce((a, b) => a + b.capacity, 0) * 100;
        r.score_battery = +Math.max(0, 0.5 * sip + 0.5 * scp - 50 * this.tFull / T - 100 * this.tEmpty / T - 40 * this.tLow20 / T - 20 * this.tHigh90 / T
          - Math.max(0, startPct - r.battery_soc_end_pct) / 2 - Math.min(20, selfPct)).toFixed(1);
        r.battery_soc_start_pct = +startPct.toFixed(1);
      }
      r.events = this.events; r.warnings = s.warnings;
      return r;
    }
  }
  function fmtT(t) { const m = Math.floor(t / 60), s = t - m * 60; return `[${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}]`; }

  // ---------- load profiles (CSV written by the PowerLogger mod) ----------
  function parseProfile(text, name) {
    const prof = { name: name || 'profile', points: [], meta: {} };
    let cols = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      if (line.startsWith('#')) { const m = /^#\s*([\w.]+)\s*[=:]\s*(.*)$/.exec(line); if (m) prof.meta[m[1]] = m[2].trim(); continue; }
      const parts = line.split(',');
      if (!cols) { if (/[a-z]/i.test(parts[0])) { cols = parts.map(s => s.trim().toLowerCase()); continue; } cols = ['t', 'demand']; }
      const row = {}; cols.forEach((c, i) => row[c] = parts[i] === undefined || parts[i].trim() === '' ? NaN : Number(parts[i]));
      const demand = Number.isFinite(row.demand) ? row.demand : row.load;
      if (!Number.isFinite(row.t) || !Number.isFinite(demand)) continue;
      const ch = {}; for (const c of cols) if (c.includes('.') && Number.isFinite(row[c])) ch[c] = row[c];
      prof.points.push({ t: row.t, demand: Math.max(0, demand), turbine: row.turbine, out: row.reactor_out, rods: Number.isFinite(row.rods) ? row.rods : undefined, ch });
    }
    prof.channels = cols ? cols.filter(c => c.includes('.')) : [];
    if (!prof.points.length) prof.points.push({ t: 0, demand: 0, ch: {} });
    const t0 = prof.points[0].t; for (const p of prof.points) p.t -= t0;
    prof.duration = Number(prof.meta.duration) || (prof.points[prof.points.length - 1].t + 1);
    // reactor max output: saved directly, else auto-calculated from Output(kW) = (Turbine/100) * MaxOutput
    let mx = Number(prof.meta.reactor_max_kw);
    if (!(mx > 0)) { const est = prof.points.filter(p => p.turbine > 5 && p.out > 0).map(p => p.out / (p.turbine / 100)); if (est.length) { est.sort((a, b) => a - b); mx = est[est.length >> 1]; } }
    if (mx > 0) prof.reactorMaxKW = Math.round(mx);
    return prof;
  }

  return { Sim, parseProfile, FUEL_IDS, DEFAULT_PINS, DEVICE_OUTS, DEVICE_INS, FUEL, BATT, STEP };
});
