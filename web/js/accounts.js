// Several accounts on one device (work and personal): switch without signing out.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { api } from './net.js';
import { avatar, confirmDialog, modal, toast } from './ui.js';

export async function openAccounts() {
  const body = h('div', { class: 'accounts' }, h('p', { class: 'muted' }, t('list.loading')));
  const win = modal({ title: t('acc.title'), body: [body] });
  const draw = async () => {
    let r;
    try { r = await api('GET', '/api/accounts'); } catch (e) { win.close(); toast(errText(e.code)); return; }
    clear(body).append(...[
      h('p', { class: 'muted' }, t('acc.hint')),
      ...r.accounts.map((a) => h('div', { class: `acc-row${a.current ? ' current' : ''}` },
        avatar(a, 'sm'),
        h('div', { class: 'acc-main' }, h('b', { class: 'ellipsis' }, a.name), h('small', { class: 'muted' }, a.current ? t('acc.current') : (a.username ? `@${a.username}` : ''))),
        a.current ? null : h('button', { class: 'btn small', type: 'button', onclick: async () => {
          try { await api('POST', '/api/accounts/switch', { user_id: a.id }); location.reload(); } catch (e) { toast(errText(e.code)); }
        } }, t('acc.switch')),
        a.current ? null : h('button', { class: 'btn link', type: 'button', onclick: async () => {
          if (!(await confirmDialog(t('acc.remove_confirm', { name: a.name }), { okLabel: t('acc.remove'), danger: true }))) return;
          try { await api('DELETE', `/api/accounts/${a.id}`); draw(); } catch (e) { toast(errText(e.code)); }
        } }, t('acc.remove'))),
      ),
      r.accounts.length < r.max ? h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await api('POST', '/api/accounts/stash'); location.reload(); } catch (e) { toast(errText(e.code)); }
      } }, `+ ${t('acc.add')}`) : h('p', { class: 'muted' }, t('acc.max')),
      h('p', { class: 'muted' }, t('acc.push_note')),
    ].filter(Boolean));
  };
  draw();
}
