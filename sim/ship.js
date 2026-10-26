// Ship mock: a light electrical model of a whole submarine, built from a .sub file (sim/subfile.js).
// Everything that matters electrically is there with the sub's own settings and real wiring: reactor, batteries and
// supercapacitors, junction boxes, relays, engines, pumps, lights, oxygen generator, sonar/nav terminal, turrets and
// discharge coils, doors, detectors, buttons, standalone logic components and circuit boxes. No water, crew or physics:
// a scenario plays the practice round (pilot input, fights, a hull breach) and each device draws power by its rules
// (reference/DEVICES.md). Reactor, batteries, signals and circuit boxes reuse the bench simulator (sim/engine.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./components'));
  else root.BaroShip = factory(root.BaroEngine, root.BaroComponents);
})(typeof self !== 'undefined' ? self : this, function (E, C) {
  'use strict';
  const f = Math.fround, cl = (v, a, b) => Math.min(Math.max(v, a), b), STEP = E.STEP;
  const n = (v, d) => { const x = Number(v); return v !== undefined && v !== '' && Number.isFinite(x) ? x : d; };
  const bool = (v, d) => v === undefined ? d : String(v).toLowerCase() === 'true';
  const POWER = new Set(['power', 'power_in', 'power_out']);
  const first = (it, k) => (it.comps[k] || [])[0];
  const parse = v => { const r = C.parseF(v); return r.ok ? r.v : NaN; };
  const O2_GEN = 0.6, O2_CREW = 0.015; // %/s from one oxygen generator at full power (GeneratedAmount 400); %/s per crew member
  const center = it => [it.rect[0] + it.rect[2] / 2, it.rect[1] - it.rect[3] / 2];

  class ShipSim extends E.Sim {
    // ship: from subfile.parseSub; cfg: { duration, scenario, rods, fuelType, start, seed, breach }
    constructor(ship, cfg) {
      cfg = Object.assign({ duration: 600 }, cfg || {});
      const ri = ship.items.find(i => i.comps.Reactor), R0 = ri ? first(ri, 'Reactor') : {};
      const profile = { name: ship.name + ' practice round', points: [{ t: 0, demand: 0, ch: {} }], duration: cfg.duration, channels: [], meta: {} };
      super({ name: ship.name, boxes: [], links: [] }, Object.assign({}, cfg, {
        profile, reactorMaxKW: n(R0.MaxPowerOutput, 5000), batteries: { enabled: false }, start: 'cold',
        meltdownDelay: n(R0.MeltdownDelay, 120), fireDelay: n(R0.FireDelay, 20), fuelConsumptionRate: n(R0.FuelConsumptionRate, 0.2),
      }));
      this.ship = ship; this.devs = []; this.byId = new Map(); this.caps = []; this.jbs = []; this.relays = []; this.hullWater = {}; this.hullSmoke = {}; this.hullCrew = {};
      this.o2 = n(cfg.o2Start, 100); this.o2Min = this.o2; this.o2GenOnS = 0; this.chat = []; this.termLog = [];
      this.scenario = new Scenario(this, cfg.scenario || {});
      if (ri) this.byId.set(ri.id, { it: ri, sim: this.reactor, kind: 'reactor', cpc: 0 });
      for (const it of ship.items) if (it !== ri) this.addDevice(it);
      for (const w of ship.wires) this.addWire(w);
      for (const d of this.relays) if (ship.wires.some(w => (w.from.item === d.it.id && /^power/.test(w.from.conn)) || (w.to.item === d.it.id && /^power/.test(w.to.conn)))) d.state.on = true; // relays carrying power start ON (closed)
      for (const w of ship.wires) for (const [a, b] of [[w.from, w.to], [w.to, w.from]]) { // turrets/coils: batteries wired straight to their power_in
        const t = this.byId.get(a.item), src = this.byId.get(b.item);
        if (t && src && src.batt && a.conn === 'power_in' && b.conn === 'power_out' && (t.kind === 'turret' || t.kind === 'discharger')) (t.feeds = t.feeds || []).push(src.batt);
      }
      this.grids = []; this.gridsKey = '';
      // who runs the reactor: a circuit wired to its set_fissionrate/set_turbineoutput, else the crew's automatic control
      const ctl = ship.wires.some(w => ri && ((w.from.item === ri.id && /^set_(fissionrate|turbineoutput)$/.test(w.from.conn)) || (w.to.item === ri.id && /^set_(fissionrate|turbineoutput)$/.test(w.to.conn))));
      this.reactor.autoTemp = cfg.reactorControl ? cfg.reactorControl === 'auto' : !ctl;
      // start mid-round: devices on, reactor steady at the current load (like the bench's warm start)
      for (const d of this.devs) if (d.update) d.update(0);
      this.updatePower(); this.shipLoad = this.grid ? this.grid.load : 0;
      if ((cfg.start || 'warm') === 'warm') this.warmStart();
      this.metrics.reset();
    }
    demandAt() { return this.shipLoad || 0; }

    // ---------- build ----------
    addDevice(it) {
      const d = { it, kind: 'other', cpc: 0, voltage: 0, sim: this.mkItem('dev:' + it.id, { id: it.id }), state: {} };
      d.sim.dev = d; this.byId.set(it.id, d); this.devs.push(d);
      const k = it.comps;
      if (it.box) { // circuit box: the bench's box model, wired by the sub's real wires
        const bm = Object.assign({}, it.box, { name: 'box' + it.id }); const box = this.buildBox(bm); this.boxes.push(box); d.kind = 'circuitbox'; d.sim = box; box.dev = d; d.box = bm; return;
      }
      if (it.logic && !k.RelayComponent) { // a logic component placed in the sub (outside a circuit box); relays are power devices too
        const def = C.byItem(it.identifier), props = {}; const attrs = first(it, def.cls) || {};
        for (const key of Object.keys(def.defaults)) if (attrs[key] !== undefined) props[key] = attrs[key];
        const box = this.buildBox({ name: 'logic' + it.id, components: [{ id: '0', item: def.item, props }], wires: [], pins: {} });
        this.boxes.push(box); d.kind = 'logic'; d.sim = box.compById['0']; d.sim.dev = d; return;
      }
      if (k.PowerContainer) {
        const p = first(it, 'PowerContainer'), sc = /supercapacitor/.test(it.identifier);
        const b = Object.assign(d.sim, { capacity: n(p.Capacity, 10), maxRecharge: n(p.MaxRechargeSpeed, 10), maxOut: n(p.MaxOutPut, 10), eff: n(p.Efficiency, 0.95), exp: bool(p.ExponentialRechargeSpeed, false),
          charge: n(p.Charge, 0), prevCharge: n(p.Charge, 0), rate: 0, cpc: 0, out: 0, disabled: false, name: it.identifier + '#' + it.id });
        this.setRecharge(b, n(p.RechargeSpeed, 0));
        b.recv = (pin, sig) => {
          if (pin === 'disable_output') b.disabled = sig.v !== '0';
          else if (pin === 'set_rate') { const r = C.parseF(String(sig.v).replace(/,/g, '')); if (r.ok && Number.isFinite(r.v)) this.setRecharge(b, f(cl(f(r.v / 100), 0, 1) * b.maxRecharge)); }
        };
        d.kind = sc ? 'supercap' : 'battery'; d.batt = b; (sc ? this.caps : this.batteries).push(b); return;
      }
      if (k.PowerTransfer) { const p = first(it, 'PowerTransfer'); Object.assign(d.sim, { cond: 100, overloadV: n(p.OverloadVoltage, 1.7), prevP: 0, pSig: null, prevL: 0, lSig: null }); d.kind = 'junction'; this.jbs.push(d); return; }
      if (k.RelayComponent) {
        const p = first(it, 'RelayComponent'); d.kind = 'relay'; d.maxPower = n(p.MaxPower, 1000); this.relays.push(d);
        d.state.savedOn = bool(p.IsOn, true); d.state.on = d.state.savedOn; // power relays are switched on after wiring (below); signal-only relays keep their saved state
        d.sim.recv = (pin, sig) => {
          const s = d.state;
          if (pin === 'toggle') { if (sig.v !== '0') s.on = !s.on; }
          else if (pin === 'set_state') s.on = sig.v !== '0';
          else if (s.on && pin === 'signal_in1') this.send(d.sim, 'signal_out1', sig.v); else if (s.on && pin === 'signal_in2') this.send(d.sim, 'signal_out2', sig.v);
        };
        d.update = () => { // RelayComponent: state_out, and load_value_out = round(load of the grid on power_out) every tick
          this.send(d.sim, 'state_out', d.state.on ? '1' : '0');
          const g = this.connGrid && this.connGrid.get(d.it.id + '|power_out'); if (g) this.send(d.sim, 'load_value_out', String(Math.round(g.load || 0)));
        };
        return;
      }
      DEVICE(this, d);
    }
    addWire(w) {
      const a = this.byId.get(w.from.item), b = this.byId.get(w.to.item); if (!a || !b) return;
      if (POWER.has(w.from.conn) && POWER.has(w.to.conn)) return; // power wiring: used by the grid builder
      const ca = this.conn(a.sim, w.from.conn), cb = this.conn(b.sim, w.to.conn); this.wire(ca, cb);
    }

    // ---------- power grids (Powered.UpdatePower, per grid) ----------
    buildGrids() {
      const parent = new Map(), find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      const node = (id, c) => { const k = id + '|' + c; if (!parent.has(k)) parent.set(k, k); return k; }, join = (a, b) => parent.set(find(a), find(b));
      for (const w of this.ship.wires) if (POWER.has(w.from.conn) && POWER.has(w.to.conn)) join(node(w.from.item, w.from.conn), node(w.to.item, w.to.conn));
      for (const d of this.jbs) { const cs = d.it.conns.filter(c => POWER.has(c.name)).map(c => node(d.it.id, c.name)); for (let i = 1; i < cs.length; i++) join(cs[0], cs[i]); }
      const grids = new Map(), grid = k => { const r = find(k); if (!grids.has(r)) grids.set(r, { id: r, load: 0, power: 0, voltage: 0, consumers: [], batteries: [], sources: [], reactor: false, jbs: [] }); return grids.get(r); };
      const has = (it, c) => parent.has(it.id + '|' + c);
      if (this.reactorItem && has(this.reactorItem, 'power_out')) grid(this.reactorItem.id + '|power_out').reactor = true;
      for (const d of this.devs) {
        const id = d.it.id;
        if (d.batt) { if (has(d.it, 'power_in')) grid(id + '|power_in').batteries.push(d.batt); if (has(d.it, 'power_out')) grid(id + '|power_out').sources.push(d.batt); d.batt.inGrid = has(d.it, 'power_in') ? grid(id + '|power_in') : null; d.batt.outGrid = has(d.it, 'power_out') ? grid(id + '|power_out') : null; continue; }
        if (d.kind === 'junction') { const c = d.it.conns.find(c => POWER.has(c.name)); if (c && has(d.it, c.name)) { d.grid = grid(id + '|' + c.name); d.grid.jbs.push(d); } continue; }
        if (d.kind === 'relay') continue;
        const pc = ['power_in', 'power'].find(c => has(d.it, c));
        d.grid = pc ? grid(id + '|' + pc) : null; if (d.grid) d.grid.consumers.push(d);
      }
      // relays keep two grids apart and pass power from the input grid to the output grid while on (RelayComponent,
      // a PowerTransfer: the input grid sees the output grid's load, up to MaxPower)
      this.links = [];
      for (const d of this.relays) if (has(d.it, 'power_in') && has(d.it, 'power_out')) {
        const gi = grid(d.it.id + '|power_in'), go = grid(d.it.id + '|power_out');
        if (gi !== go) this.links.push({ d, gi, go });
      }
      this.connGrid = new Map(); for (const k of parent.keys()) this.connGrid.set(k, grid(k)); // for the viewer: which grid each power pin is on
      this.grids = [...grids.values()];
      this.reactorGrid = this.grids.find(g => g.reactor) || { load: 0, power: 0, voltage: 0, consumers: [], batteries: [], sources: [], jbs: [] };
    }
    // Plug bench circuit boxes (a .circ / Blueprints model) into the sub: each box pin is wired to the sub's real device,
    // e.g. reactor.load_value_out -> the reactor, junction.* -> the main junction box (the one on the reactor's grid),
    // battery.* -> every ship battery, nav.* -> the nav terminal, const.N -> a lever. Called before the first step.
    attachCircuit(model) {
      if (!model || !model.boxes.length) return;
      if (!this.grids.length) this.buildGrids();
      const jb = (this.reactorGrid.jbs || [])[0], built = {};
      const devOf = name => {
        if (name === 'reactor') return [this.reactor];
        if (name === 'junction') return jb ? [jb.sim] : [];
        if (name === 'battery') return this.batteries;
        const m = /^battery(\d+)$/.exec(name); if (m) return this.batteries[+m[1] - 1] ? [this.batteries[+m[1] - 1]] : [];
        if (name === 'nav') return this.nav ? [this.nav.sim] : [];
        if (name === 'const') { if (!this.constItem) this.constItem = this.mkItem('const', {}); return [this.constItem]; }
        return null;
      };
      for (const bm of model.boxes) {
        if (bm.name === 'battery' && !this.batteries.length) { this.warnings.push('battery box ignored: this sub has no batteries'); continue; }
        const box = this.buildBox(bm); this.boxes.push(box); built[bm.name] = box;
        const pins = bm.pins || E.DEFAULT_PINS[bm.name] || {};
        for (const [p, ep] of Object.entries(pins)) {
          if (!ep || ep === 'none' || ep.startsWith('link.')) continue;
          const di = ep.indexOf('.'), ds = devOf(ep.slice(0, di)), dpin = ep.slice(di + 1);
          if (!ds) { this.warnings.push(`${bm.name}.${p}: "${ep}" is not on this sub (only reactor, junction, battery, nav, const)`); continue; }
          for (const d of ds) this.wire(this.conn(box, 'signal_' + p), this.conn(d, dpin));
          if (ep.startsWith('reactor.set_')) this.reactor.autoTemp = false; // the circuit runs the reactor now
        }
      }
      for (const l of model.links || []) {
        const [ab, ap] = l.from.split('.'), [bb, bp] = l.to.split('.');
        if (built[ab] && built[bb]) this.wire(this.conn(built[ab], 'signal_' + ap), this.conn(built[bb], 'signal_' + bp));
      }
    }
    get reactorItem() { return this.ship.items.find(i => i.comps.Reactor); }
    updatePower() {
      if (!this.grids.length) this.buildGrids();
      const R = this.reactor, all = [...this.batteries, ...this.caps];
      for (const b of all) { b.cpc = b.inGrid ? this.batteryConsumption(b) : 0; b.out = 0; b.isSrc = b.charge > 0; }
      for (const g of this.grids) {
        g.ownLoad = 0; g.power = 0; g.fed = null;
        for (const d of g.consumers) g.ownLoad = f(g.ownLoad + d.cpc);
        for (const b of g.batteries) g.ownLoad = f(g.ownLoad + b.cpc);
      }
      // total load: own load + what closed relays pass on to their output grids (capped at MaxPower), deepest first
      const live = this.links.filter(l => l.d.state.on), tot = new Map();
      const total = (g, seen) => { if (tot.has(g)) return tot.get(g); if (seen.has(g)) return g.ownLoad; seen.add(g); let L = g.ownLoad; for (const l of live) if (l.gi === g) { l.pass = Math.min(total(l.go, seen), l.d.maxPower); L = f(L + l.pass); } tot.set(g, L); return L; };
      for (const g of this.grids) g.load = total(g, new Set());
      for (const l of live) if (!l.go.fed) l.go.fed = l;
      // solve feeding grids before the grids they feed
      const order = [], done = new Set(), visit = g => { if (done.has(g)) return; done.add(g); if (g.fed) visit(g.fed.gi); order.push(g); };
      for (const g of this.grids) visit(g);
      for (const g of order) {
        if (g.fed) g.power = f(g.fed.pass * Math.min(g.fed.gi.voltage || 0, 1)); // what the relay delivers
        if (g.reactor && R.cond > 0) { const mm = this.reactorMinMax(); g.power = f(g.power + this.reactorPowerOut(g.power, mm, g.load)); } else if (g.reactor) R.cpc = 0;
        const bs = g.sources.filter(b => b.isSrc);
        if (bs.length) {
          let max = 0; for (const b of bs) max = f(max + this.battMinMax(b));
          let added = 0;
          for (const b of bs) { if (b.disabled || !(max > 0)) { b.out = 0; continue; } b.out = f(cl(f(f(g.load - g.power) / max), 0, 1) * this.battMinMax(b)); added = f(added + b.out); }
          g.power = f(g.power + added);
        }
        let v = Math.min(f(g.power / Math.max(g.load, 1e-10)), 1000); if (!(v > 0)) v = 0;
        g.voltage = g.load <= 0 ? (g.power > 0 || g.reactor || bs.length || (g.fed && g.fed.gi.voltage > 0) ? 1 : 0) : f(v);
        for (const d of g.consumers) d.voltage = g.voltage;
      }
      for (const b of all) {
        const vin = b.inGrid ? b.inGrid.voltage : 0;
        b.charge = cl(f(b.charge + f(f(f(f(b.cpc * vin) / 60) * f(STEP)) * b.eff)), 0, b.capacity);
        b.charge = cl(f(b.charge - f(f(b.out / 60) * f(STEP))), 0, b.capacity); b.prevCharge = b.charge;
      }
      // the bench's metrics follow the reactor's grid; demand = its load minus battery charging
      const rg = this.reactorGrid;
      this.grid = rg; this.demand = f(rg.load - rg.batteries.reduce((a, b) => a + b.cpc, 0)); this.shipLoad = rg.load;
    }
    updateJunction(dt) { // every junction box reports its own grid
      for (const d of this.jbs) {
        const J = d.sim, g = d.grid || { power: 0, load: 0, voltage: 0 };
        if (J.prevP !== Math.trunc(g.power) || J.pSig === null) { J.prevP = Math.trunc(C.roundEven(g.power)); J.pSig = String(J.prevP); }
        if (J.prevL !== Math.trunc(g.load) || J.lSig === null) { J.prevL = Math.trunc(C.roundEven(g.load)); J.lSig = String(J.prevL); }
        this.send(J, 'power_value_out', J.pSig); this.send(J, 'load_value_out', J.lSig);
        d.overloaded = g.voltage > Math.max(J.overloadV, 1) && this.time >= 5;
        if (d.overloaded) this.metrics.overloadT += dt / Math.max(1, this.jbs.length);
      }
    }
    updateBattery(b) {
      const r = C.roundEven, g = b.outGrid || b.inGrid || { load: 0 };
      this.send(b, 'power_value_out', String(r(b.out))); this.send(b, 'load_value_out', String(r(g.load)));
      this.send(b, 'charge', String(r(b.charge))); this.send(b, 'charge_%', String(r(b.charge / b.capacity * 100))); this.send(b, 'charge_rate', String(r(b.rate / b.maxRecharge * 100)));
    }
    step() {
      this.scenario.update(this.time);
      // oxygen (one number for the whole sub; an approximation, no per-room air): the crew breathe it down,
      // oxygen generators running at >= MinVoltage push it up (scaled by voltage up to 1)
      let gen = 0;
      for (const d of this.devs) if (d.kind === 'oxygen' && d.state.active && d.voltage >= 0.5) { gen += Math.min(d.voltage, 1) * O2_GEN * (d.genAmount / 400); this.o2GenOnS += STEP; }
      this.o2 = cl(this.o2 + (gen - O2_CREW * (this.scenario.o.crew || 0)) * STEP, 0, 100); this.o2Min = Math.min(this.o2Min, this.o2);
      for (const d of this.devs) if (d.update) d.update(STEP);
      for (const b of this.caps) this.updateBattery(b);
      super.step();
    }
    get done() { return this.time >= this.profile.duration; }
    // text displays a player could never read to the end (a long text that keeps changing: sim/label.js)
    displayIssues() {
      const L = typeof module === 'object' && module.exports ? require('./label') : self.BaroLabel; if (!L) return [];
      return this.devs.filter(d => d.kind === 'display').map(d => Object.assign({ id: d.it.id }, L.check(d.state.hist, this.time))).filter(r => !r.ok);
    }
    // per-device / per-grid readout for the viewer
    deviceInfo(d) { return { id: d.it.id, kind: d.kind, kw: d.batt ? d.batt.cpc : d.cpc, voltage: d.voltage, state: d.state }; }
  }

  // ---------- device behaviours (power draw + signals); formulas: reference/DEVICES.md ----------
  function DEVICE(sim, d) {
    const it = d.it, k = it.comps, s = d.state, send = (pin, v) => sim.send(d.sim, pin, v);
    const lights = (k.LightComponent || []).map(l => ({ on: bool(l.IsOn, true), kw: n(l.PowerConsumption, 0) }));
    const lightKW = () => lights.reduce((a, l) => a + (l.on ? l.kw : 0), 0);
    const powered = () => d.voltage >= 0.5;
    const recvs = [];
    // light inputs (on any item with a LightComponent)
    recvs.push((pin, sig) => { if (pin === 'toggle') { if (sig.v !== '0') for (const l of lights) l.on = !l.on; } else if (pin === 'set_state' && !k.Door) for (const l of lights) l.on = sig.v !== '0'; });
    let base = () => lightKW();
    if (k.Engine) {
      const e = first(it, 'Engine'), max = n(e.PowerConsumption, 0); d.kind = 'engine'; s.force = 0; s.target = 0;
      recvs.push((pin, sig) => { if (pin === 'set_force') { const v = parse(sig.v); if (Number.isFinite(v)) s.target = cl(v, -100, 100); } });
      // Engine.cs: force lerps to the target (10/s, 0 below MinVoltage); power = (|target|/100)^1.5 * PowerConsumption
      d.update = (dt) => { s.force += ((d.voltage < n(e.MinVoltage, 0.5) ? 0 : s.target) - s.force) * Math.min(1, dt * 10); d.cpc = f(max * Math.pow(Math.abs(s.target) / 100, 1.5) + lightKW()); };
    } else if (k.Pump) {
      const p = first(it, 'Pump'), max = n(p.PowerConsumption, 0); d.kind = 'pump';
      s.active = bool(p.IsActive, false); s.flow = n(p.FlowPercentage, 0); s.level = 50; s.target = null; const FILL = 8; // ballast fill %/s at full flow (tuned to recorded rounds: no buoyancy here)
      recvs.push((pin, sig) => {
        if (pin === 'set_active') s.active = sig.v !== '0';
        else if (pin === 'toggle') { if (sig.v !== '0') s.active = !s.active; }
        else if (pin === 'set_speed') { const v = parse(sig.v); if (Number.isFinite(v)) { s.flow = Math.round(cl(v, -100, 100)); s.target = null; } }
        else if (pin === 'set_targetlevel') { const v = parse(sig.v); if (Number.isFinite(v)) s.target = cl((v + 100) / 2, 0, 100); }
      });
      d.update = (dt) => {
        if (s.target !== null) { s.flow = Math.round(cl((s.target - s.level) * 10, -100, 100)); if (s.active && powered()) s.level = cl(s.level + s.flow / 100 * FILL * dt, 0, 100); } // ballast tank fills toward the target level
        d.cpc = f((s.active ? max * Math.abs(s.flow) / 100 : 0) + lightKW());
      };
    } else if (k.Steering) {
      const st = first(it, 'Steering'), so = first(it, 'Sonar'), mm = first(it, 'MiniMap');
      d.kind = 'nav'; sim.nav = d; s.tx = 0; s.ty = 0; s.vx = 0; s.vy = 0; s.sonarActive = false; s.nb = 0.5;
      const kwSteer = n(st.PowerConsumption, 0), kwSonar = so ? n(so.PowerConsumption, 0) : 0;
      const STEER = Math.pow(1 / (1 - 0.2), 2) * 10;
      d.update = (dt) => {
        const dx = s.tx - s.vx, dy = s.ty - s.vy, len = Math.hypot(dx, dy);
        if (len > 0) { const stp = Math.min(STEER * dt, len); s.vx += dx / len * stp; s.vy += dy / len * stp; }
        if (powered()) {
          send('velocity_x_out', C.fmtF(s.vx));
          const a = (s.nb * 100 - 50) * 2, b = -100 * Math.sign(s.vy);
          send('velocity_y_out', C.fmtF(a + (b - a) * (Math.abs(s.vy) / 100)));
        }
        d.cpc = f(kwSteer + (s.sonarActive ? kwSonar : kwSonar * 0.1) + (mm ? n(mm.PowerConsumption, 0) : 0) + lightKW());
      };
    } else if (k.Turret || k.ElectricalDischarger) {
      // Turret.cs / ElectricalDischarger.cs: no grid draw (GetCurrentPowerConsumption = 0). A shot needs the directly wired
      // batteries/supercapacitors to give PowerConsumption at once (sum of min(charge*3600, maxOut/60)), then takes
      // PowerConsumption/3600 kW*min from them, split evenly. Reload limits the fire rate. Their recharge is the grid load.
      const t = first(it, k.Turret ? 'Turret' : 'ElectricalDischarger'), kw = n(t.PowerConsumption, 0), reload = n(t.Reload, 1);
      d.kind = k.ElectricalDischarger ? 'discharger' : /searchlight/.test(it.identifier) ? 'light' : 'turret'; s.reload = 0; s.shots = 0;
      const shoot = () => {
        if (s.reload > 0 || d.kind === 'light') return;
        const bs = (d.feeds || []).filter(b => !b.disabled && b.charge > 0.0001 && b.maxOut > 0.0001);
        const avail = bs.reduce((a, b) => a + Math.min(b.charge * 3600, b.maxOut / 60), 0);
        if (kw > 0 && avail < kw) return; // not enough stored energy for this shot
        let need = kw;
        while (need > 0.0001 && bs.some(b => b.charge > 0.0001)) { const live = bs.filter(b => b.charge > 0.0001), take = Math.min(need / live.length, ...live.map(b => Math.min(b.charge * 3600, b.maxOut))); for (const b of live) { need -= take; b.charge = Math.max(0, b.charge - take / 3600); b.prevCharge = b.charge; } }
        s.reload = reload; s.shots++;
      };
      recvs.push((pin, sig) => { if ((pin === 'trigger_in' || pin === 'activate') && sig.v !== '0') shoot(); });
      d.update = (dt) => { s.reload = Math.max(0, s.reload - dt); d.cpc = f(lightKW()); };
    } else if (k.OxygenGenerator || k.Fabricator || k.Deconstructor || k.MiniMap || k.Powered || k.Door || k.Vent) {
      const comp = first(it, 'OxygenGenerator') || first(it, 'Fabricator') || first(it, 'Deconstructor') || first(it, 'MiniMap') || first(it, 'Powered') || first(it, 'Door') || {};
      d.kind = k.OxygenGenerator ? 'oxygen' : k.Fabricator || k.Deconstructor ? 'fabricator' : k.Door ? 'door' : 'powered';
      const kw = n(comp.PowerConsumption, 0); s.active = d.kind === 'fabricator' ? false : bool(comp.IsActive, true); d.genAmount = n(comp.GeneratedAmount, 400);
      if (k.Door) recvs.push((pin, sig) => { if (pin === 'set_state') { s.open = sig.v !== '0'; send('state_out', s.open ? '1' : '0'); } else if (pin === 'toggle') { if (sig.v !== '0') s.open = !s.open; send('state_out', s.open ? '1' : '0'); } });
      recvs.push((pin, sig) => { if (pin === 'set_active') s.active = sig.v !== '0'; });
      d.update = () => { d.cpc = f((s.active ? kw : 0) + lightKW()); };
    } else if (k.WaterDetector || k.MotionSensor || k.SmokeDetector || k.OxygenDetector) {
      d.kind = 'detector'; const det = Object.keys(k).find(x => /Detector|Sensor/.test(x)), dc = first(it, det) || {};
      const onV = dc.Output !== undefined ? dc.Output : '1', offV = dc.FalseOutput !== undefined ? dc.FalseOutput : '0';
      const out = k.MotionSensor ? 'state_out' : 'signal_out', emit = on => { const v = on ? onV : offV; if (v !== '') send(out, v); };
      d.update = () => {
        if (det === 'WaterDetector') { const w = sim.hullWater[d.hull] || 0; emit(w > 0); send('water_%', String(Math.round(w))); }
        else if (det === 'MotionSensor') emit(s.motion || (sim.hullCrew[d.hull] || 0) > 0);
        else if (det === 'SmokeDetector') emit(s.smoke || !!sim.hullSmoke[d.hull]);
        else if (det === 'OxygenDetector') send('signal_out', String(Math.round(sim.o2)));
        d.cpc = lightKW();
      };
    } else if (k.Controller) {
      const c = k.Controller[0] || {};
      if (bool(c.IsToggle, false) && !/periscope/.test(it.identifier)) { // a lever: sends its state every frame (Controller.Update), a press flips it
        d.kind = 'lever'; s.on = bool(c.State, false);
        d.press = () => { s.on = !s.on; };
        d.update = () => { const v = s.on ? (c.Output !== undefined ? c.Output : '1') : (c.FalseOutput !== undefined ? c.FalseOutput : ''); if (v !== '') send('signal_out', v); d.cpc = lightKW(); };
      } else {
        d.kind = /periscope/.test(it.identifier) ? 'periscope' : 'button'; s.pressed = 0;
        d.press = () => { send(d.kind === 'button' ? 'signal_out' : 'trigger_out', '1'); };
        d.update = () => { d.cpc = lightKW(); };
      }
    } else if (k.Terminal) {
      d.kind = 'terminal'; s.lines = []; d.type = text => { sim.termLog.push({ t: sim.time, id: it.id, dir: '>', text }); send('signal_out', text); }; d.update = () => { d.cpc = 0; };
      recvs.push((pin, sig) => { if (pin === 'signal_in' && sig.v !== '') { s.lines.push(sig.v); if (s.lines.length > 60) s.lines.shift(); sim.termLog.push({ t: sim.time, id: it.id, dir: '<', text: sig.v }); } else if (pin === 'clear_text' && sig.v !== '0') s.lines = []; });
    } else if (k.ItemLabel) {
      d.kind = 'display'; s.text = (first(it, 'ItemLabel') || {}).Text || ''; s.hist = [{ t: 0, text: s.text }]; recvs.push((pin, sig) => { if (pin === 'set_text' && sig.v !== s.text) { s.text = sig.v; if (s.hist.length < 20000) s.hist.push({ t: sim.time, text: sig.v }); } }); d.update = () => { d.cpc = lightKW(); };
    } else if (k.LightComponent) {
      d.kind = 'light'; d.update = () => { d.cpc = lightKW(); };
    } else { d.update = () => { d.cpc = base(); }; }
    d.sim.recv = (pin, sig) => { for (const r of recvs) r(pin, sig); };
    // which hull it is in (for water/motion)
    const [cx, cy] = center(it); const h = sim.ship.hulls.find(h => cx >= h.rect[0] && cx <= h.rect[0] + h.rect[2] && cy <= h.rect[1] && cy >= h.rect[1] - h.rect[3]);
    d.hull = h ? h.id : null;
  }

  // ---------- the practice round ----------
  // A pilot steering (x: stop / part / full throttle, y: depth changes), fights (gunners firing every turret and the
  // discharge coil, sonar active), and optional hull breaches (water detectors in that room read 100 %).
  class Scenario {
    constructor(sim, o) {
      this.sim = sim; this.o = Object.assign({ fights: true, fightEvery: 240, firstFight: 90, breachAt: null, breachHull: null, pilot: true, crew: 4, fireAt: null, fireHull: null, fireLen: 60, type: [], radio: [] }, o);
      this.crew = []; this.nextMove = 0; this.typed = 0; this.said = 0;
      let a = (o.seed || 7) >>> 0; this.r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
      this.nextX = 0; this.nextY = 0; this.fightEnd = -1; this.nextFight = this.o.firstFight; this.nextShot = 0; this.events = [];
    }
    update(t) {
      const sim = this.sim, r = this.r, nav = sim.nav, fighting = t < this.fightEnd;
      if (this.o.fights && !fighting && t >= this.nextFight) { this.fightEnd = t + 40 + r() * 120; this.nextFight = this.fightEnd + this.o.fightEvery * (0.5 + r()); sim.metrics.ev('fight starts'); }
      if (nav && this.o.pilot) {
        const s = nav.state;
        if (t >= this.nextX) { const q = r(); s.tx = (r() < 0.85 ? 1 : -1) * (q < (fighting ? 0.25 : 0.45) ? 0 : q < 0.75 ? 15 + r() * 65 : 100); this.nextX = t + (fighting ? 3 + r() * 12 : 20 + r() * 100); }
        if (t >= this.nextY) { const q = r(); s.ty = q < 0.35 ? 0 : (r() < 0.5 ? -1 : 1) * (q < 0.6 ? 5 + r() * 35 : q < 0.7 ? 40 + r() * 40 : 80 + r() * 20); this.nextY = t + 5 + r() * 35; }
        s.sonarActive = fighting;
      }
      if (fighting) { // gunners: bursts of fire (trigger held while the burst lasts); the discharge coil now and then
        if (t >= this.nextShot) { this.burstEnd = t + 1 + r() * 4; this.nextShot = this.burstEnd + 1 + r() * 6; this.coil = r() < 0.2; }
        if (t < this.burstEnd) for (const d of sim.devs) if (d.kind === 'turret' || (d.kind === 'discharger' && this.coil)) d.sim.recv('trigger_in', { v: '1', steps: 0, src: null });
      }
      // crew walking between rooms (motion detectors see them in the room they're in)
      if (this.o.crew && t >= this.nextMove && sim.ship.hulls.length) {
        const hs = sim.ship.hulls; while (this.crew.length < this.o.crew) this.crew.push(hs[Math.floor(r() * hs.length)].id);
        const i = Math.floor(r() * this.crew.length); this.crew[i] = hs[Math.floor(r() * hs.length)].id; this.nextMove = t + 2 + r() * 8;
        sim.hullCrew = {}; for (const h of this.crew) sim.hullCrew[h] = (sim.hullCrew[h] || 0) + 1;
      }
      if (this.o.fireAt !== null && !this.fire && t >= this.o.fireAt) { const hs = sim.ship.hulls; this.fire = hs.find(x => x.id === this.o.fireHull) || hs[Math.floor(r() * hs.length)]; sim.hullSmoke[this.fire.id] = true; sim.metrics.ev(`fire in ${this.fire.name || 'hull ' + this.fire.id}`); }
      if (this.fire && sim.hullSmoke[this.fire.id] && t >= this.o.fireAt + this.o.fireLen) { sim.hullSmoke[this.fire.id] = false; sim.metrics.ev('fire out'); }
      // someone typing at a terminal: [{ t, text, terminal? }]
      while (this.typed < this.o.type.length && t >= this.o.type[this.typed].t) {
        const c = this.o.type[this.typed++], term = sim.devs.find(d => d.kind === 'terminal' && (!c.terminal || d.it.id === String(c.terminal)));
        if (term) term.type(c.text);
      }
      // someone talking on the headset radio: [{ t, text, ch }] -> every wifi with LinkToChat on that channel outputs it
      while (this.said < this.o.radio.length && t >= this.o.radio[this.said].t) {
        const c = this.o.radio[this.said++], ch = String(c.ch || 0); sim.chat.push({ t, ch, text: c.text, crew: true });
        for (const w of sim.wifis) if (w.p.Channel === ch && String(w.p.LinkToChat).toLowerCase() === 'true' && w.isWired('signal_out')) sim.itemSend(w.item, { v: c.text, steps: 0, src: null }, sim.conn(w.item, 'signal_out'));
      }
      if (this.o.breachAt !== null && t >= this.o.breachAt && !this.breached) {
        this.breached = true; const hs = sim.ship.hulls; const h = hs.find(x => x.id === this.o.breachHull) || hs[Math.floor(r() * hs.length)];
        sim.hullWater[h.id] = 100; sim.metrics.ev(`hull breach in ${h.name || 'hull ' + h.id}`);
      }
    }
  }
  return { ShipSim, Scenario };
});
