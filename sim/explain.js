// Reads a .sub or an item assembly (.xml) and prints its electrical design as a readable netlist: every wired or logic
// item with its settings (defaults left out) and where each connection goes, and every circuit box's insides.
// Works on any item (mods too): it does not need the simulator's catalog. For studying how other people's circuits work.
// node sim/cli.js explain <file.sub|file.xml> [filter regex] [--all]
'use strict';
const X = require('./subxml'), C = require('./components');

// attributes that never matter for a circuit
const NOISE = /^(PickingTime|CanBePicked|LockGuiFramePosition|GuiFrameOffset|AllowInGameEditing|Msg|channelmemory|SpriteDepthWhenDropped|Attached|IsActive|MinVoltage|PowerConsumption|Voltage|MaxRechargeSpeed|ExponentialRechargeSpeed|RechargeWarningIndicatorLow|RechargeWarningIndicatorHigh|IgnoreForAutonomousOperations|HideInGameIfNotPowered|DrawHudWhenEquipped|UsableIn|AllowSwapping|BotsShouldKeepOpen|UseBetweenOutpostModules|CanBeSelected|Spread|MaxOutputLength|AllowCrossTeamCommunication|MinChatMessageInterval|TextScale|Padding|FlashOnSignal|BlinkFrequency|Flicker|FlickerSpeed|Pulsate|PulseFrequency|PulseAmount|CastShadows|DrawBehindSubs|IgnoreContinuousToggle|Range)$/;
const SKIP = /^(Holdable|Wearable|Pickable|Repairable|Body|requireditem|itemstats|ConnectionPanel|ItemContainer|CircuitBox|Wire|Rope|Upgrade|StatusEffect|LevelResource|Projectile|MeleeWeapon|RangedWeapon)$/;
const CLASS_DEFAULTS = { // non-catalog classes: values that are the item's normal setting
  WifiComponent: { LinkToChat: 'False', DiscardDuplicateChatMessages: 'False' },
  LightComponent: { IsOn: 'True', LightColor: null }, Door: { IsOpen: 'False' },
  MotionSensor: { OnlyHumans: 'False', IgnoreDead: 'False', TargetType: 'Any' },
  Terminal: { UseMonospaceFont: 'False', Readonly: 'False', TextColor: null, LineStartSymbol: '' },
};

function load(text) {
  const root = X.parse(text), top = root.children.find(n => n.tag === 'Submarine' || n.tag === 'ItemAssembly');
  if (!top) throw new Error('not a submarine or item assembly');
  return { kind: top.tag, name: X.get(top, 'name') || '', description: X.get(top, 'description') || '', top };
}

function propsOf(n, ident) {
  const out = [];
  for (const c of n.children) {
    if (SKIP.test(c.tag)) continue;
    const def = C.byItem(ident), dflt = def && def.cls === c.tag ? def.defaults : CLASS_DEFAULTS[c.tag] || {};
    const kv = [];
    for (const [k] of c.attrs) {
      if (NOISE.test(k)) continue;
      const v = X.get(c, k);
      if (def && def.cls === c.tag && !(k in dflt)) continue; // catalog parts: only their editable settings
      if (k in dflt && (dflt[k] === null || String(dflt[k]) === v)) continue;
      if (!def && !(c.tag in CLASS_DEFAULTS) && !/^(Value|Output|FalseOutput|Text|Channel|LinkToChat|Expression|TargetSignal|Label|Separator|TimeFrame|Delay|Frequency|WaveType|Signal|MaxValue|MinValue|IsOn|DisplayText|Labels|Signals|ElementStates|NumberInputMin|NumberInputMax|ConnectionLabel|Description|WelcomeMessage|Readonly|DetectOffset|Target|OnlyHumans|MaxRange|RangeX|RangeY|IncludeFriendly|TargetType|IsOpen|ContinuousOutput|UseCaptureGroup|OutputEmptyCaptureGroup|ContainerVisible|SelectedConnection|DetectOwnSub|ExtraStack|UseMonospaceFont)$/i.test(k)) continue;
      kv.push(`${k}=${JSON.stringify(v)}`);
    }
    if (kv.length) out.push((def && def.cls === c.tag ? '' : c.tag + ': ') + kv.join(' '));
  }
  return out.join(' | ');
}

