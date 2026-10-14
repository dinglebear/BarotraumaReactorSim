// Lossless-enough XML for submarine files: keeps element order, attribute order and raw attribute text, so an edited
// .sub differs from the original only where it was edited. Nodes: { tag, attrs: [[name, rawValue]], children: [] }.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BaroSubXml = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const dec = s => s.replace(/&(#x[0-9a-fA-F]+|#\d+|quot|amp|lt|gt|apos);/g, (m, e) => e[0] === '#' ? String.fromCharCode(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" }[e]);
  const enc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

  function parse(text) {
    const root = { tag: '#root', attrs: [], children: [] }, stack = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=\/>]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
    let m;
    while ((m = re.exec(text))) {
      if (!m[2]) continue;
      if (m[1]) { stack.pop(); continue; }
      const attrs = []; m[3].replace(/([^\s=\/>]+)\s*=\s*"([^"]*)"/g, (q, k, v) => { attrs.push([k, v]); return ''; });
      const n = { tag: m[2], attrs, children: [] };
      stack[stack.length - 1].children.push(n);
      if (!m[4]) stack.push(n);
    }
    return root;
  }
  function serialize(node, depth) {
    depth = depth || 0;
    if (node.tag === '#root') return node.children.map(c => serialize(c, 0)).join('\n') + '\n';
    const pad = '  '.repeat(depth), a = node.attrs.map(([k, v]) => ` ${k}="${v}"`).join('');
    if (!node.children.length) return `${pad}<${node.tag}${a} />`;
    return `${pad}<${node.tag}${a}>\n${node.children.map(c => serialize(c, depth + 1)).join('\n')}\n${pad}</${node.tag}>`;
  }
  const get = (n, k) => { const a = n.attrs.find(x => x[0] === k) || n.attrs.find(x => x[0].toLowerCase() === k.toLowerCase()); return a ? dec(a[1]) : undefined; };
  const set = (n, k, v) => { const a = n.attrs.find(x => x[0] === k) || n.attrs.find(x => x[0].toLowerCase() === k.toLowerCase()); if (a) a[1] = enc(v); else n.attrs.push([k, enc(v)]); };
  const del = (n, k) => { n.attrs = n.attrs.filter(x => x[0].toLowerCase() !== k.toLowerCase()); };
  const clone = n => ({ tag: n.tag, attrs: n.attrs.map(a => [a[0], a[1]]), children: n.children.map(clone) });
  const el = (tag, attrs, children) => ({ tag, attrs: Object.entries(attrs || {}).map(([k, v]) => [k, enc(v)]), children: children || [] });
  const kids = (n, tag) => n.children.filter(c => c.tag === tag);
  return { parse, serialize, get, set, del, clone, el, kids, enc, dec };
});
