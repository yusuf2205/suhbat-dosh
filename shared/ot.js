// Text edits for shared notes. One edit = one replacement { pos, del, ins }: delete `del` characters at `pos`, insert `ins`.
// The server orders edits and is the single source of truth; clients predict, and are corrected by what the server confirms.
// Isomorphic and dependency-free: used by the server (notes) and the browser (editor) and covered by tests.

export const applyOp = (text, op) => text.slice(0, op.pos) + op.ins + text.slice(op.pos + op.del);

/** The smallest single replacement that turns `a` into `b` (common prefix and suffix are kept). */
export function diffOp(a, b) {
  if (a === b) return null;
  let s = 0;
  const max = Math.min(a.length, b.length);
  while (s < max && a[s] === b[s]) s += 1;
  let e = 0;
  while (e < max - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e += 1;
  return { pos: s, del: a.length - s - e, ins: b.slice(s, b.length - e) };
}

/**
 * Rewrite `a` so that it can be applied AFTER `b` (both were made on the same text).
 * Edits that touch different places just shift. When they overlap, the deletion of `a` is dropped and only its insertion
 * is kept: nothing typed by anybody is lost; the worst outcome is a bit of text that somebody wanted removed.
 * Inserts at the very same place keep their order: `b` comes first.
 */
export function transform(a, b) {
  if (!b) return a;
  const a1 = a.pos;
  const a2 = a.pos + a.del;
  const b1 = b.pos;
  const b2 = b.pos + b.del;
  if (b2 <= a1) return { ...a, pos: a.pos + b.ins.length - b.del };
  if (a2 <= b1) return a;
  return { pos: a1 <= b1 ? a1 : b1 + b.ins.length, del: 0, ins: a.ins };
}

/** Move a cursor position through an edit (for the caret of the person who did not make it). */
export function shiftCaret(pos, op) {
  if (!op) return pos;
  if (pos <= op.pos) return pos;
  if (pos >= op.pos + op.del) return pos + op.ins.length - op.del;
  return op.pos + op.ins.length;
}
