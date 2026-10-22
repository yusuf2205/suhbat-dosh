// Settings → "Bridge with Telegram": link your own Telegram account by the QR code Telegram shows for a new device, choose the chats to
// mirror, and decide for each one whether it may be answered from here. Disconnecting ends the session on Telegram's side.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { qrCanvas } from './qr.js';
import { confirmDialog, modal, toast } from './ui.js';
import { icon } from './icons.js';

/** Remember on the page whether this person may use the bridge (the settings row appears only then). */
export async function checkBridge() {
  if (!S.cfg?.bridge || !S.me) return;
  try { S.bridgeOk = !!(await api('GET', '/api/bridge')).available; } catch { S.bridgeOk = false; }
}

export function openBridge() {
  let timer = 0;
  let alive = true;
  const win = modal({ title: t('br.title'), className: 'bridge-modal', body: h('div', { class: 'empty' }, t('list.loading')), onClose: () => { alive = false; clearTimeout(timer); } });
  const fail = (e) => toast(e.status === 0 ? t('net.offline') : errText(e.code));

  async function draw() {
    let st;
    try { st = await api('GET', '/api/bridge'); } catch (e) { fail(e); win.close(); return; }
    if (!alive) return;
    if (!st.available) return win.setBody(h('p', { class: 'muted' }, t('br.unavailable')));
    if (st.busy) return win.setBody(h('p', { class: 'muted' }, t('br.busy')));
    if (!st.running && !st.linked) return win.setBody(h('p', { class: 'muted' }, t('br.not_running')), h('code', { class: 'br-cmd' }, 'docker compose --profile tgbridge up -d --build tgbridge'));
    return st.linked ? connected(st) : intro();
  }

  // ---------------------------------------------------------- not linked yet
  function intro() {
    const ok = h('input', { type: 'checkbox' });
    const go = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => qrStep() }, t('br.show_qr'));
    ok.addEventListener('change', () => { go.disabled = !ok.checked; });
    win.setBody(
      h('p', null, t('br.what')),
      h('h4', null, t('br.safe_title')),
      h('ul', { class: 'br-list' }, ['br.safe1', 'br.safe2', 'br.safe3', 'br.safe4', 'br.safe5'].map((k) => h('li', null, t(k)))),
      h('h4', null, t('br.risk_title')),
      h('ul', { class: 'br-list warn' }, ['br.risk1', 'br.risk2', 'br.risk3'].map((k) => h('li', null, t(k)))),
      h('label', { class: 'br-ack' }, ok, h('span', null, t('br.ack'))), go);
  }

  async function qrStep() {
    let s;
    try { s = await api('POST', '/api/bridge/start'); } catch (e) { fail(e); return; }
    const box = h('div', { class: 'qrlogin-box' }, qrCanvas(s.url, 240));
    const status = h('p', { class: 'muted', role: 'status' }, t('br.waiting'));
    win.setBody(
      h('p', null, t('br.scan_intro')),
      h('div', { class: 'qrlogin' }, box, status, h('ol', { class: 'qrlogin-steps' }, ['br.step1', 'br.step2', 'br.step3'].map((k) => h('li', null, t(k))))),
      h('button', { class: 'btn link', type: 'button', onclick: () => draw() }, t('common.cancel')));
    const until = Date.now() + (s.expires_in || 120) * 1000;
    const tick = async () => {
      if (!alive) return;
      if (Date.now() > until + 5000) { status.textContent = t('qrl.expired'); box.replaceChildren(h('button', { class: 'btn secondary', type: 'button', onclick: () => qrStep() }, t('qrl.refresh'))); return; }
      try {
        const r = await api('GET', '/api/bridge/poll');
        if (r.url && r.url !== s.url && r.status === 'waiting') { s.url = r.url; box.replaceChildren(qrCanvas(r.url, 240)); }
        if (r.status === 'done') { toast(t('br.linked')); draw(); return; }
        if (r.status === 'password') { passwordStep(); return; }
        if (r.status === 'expired' || r.status === 'error') { status.textContent = t(r.status === 'error' ? 'br.error' : 'qrl.expired'); box.replaceChildren(h('button', { class: 'btn secondary', type: 'button', onclick: () => qrStep() }, t('qrl.refresh'))); return; }
      } catch (e) { if (e.status !== 0) { fail(e); return; } }
      timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 1500);
  }

  function passwordStep() {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: t('br.password'), 'aria-label': t('br.password') });
    const err = h('div', { class: 'err', role: 'alert' });
    const go = async () => {
      err.textContent = '';
      try { await api('POST', '/api/bridge/password', { password: pw.value }); pw.value = ''; toast(t('br.linked')); draw(); } catch (e) { err.textContent = e.code === 'wrong_password' ? t('br.wrong_password') : errText(e.code); }
    };
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    win.setBody(h('p', null, t('br.password_hint')), pw, err, h('button', { class: 'btn', type: 'button', onclick: go }, t('login.verify')));
    setTimeout(() => pw.focus(), 50);
  }

  // ---------------------------------------------------------- linked
  function connected(st) {
    const keep = h('select', { class: 'input', 'aria-label': t('br.keep') }, [[0, 'br.keep_all'], [30, 'br.keep_30'], [7, 'br.keep_7'], [1, 'br.keep_1']].map(([v, k]) => h('option', { value: String(v), selected: st.keep_days === v }, t(k))));
    keep.addEventListener('change', async () => { try { await api('PUT', '/api/bridge/settings', { keep_days: Number(keep.value) }); toast(t('br.saved')); } catch (e) { fail(e); } });
    win.setBody(
      h('div', { class: 'br-account' }, icon('telegram', 24), h('span', null, h('b', null, st.account.name || 'Telegram'), st.account.username ? h('small', { class: 'muted' }, ` @${st.account.username}`) : null), h('span', { class: 'att-badge ok' }, t('br.on'))),
      h('h4', null, t('br.chats_title')),
      st.chats.length ? h('div', { class: 'br-chats' }, st.chats.map((c) => h('div', { class: 'br-chat' }, h('b', null, c.title), h('small', { class: 'muted' }, c.two_way ? t('br.two_way') : t('br.read_only'))))) : h('p', { class: 'muted' }, t('br.no_chats')),
      h('button', { class: 'btn', type: 'button', onclick: () => pick(st) }, t(st.chats.length ? 'br.change_chats' : 'br.pick_chats')),
      h('h4', null, t('br.keep')), keep, h('p', { class: 'muted small' }, t('br.keep_hint')),
      h('div', { class: 'br-danger' },
        h('button', { class: 'btn danger', type: 'button', onclick: () => disconnect() }, t('br.disconnect')),
        h('p', { class: 'muted small' }, t('br.revoke_hint'))));
  }

  async function pick(st) {
    win.setBody(h('div', { class: 'empty' }, t('list.loading')));
    let r;
    try { r = await api('GET', '/api/bridge/dialogs'); } catch (e) { fail(e); draw(); return; }
    const rows = r.dialogs.map((d) => {
      const on = h('input', { type: 'checkbox', checked: d.picked });
      const two = h('input', { type: 'checkbox', checked: d.two_way, disabled: !d.picked });
      on.addEventListener('change', () => { two.disabled = !on.checked; if (!on.checked) two.checked = false; });
      return { d, on, two, el: h('div', { class: 'br-pick' }, h('label', { class: 'br-pick-main' }, on, h('span', null, h('b', null, d.title), h('small', { class: 'muted' }, ` ${t(`br.type_${d.type}`)}`))),
        h('label', { class: 'br-pick-two', title: t('br.two_hint') }, two, h('span', null, t('br.answer_here')))) };
    });
    win.setBody(
      h('p', { class: 'muted' }, t('br.pick_hint')),
      h('div', { class: 'br-picks' }, rows.map((x) => x.el)),
      h('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } },
        h('button', { class: 'btn secondary', type: 'button', style: { flex: 1 }, onclick: () => draw() }, t('common.cancel')),
        h('button', { class: 'btn', type: 'button', style: { flex: 1 }, onclick: async () => {
          try { await api('PUT', '/api/bridge/chats', { chats: rows.filter((x) => x.on.checked).map((x) => ({ id: x.d.id, title: x.d.title, two_way: x.two.checked })) }); toast(t('br.saved')); draw(); } catch (e) { fail(e); }
        } }, t('settings.save'))));
  }

  async function disconnect() {
    if (!(await confirmDialog(t('br.disconnect_confirm'), { okLabel: t('br.disconnect'), danger: true }))) return;
    const wipe = await confirmDialog(t('br.delete_copies'), { okLabel: t('br.delete_yes') });
    try { await api('POST', '/api/bridge/disconnect', { delete_messages: wipe }); toast(t('br.disconnected')); draw(); } catch (e) { fail(e); }
  }

  draw();
  return win;
}
void clear;
