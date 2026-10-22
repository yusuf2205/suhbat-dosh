// Settings → "Bridge with Telegram": link your own Telegram account by the QR code Telegram shows for a new device. Every personal chat is
// copied quietly (muted, no notifications); groups and channels only when picked; a chat can be answered from here only when allowed.
// Disconnecting ends the session on Telegram's side.
import { h } from './dom.js';
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
    clearTimeout(timer);
    let st;
    try { st = await api('GET', '/api/bridge'); } catch (e) { fail(e); win.close(); return; }
    if (!alive) return;
    if (!st.available) return win.setBody(h('p', { class: 'muted' }, t('br.unavailable')));
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
      h('ul', { class: 'br-list warn' }, ['br.risk1', 'br.risk2', 'br.risk3', 'br.risk4', ...(S.me?.is_admin ? [] : ['br.risk5'])].map((k) => h('li', null, t(k)))),
      h('label', { class: 'br-ack' }, ok, h('span', null, t('br.ack'))), go);
  }

  async function qrStep() {
    let s;
    try { s = await api('POST', '/api/bridge/start'); } catch (e) { fail(e); return; }
    const box = h('div', { class: 'qrlogin-box' }, qrCanvas(s.url, 240, { logo: false, animate: false }));
    const status = h('p', { class: 'muted', role: 'status' }, t('br.waiting'));
    win.setBody(
      h('p', null, t('br.scan_intro')),
      h('div', { class: 'qrlogin' }, box, status, h('ol', { class: 'qrlogin-steps' }, ['br.step1', 'br.step2', 'br.step3'].map((k) => h('li', null, t(k))))),
      h('button', { class: 'btn link', type: 'button', onclick: () => draw() }, t('common.cancel')));
    const until = Date.now() + (s.expires_in || 120) * 1000;
    const again = () => box.replaceChildren(h('button', { class: 'btn secondary', type: 'button', onclick: () => qrStep() }, t('qrl.refresh')));
    const tick = async () => {
      if (!alive) return;
      if (Date.now() > until + 5000) { status.textContent = t('qrl.expired'); again(); return; }
      try {
        const r = await api('GET', '/api/bridge/poll');
        if (r.url && r.url !== s.url && r.status === 'waiting') { s.url = r.url; box.replaceChildren(qrCanvas(r.url, 240, { logo: false, animate: false })); }
        if (r.status === 'done') { toast(t('br.linked')); draw(); setTimeout(() => { if (alive && win.el.querySelector('.br-account') && !win.el.querySelector('.br-pick')) draw(); }, 6000); return; }
        if (r.status === 'password') { passwordStep(); return; }
        if (r.status === 'expired' || r.status === 'error') { status.textContent = t(r.status === 'error' ? 'br.error' : 'qrl.expired'); again(); return; }
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
      try { await api('POST', '/api/bridge/password', { password: pw.value }); pw.value = ''; toast(t('br.linked')); draw(); setTimeout(() => { if (alive && win.el.querySelector('.br-account') && !win.el.querySelector('.br-pick')) draw(); }, 6000); } catch (e) { err.textContent = e.code === 'wrong_password' ? t('br.wrong_password') : errText(e.code); }
    };
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    win.setBody(h('p', null, t('br.password_hint')), pw, err, h('button', { class: 'btn', type: 'button', onclick: go }, t('login.verify')));
    setTimeout(() => pw.focus(), 50);
  }

  // ---------------------------------------------------------- linked
  function connected(st) {
    const auto = h('input', { type: 'checkbox', checked: st.auto_private });
    auto.addEventListener('change', async () => {
      try { await api('PUT', '/api/bridge/chats', { auto_private: auto.checked, chats: [] }); toast(t('br.saved')); draw(); } catch (e) { auto.checked = !auto.checked; fail(e); }
    });
    const find = h('input', { class: 'input', type: 'search', placeholder: t('br.search'), 'aria-label': t('br.search') });
    const list = h('div', { class: 'br-chats' });
    const drawList = () => {
      const term = find.value.trim().toLowerCase();
      const rows = st.chats.filter((c) => !term || c.title.toLowerCase().includes(term));
      list.replaceChildren(...(rows.length ? rows.map((c) => {
        const two = h('input', { type: 'checkbox', checked: c.two_way });
        two.addEventListener('change', async () => {
          try { await api('PUT', '/api/bridge/chats', { chats: [{ id: c.tg_chat, title: c.title, kind: c.kind, two_way: two.checked }] }); c.two_way = two.checked; toast(t('br.saved')); } catch (e) { two.checked = !two.checked; fail(e); }
        });
        return h('div', { class: 'br-chat' },
          h('span', { class: 'br-chat-name' }, h('b', null, c.title), h('small', { class: 'muted' }, t(`br.type_${c.kind}`))),
          h('label', { class: 'br-pick-two', title: t('br.two_hint') }, two, h('span', null, t('br.answer_here'))),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('br.stop_chat'), title: t('br.stop_chat'), onclick: async () => {
            if (!(await confirmDialog(t('br.stop_confirm', { name: c.title }), { okLabel: t('br.stop_chat') }))) return;
            try { await api('PUT', '/api/bridge/chats', { chats: [{ id: c.tg_chat, title: c.title, kind: c.kind, remove: true }] }); draw(); } catch (e) { fail(e); }
          } }, icon('close', 18)));
      }) : [h('p', { class: 'muted' }, st.chats.length ? t('sn.none_found') : t('br.no_chats'))]));
    };
    find.addEventListener('input', drawList);
    drawList();
    const sync = st.backfill ? h('p', { class: 'br-sync', role: 'status' }, t('br.syncing', { done: st.backfill.done, total: st.backfill.total })) : null;
    if (sync) timer = setTimeout(draw, 4000);
    win.setBody(
      h('div', { class: 'br-account' }, icon('telegram', 24), h('span', null, h('b', null, st.account.name || 'Telegram'), st.account.username ? h('small', { class: 'muted' }, ` @${st.account.username}`) : null), h('span', { class: 'att-badge ok' }, t('br.on'))),
      ...(sync ? [sync] : []),
      st.personal_hidden
        ? h('div', { class: 'br-ack' }, icon('lock', 18), h('span', null, h('b', null, t('br.personal_title')), h('small', { class: 'muted' }, ` ${t('br.personal_hidden', { n: st.personal_count })}`)))
        : h('label', { class: 'br-ack' }, auto, h('span', null, h('b', null, t('br.auto')), h('small', { class: 'muted' }, ` ${t('br.auto_hint')}`))),
      h('h4', null, `${t('br.chats_title')} (${st.chats.length})`), find, list,
      h('button', { class: 'btn secondary', type: 'button', style: { width: '100%' }, onclick: () => pick(st) }, t('br.add_groups')),
      h('button', { class: 'btn link', type: 'button', onclick: async () => { try { await api('POST', '/api/bridge/sync'); toast(t('br.sync_started')); draw(); } catch (e) { fail(e); } } }, t('br.sync_now')),
      h('p', { class: 'muted small' }, t('br.admin_note')),
      h('div', { class: 'br-danger' },
        h('button', { class: 'btn danger', type: 'button', onclick: () => disconnect() }, t('br.disconnect')),
        h('p', { class: 'muted small' }, t('br.revoke_hint'))));
  }

  /** Groups and channels: only those ticked here are copied. */
  async function pick(st) {
    win.setBody(h('div', { class: 'empty' }, t('list.loading')));
    let r;
    try { r = await api('GET', '/api/bridge/dialogs'); } catch (e) { fail(e); draw(); return; }
    const rows = r.dialogs.filter((d) => d.type !== 'user').map((d) => {
      const on = h('input', { type: 'checkbox', checked: d.picked });
      const two = h('input', { type: 'checkbox', checked: d.two_way, disabled: !d.picked });
      on.addEventListener('change', () => { two.disabled = !on.checked; if (!on.checked) two.checked = false; });
      return { d, on, two, el: h('div', { class: 'br-pick' }, h('label', { class: 'br-pick-main' }, on, h('span', null, h('b', null, d.title), h('small', { class: 'muted' }, ` ${t(`br.type_${d.type}`)}`))),
        h('label', { class: 'br-pick-two', title: t('br.two_hint') }, two, h('span', null, t('br.answer_here')))) };
    });
    const find = h('input', { class: 'input', type: 'search', placeholder: t('br.search'), 'aria-label': t('br.search') });
    find.addEventListener('input', () => { const term = find.value.trim().toLowerCase(); for (const x of rows) x.el.hidden = !!term && !x.d.title.toLowerCase().includes(term); });
    win.setBody(
      h('p', { class: 'muted' }, t('br.pick_hint')),
      rows.length ? find : null,
      rows.length ? h('div', { class: 'br-picks' }, rows.map((x) => x.el)) : h('p', { class: 'muted' }, t('br.no_groups')),
      h('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } },
        h('button', { class: 'btn secondary', type: 'button', style: { flex: 1 }, onclick: () => draw() }, t('common.cancel')),
        h('button', { class: 'btn', type: 'button', style: { flex: 1 }, onclick: async () => {
          const changes = rows.filter((x) => x.on.checked !== x.d.picked || x.two.checked !== !!x.d.two_way).map((x) => ({ id: x.d.id, title: x.d.title, kind: x.d.type, two_way: x.two.checked, remove: !x.on.checked }));
          try { await api('PUT', '/api/bridge/chats', { chats: changes }); toast(t('br.saved')); draw(); } catch (e) { fail(e); }
        } }, t('settings.save'))));
    void st;
  }

  async function disconnect() {
    if (!(await confirmDialog(t('br.disconnect_confirm'), { okLabel: t('br.disconnect'), danger: true }))) return;
    const wipe = await confirmDialog(t('br.delete_copies'), { okLabel: t('br.delete_yes') });
    try { await api('POST', '/api/bridge/disconnect', { delete_messages: wipe }); toast(t('br.disconnected')); draw(); } catch (e) { fail(e); }
  }

  draw();
  return win;
}