function explain(text, opts) {
  opts = opts || {};
  const f = load(text), items = new Map(), wireEnds = new Map(), L = [];
  for (const n of f.top.children) if (n.tag === 'Item') items.set(X.get(n, 'ID'), n);
  const conns = n => { const cp = n.children.find(c => c.tag === 'ConnectionPanel'); return cp ? cp.children.filter(c => c.tag === 'input' || c.tag === 'output') : []; };
  for (const [id, n] of items) for (const io of conns(n)) for (const l of io.children.filter(c => c.tag === 'link')) {
    const w = X.get(l, 'w'); if (!wireEnds.has(w)) wireEnds.set(w, []); wireEnds.get(w).push({ id, conn: X.get(io, 'name'), dir: io.tag });
  }
  const inBox = new Set();
  for (const n of items.values()) if (n.children.some(c => c.tag === 'CircuitBox')) for (const ic of X.kids(n, 'ItemContainer')) for (const s of (X.get(ic, 'contained') || '').split(/[,;]/)) if (s) inBox.add(s);
  const ident = id => (items.get(id) ? X.get(items.get(id), 'identifier') : '?');
  const tag = id => `${ident(id)}#${id}`;
  const label = n => { const l = n.children.find(c => c.tag === 'ItemLabel'); return l ? X.get(l, 'Text') : X.get(n, 'Tags') && /label/.test(ident) ? '' : ''; };
  const pos = n => { const r = (X.get(n, 'rect') || '0,0,0,0').split(',').map(Number); return `@${Math.round(r[0] + r[2] / 2)},${Math.round(r[1] - r[3] / 2)}`; };
  const re = opts.filter ? new RegExp(opts.filter, 'i') : null;
  L.push(`# ${f.kind} "${f.name}"${f.description ? ' - ' + f.description.replace(/\s+/g, ' ').slice(0, 400) : ''}`);
  const counts = {}; for (const [id, n] of items) if (!inBox.has(id) && !/wire$/.test(X.get(n, 'identifier'))) counts[X.get(n, 'identifier')] = (counts[X.get(n, 'identifier')] || 0) + 1;
  L.push('# parts: ' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => v > 1 ? `${k}x${v}` : k).join(', '));
  // free-standing labels (designers' notes)
  for (const [id, n] of items) { const t = label(n); if (t && !inBox.has(id)) L.push(`# note ${pos(n)}: ${t.replace(/\s+/g, ' ')}`); }
  for (const [id, n] of items) {
    const idf = X.get(n, 'identifier'); if (/wire$/.test(idf) || inBox.has(id)) continue;
    const cs = conns(n), wired = cs.filter(io => io.children.some(c => c.tag === 'link'));
    const isLogic = !!C.byItem(idf) || n.children.some(c => /Component$/.test(c.tag) && !/^(LightComponent|RelayComponent)$/.test(c.tag));
    if (!opts.all && !wired.length && !isLogic && !n.children.some(c => c.tag === 'CircuitBox')) continue;
    if (re && !re.test(idf) && !re.test(id)) continue;
    const p = propsOf(n, idf);
    L.push(`${tag(id)} ${pos(n)}${p ? '  ' + p : ''}`);
    for (const io of wired) {
      const to = [];
      for (const l of io.children.filter(c => c.tag === 'link')) { const e = (wireEnds.get(X.get(l, 'w')) || []).find(x => !(x.id === id && x.conn === X.get(io, 'name'))); to.push(e ? `${tag(e.id)}.${e.conn}` : '(loose)'); }
      L.push(`   ${io.tag === 'input' ? '<-' : '->'} ${X.get(io, 'name')}: ${to.join(', ')}`);
    }
    const cb = n.children.find(c => c.tag === 'CircuitBox');
    if (cb) L.push(...box(n, cb, items).map(s => '   ' + s));
  }
  return L.join('\n');
}

// a circuit box's insides: components (with settings), wires, pin labels and notes
function box(n, cb, items) {
  const L = [], slots = (X.get(X.kids(n, 'ItemContainer')[0] || { attrs: [] }, 'contained') || '').split(',').map(s => s.split(';').filter(Boolean));
  const name = {}, comp = {};
  for (const c of X.kids(cb, 'Component')) {
    const [s, k] = (X.get(c, 'backingitemid') || '').split(',').map(Number), ci = items.get((slots[s] || [])[k || 0]), idf = ci ? X.get(ci, 'identifier') : X.get(c, 'item') || '?';
    name[X.get(c, 'id')] = `${idf.replace(/component$/, '')}${X.get(c, 'id')}`; comp[X.get(c, 'id')] = { ci, idf };
  }
  for (const io of ['InputNode', 'OutputNode']) for (const nd of X.kids(cb, io)) { const ls = X.kids(nd, 'ConnectionLabelOverride').map(o => `${X.get(o, 'name')}="${X.get(o, 'value')}"`); if (ls.length) L.push(`box ${io === 'InputNode' ? 'inputs' : 'outputs'}: ${ls.join(' ')}`); }
  for (const [id, { ci, idf }] of Object.entries(comp)) { const p = ci ? propsOf(ci, idf) : ''; L.push(`[${name[id]}]${p ? ' ' + p : ''}`); }
  const end = e => { const t = X.get(e, 'target'); return t === '' || t === undefined ? 'BOX.' + X.get(e, 'name') : `${name[t] || '#' + t}.${X.get(e, 'name')}`; };
  const groups = {};
  for (const w of X.kids(cb, 'Wire')) { const fr = X.kids(w, 'From')[0], to = X.kids(w, 'To')[0]; if (fr && to) (groups[end(fr)] = groups[end(fr)] || []).push(end(to)); }
  for (const [k, v] of Object.entries(groups)) L.push(`  ${k} -> ${v.join(', ')}`);
  for (const l of X.kids(cb, 'Label')) L.push(`  note "${X.get(l, 'header') || ''}": ${(X.get(l, 'body') || '').replace(/\s+/g, ' ')}`);
  return L;
}
module.exports = { explain };
