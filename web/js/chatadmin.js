// Extra settings of a group or channel for its administrators: topics, comments, public page, invite links with limits and requests to join.
import { h, clear } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { S, fire, on } from './state.js';
import { api } from './net.js';
import { avatar, confirmDialog, modal, toast } from './ui.js';

const stamp = (ts) => new Date(ts).toLocaleString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const keep = (r) => { if (r?.chat) { S.chats.set(r.chat.id, r.chat); fire('chats'); } return r; };

function toggle(label, hint, checked, onchange) {
  const box = h('input', { type: 'checkbox', checked: !!checked });
  box.addEventListener('change', async () => {
    try { await onchange(box.checked); } catch (e) { box.checked = !box.checked; toast(errText(e.code)); }
  });
  return h('label', { class: 'focus-row' }, h('span', null, h('b', null, label), hint ? h('small', { class: 'muted' }, hint) : null), box);
}

/** The nodes for the info panel. redraw() reloads the panel after a change. */
export function adminNodes(chat, redraw) {
  const owner = chat.my_role === 'owner';
  const out = [h('h3', null, t('adm.title'))];
  out.push(toggle(t('adm.approval'), t('adm.approval_hint'), chat.join_approval, async (on) => { keep(await api('POST', `/api/chats/${chat.id}/approval`, { on })); redraw(); }));
  out.push(h('button', { class: 'btn secondary', type: 'button', onclick: () => openLinks(chat, redraw) }, t('adm.links')));
  out.push(h('button', { class: 'btn secondary', type: 'button', onclick: () => openRequests(chat, redraw) }, t('adm.requests')));
  if (owner && chat.type === 'group' && !chat.secret && !chat.imported) {
    out.push(toggle(t('adm.forum'), t('adm.forum_hint'), chat.forum, async (on) => { keep(await api('POST', `/api/chats/${chat.id}/forum`, { on })); redraw(); }));
  }
  if (owner && chat.type === 'channel') {
    out.push(toggle(t('adm.comments'), t('adm.comments_hint'), chat.comments, async (on) => { keep(await api('POST', `/api/chats/${chat.id}/comments-on`, { on })); redraw(); }));
    const slug = h('input', { class: 'input', maxLength: 32, value: chat.slug || '', placeholder: 'novosti_goroda', 'aria-label': t('adm.slug') });
    const err = h('div', { class: 'err', role: 'alert' });
    const link = chat.slug ? `${location.origin}/c/${chat.slug}` : '';
    out.push(h('div', { class: 'field' }, h('b', null, t('adm.page')), h('small', { class: 'muted' }, t('adm.page_hint')),
      h('div', { class: 'row', style: { gap: '8px' } }, slug,
        h('button', { class: 'btn small', type: 'button', onclick: async () => {
          err.textContent = '';
          try { keep(await api('POST', `/api/chats/${chat.id}/slug`, { slug: slug.value.trim() || null })); redraw(); } catch (e) { err.textContent = e.code === 'slug_taken' ? t('adm.slug_taken') : e.code === 'invalid_slug' ? t('adm.slug_bad') : errText(e.code); }
        } }, t('quick.save'))),
      err,
      link ? h('div', { class: 'invite' }, h('a', { href: link, target: '_blank', rel: 'noopener' }, link)) : null));
  }
  return out;
}

