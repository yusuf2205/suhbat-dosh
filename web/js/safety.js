// Safety check of a conversation partner. Both phones compute the same 60-digit number from the public keys of every device of
// both people; if the numbers match (read aloud, or scanned as a QR code) nobody has slipped in between. The server only hands
// out public keys and remembers which number was confirmed. If a key changes later, the number no longer matches.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { avatar, confirmDialog, fmtDay, modal, toast } from './ui.js';
import { qrCanvas } from './qr.js';
import { registerDevice, e2eSupported } from './e2egroup.js';
import { icon } from './icons.js';

const enc = new TextEncoder();
const PREFIX = 'suhbat-verify:1:';

async function sha(text) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, '0')).join('');

/** The 60 digits for a pair of people, the same on both phones. */
export async function safetyNumber(aId, aPubs, bId, bPubs) {
  const fp = async (id, pubs) => hex(await sha(`${id}|${[...pubs].sort().join(',')}`));
  const parts = [await fp(aId, aPubs), await fp(bId, bPubs)].sort().join('|');
  const bytes = new Uint8Array([...await sha(`${parts}|1`), ...await sha(`${parts}|2`)]);
  const view = new DataView(bytes.buffer);
  let out = '';
  for (let i = 0; i < 12; i += 1) out += String(view.getUint32(i * 4) % 100000).padStart(5, '0');
  return out;
}

/** { number, status: 'none' | 'ok' | 'changed' | 'nokeys', at, mine, theirs } for me and one person. */
export async function safetyState(peerId) {
  if (e2eSupported()) { try { await registerDevice(); } catch { /* the check still shows what exists */ } }
  const [me, peer] = await Promise.all([api('GET', `/api/users/${S.me.id}/safety`), api('GET', `/api/users/${peerId}/safety`)]);
  if (!me.devices.length || !peer.devices.length) return { status: 'nokeys', mine: me.devices.length, theirs: peer.devices.length };
  const number = await safetyNumber(S.me.id, me.devices, peerId, peer.devices);
  const v = peer.verified;
  return { number, status: !v ? 'none' : v.number === number ? 'ok' : 'changed', at: v?.at || 0, mine: me.devices.length, theirs: peer.devices.length };
}

const groups = (n) => n.match(/.{5}/g);

export async function openSafety(peer, onChange) {
  const m = modal({ title: t('sf.title'), className: 'safety-modal', body: h('div', { class: 'empty' }, t('list.loading')) });
  const draw = async () => {
    let st;
    try { st = await safetyState(peer.id); } catch (e) { toast(errText(e.code)); m.close(); return; }
    onChange?.(st);
    if (st.status === 'nokeys') {
      m.setBody(h('p', { class: 'muted' }, st.mine ? t('sf.peer_nokeys', { name: peer.name }) : t('sf.me_nokeys')));
      return;
    }
    const link = `${PREFIX}${S.me.id}:${peer.id}:${st.number}`;
    const rows = groups(st.number);
    const banner = st.status === 'ok'
      ? h('div', { class: 'sf-banner ok' }, icon('check', 18), h('span', null, t('sf.ok', { day: fmtDay(st.at).toLowerCase() })))
      : st.status === 'changed' ? h('div', { class: 'sf-banner bad' }, '⚠', h('span', null, t('sf.changed', { name: peer.name }))) : null;
    m.setBody(
      h('div', { class: 'sf-head' }, avatar(S.me, 'md'), h('span', { class: 'sf-link' }, '⇄'), avatar(peer, 'md')),
      h('p', { class: 'muted', style: { textAlign: 'center' } }, t('sf.intro', { name: peer.name })),
      banner,
      h('div', { class: 'sf-qr' }, qrCanvas(link, 220, { logo: false, animate: false })),
      h('div', { class: 'sf-number', 'aria-label': t('sf.number') }, [0, 1, 2].map((r) => h('div', null, rows.slice(r * 4, r * 4 + 4).map((g) => h('span', null, g))))),
      h('div', { class: 'sf-actions' },
        h('button', { class: 'btn', type: 'button', onclick: async () => { m.close(); (await import('./scanner.js')).openScanner(); } }, icon('qr', 18), h('span', null, t('sf.scan'))),
        h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await api('POST', `/api/users/${peer.id}/verify`, { number: st.number }); toast(t('sf.marked')); draw(); } catch (e) { toast(errText(e.code)); } } }, t('sf.mark')),
        st.status === 'ok' || st.status === 'changed'
          ? h('button', { class: 'btn link', type: 'button', onclick: async () => { await api('DELETE', `/api/users/${peer.id}/verify`).catch(() => {}); draw(); } }, t('sf.unmark')) : null),
      h('p', { class: 'muted small' }, t('sf.how')));
  };
  draw();
  return m;
}

/** A scanned "suhbat-verify" code from the other person's phone. Returns true when the text was one of ours. */
export async function handleVerifyScan(text) {
  if (!String(text).startsWith(PREFIX)) return false;
  const [senderId, peerId, number] = String(text).slice(PREFIX.length).split(':');
  if (Number(peerId) !== S.me.id || !/^\d{60}$/.test(number || '')) { toast(t('sf.not_for_me')); return true; }
  let st;
  try { st = await safetyState(Number(senderId)); } catch (e) { toast(errText(e.code)); return true; }
  if (st.status === 'nokeys' || st.number !== number) {
    await confirmDialog(t('sf.mismatch'), { okLabel: t('common.ok') || 'OK', danger: true });
    return true;
  }
  try { await api('POST', `/api/users/${senderId}/verify`, { number }); toast(t('sf.verified_scan')); } catch (e) { toast(errText(e.code)); }
  return true;
}

/** A row for the info page of a one-to-one chat: opens the check and shows the state. */
export function safetyRow(peer) {
  const label = h('small', { class: 'muted' }, '…');
  const row = h('button', { class: 'list-item clickable', type: 'button', onclick: () => openSafety(peer, show) }, icon('shield', 22), h('span', { class: 'grow' }, h('b', null, t('sf.title')), h('br'), label));
  function show(st) {
    label.textContent = st.status === 'ok' ? t('sf.row_ok') : st.status === 'changed' ? t('sf.row_changed') : st.status === 'nokeys' ? t('sf.row_nokeys') : t('sf.row_none');
    row.classList.toggle('sf-bad', st.status === 'changed');
  }
  safetyState(peer.id).then(show).catch(() => { label.textContent = ''; });
  return row;
}
