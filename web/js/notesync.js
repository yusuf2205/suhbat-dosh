// The editing side of a shared note, without any DOM: keeps what the server confirmed (doc), what is on its way (inflight)
// and what the person sees (local), and rebases the visible text whenever the server's text changes.
import { applyOp, diffOp, transform } from '../../shared/ot.js';

export class NoteClient {
  /** send(op) -> Promise<{ rev, op }>, may reject with { code: 'resync' } or a network error; onText(text) shows the text. */
  constructor({ send, onText, onResync, cid = Math.random().toString(36).slice(2, 10) }) {
    this.send = send;
    this.onText = onText;
    this.onResync = onResync;
    this.cid = cid;
    this.doc = '';
    this.rev = 0;
    this.sent = '';
    this.local = '';
    this.inflight = null;
    this.seq = 0;
    this.retry = 0;
    this.dead = false;
  }

  init(body, rev) {
    this.doc = body;
    this.rev = rev;
    this.sent = body;
    this.local = body;
    this.inflight = null;
    this.onText(body);
  }

  /** The person changed the text. */
  edit(text) {
    this.local = text;
    this.pump();
  }

  /** Something the server decided: an edit of somebody else, or the confirmation of ours. */
  serverOp({ rev, op, cid }) {
    if (rev <= this.rev) return; // already seen (the answer and the broadcast of our own edit both arrive)
    if (rev > this.rev + 1) { this.onResync?.(); return; } // a gap: ask the server for the whole text
    const own = !!this.inflight && cid === this.inflight.cid;
    const sentOld = this.sent;
    this.doc = applyOp(this.doc, op);
    this.rev = rev;
    let sentNew;
    if (own) {
      this.inflight = null;
      this.retry = 0;
      sentNew = this.doc;
    } else {
      if (this.inflight) this.inflight = { ...transform(this.inflight, op), cid: this.inflight.cid, base: rev };
      sentNew = this.inflight ? applyOp(this.doc, this.inflight) : this.doc;
    }
    this.rebase(sentOld, sentNew);
    this.sent = sentNew;
    this.pump();
  }

  /** The history was too old or had a gap: take the server text and keep what the person typed on top of it. */
  resync(body, rev) {
    const oldDoc = this.doc;
    this.doc = body;
    this.rev = rev;
    this.inflight = null;
    this.retry = 0;
    this.rebase(oldDoc, body, this.local);
    this.sent = body;
    this.pump();
  }

  rebase(from, to, local = this.local) {
    const mine = diffOp(from, local);
    const delta = diffOp(from, to);
    const next = mine ? applyOp(to, transform(mine, delta)) : to;
    const changed = next !== this.local;
    this.local = next;
    if (changed) this.onText(next);
  }

  pump() {
    if (this.inflight || this.dead || this.local === this.doc) return;
    const op = diffOp(this.doc, this.local);
    if (!op) return;
    this.inflight = { ...op, cid: `${this.cid}${++this.seq}`, base: this.rev };
    this.sent = this.local;
    this.transmit();
  }

  async transmit() {
    const op = this.inflight;
    if (!op) return;
    try {
      const r = await this.send({ rev: op.base, pos: op.pos, del: op.del, ins: op.ins, cid: op.cid });
      this.serverOp({ rev: r.rev, op: r.op, cid: op.cid });
    } catch (e) {
      if (this.dead) return;
      if (e?.code === 'resync') { this.onResync?.(); return; }
      if (e?.status >= 400 && e?.status < 500 && e?.status !== 429) { this.inflight = null; this.sent = this.doc; this.onResync?.(); return; }
      // the network is down: the same edit is sent again, it is still based on the same revision
      this.retry += 1;
      setTimeout(() => { if (this.inflight?.cid === op.cid) this.transmit(); }, Math.min(8000, 400 * 2 ** this.retry));
    }
  }

  stop() { this.dead = true; }
}