async function openLinks(chat, redraw) {
  const list = h('div', { class: 'links-list' });
  const name = h('input', { class: 'input', maxLength: 40, placeholder: t('links.name_ph'), 'aria-label': t('links.name_ph') });
  const hours = h('select', { class: 'input', 'aria-label': t('links.expires') }, [['', 'links.never'], ['1', 'links.h1'], ['24', 'links.h24'], ['168', 'links.d7'], ['720', 'links.d30']].map(([v, k]) => h('option', { value: v }, t(k))));
  const uses = h('input', { class: 'input', type: 'number', min: 1, max: 100000, placeholder: t('links.max_ph'), 'aria-label': t('links.max_ph') });
  const approval = h('input', { type: 'checkbox' });
  const win = modal({
    title: t('adm.links'), className: 'drive',
    body: [list, h('h3', null, t('links.new')), name, h('div', { class: 'row', style: { gap: '8px' } }, hours, uses),
      h('label', { class: 'row' }, approval, t('links.approval')),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        try {
          await api('POST', `/api/chats/${chat.id}/links`, { name: name.value.trim(), expires_hours: hours.value ? Number(hours.value) : null, max_uses: uses.value ? Number(uses.value) : null, approval: approval.checked });
          name.value = ''; uses.value = '';
          load();
        } catch (e) { toast(errText(e.code)); }
      } }, t('links.create'))],
  });
  const row = (label, code, extra, revoke) => {
    const url = `${location.origin}/#/join/${code}`;
    return h('div', { class: 'link-row' },
      h('div', { class: 'link-main' }, h('b', { class: 'ellipsis' }, label), h('small', { class: 'muted' }, extra), h('div', { class: 'invite' }, url)),
      h('div', { class: 'link-actions' },
        h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(url); toast(t('info.copied')); } catch { /* ignore */ } } }, t('info.copy')),
        revoke ? h('button', { class: 'btn small link', type: 'button', onclick: async () => {
          if (!(await confirmDialog(t('links.revoke_confirm'), { okLabel: t('links.revoke'), danger: true }))) return;
          await api('DELETE', `/api/chats/${chat.id}/links/${revoke}`).catch((e) => toast(errText(e.code)));
          load();
        } }, t('links.revoke')) : null));
  };
  async function load() {
    let r;
    try { r = await api('GET', `/api/chats/${chat.id}/links`); } catch (e) { win.close(); toast(errText(e.code)); return; }
    clear(list).append(
      row(t('links.main'), r.main, chat.join_approval ? t('adm.approval') : t('links.unlimited')),
      ...r.links.filter((l) => !l.revoked).map((l) => row(l.name || t('links.noname'),
        l.code, [l.max_uses ? `${l.uses}/${l.max_uses}` : `${l.uses} ${t('links.joined')}`, l.expires_at ? `${t('links.until')} ${stamp(l.expires_at)}` : '', l.approval ? t('adm.approval') : ''].filter(Boolean).join(' · '), l.id)));
    redraw?.();
  }
  load();
}

async function openRequests(chat, redraw) {
  const list = h('div', { class: 'requests-list' });
  const win = modal({ title: t('adm.requests'), body: [list] });
  async function load() {
    let r;
    try { r = await api('GET', `/api/chats/${chat.id}/requests`); } catch (e) { win.close(); toast(errText(e.code)); return; }
    clear(list);
    if (!r.requests.length) { list.append(h('p', { class: 'muted' }, t('requests.none'))); return; }
    for (const x of r.requests) {
      const act = (approve) => async () => { try { await api('POST', `/api/chats/${chat.id}/requests/${x.user.id}`, { approve }); load(); redraw?.(); } catch (e) { toast(errText(e.code)); } };
      list.append(h('div', { class: 'request-row' }, avatar(x.user, 'sm'),
        h('div', { class: 'link-main' }, h('b', { class: 'ellipsis' }, x.user.name), h('small', { class: 'muted' }, `${x.user.username ? `@${x.user.username} · ` : ''}${stamp(x.at)}`)),
        h('button', { class: 'btn small', type: 'button', onclick: act(true) }, t('requests.accept')),
        h('button', { class: 'btn small secondary', type: 'button', onclick: act(false) }, t('requests.decline'))));
    }
  }
  load();
}

on('ws', (ev) => {
  if (ev.type === 'join.request') {
    const c = S.chats.get(ev.chat_id);
    toast(`${t('requests.new')}: ${c?.title || ''} (${ev.count})`, 6000);
  } else if (ev.type === 'join.declined') toast(t('requests.declined', { title: ev.title || '' }), 6000);
});
