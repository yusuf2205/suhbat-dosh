// Memory manager: what the app keeps on this device (and how to clear it), and what your files take on the server.
import { h, clear, formatBytes } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { modal, toast, confirmDialog } from './ui.js';
import { clearAll as clearMedia, usage as mediaUsage } from './mediacache.js';
import { snapClear } from './snap.js';

const bar = (used, total) => {
  const i = h('i');
  queueMicrotask(() => { i.style.width = `${total ? Math.min(100, Math.round((used / total) * 100)) : 0}%`; });
  return h('div', { class: 'mini-bar st-bar' }, i);
};

export async function openStorage() {
  const body = h('div', { class: 'storage' }, h('p', { class: 'muted' }, t('list.loading')));
  const win = modal({ title: t('st.storage'), className: 'drive', body: [body] });
  let server;
  try { server = await api('GET', '/api/me/storage'); } catch (e) { win.close(); toast(errText(e.code)); return; }
  const local = await mediaUsage();

  const draw = async () => {
    const dev = await mediaUsage();
    const est = dev.quota;
    clear(body).append(...[
      h('h3', null, t('stor.device')),
      h('div', { class: 'st-row' }, h('span', null, t('stor.media_cache')), h('b', null, `${formatBytes(dev.bytes)} · ${dev.items}`)),
      est?.usage ? h('div', { class: 'st-row' }, h('span', null, t('stor.app_total')), h('b', null, `${formatBytes(est.usage)}${est.quota ? ` / ${formatBytes(est.quota)}` : ''}`)) : null,
      h('div', { class: 'st-actions' },
        h('button', { class: 'btn secondary', type: 'button', onclick: async () => { await clearMedia(); toast(t('stor.cleared')); draw(); } }, t('stor.clear_media')),
        h('button', { class: 'btn secondary', type: 'button', onclick: async () => { await snapClear(); toast(t('stor.cleared')); draw(); } }, t('stor.clear_offline'))),
      h('p', { class: 'muted' }, t('stor.device_hint')),
      h('h3', null, t('stor.server')),
      h('div', { class: 'st-row' }, h('span', null, t('stor.used')), h('b', null, `${formatBytes(server.used)}${server.quota ? ` / ${formatBytes(server.quota)}` : ''}`)),
      server.quota ? bar(server.used, server.quota) : null,
      server.kinds.length ? h('div', { class: 'st-kinds' }, server.kinds.map((k) => h('span', { class: 'task-chip' }, `${t(`digest.m_${k.kind}`)}: ${formatBytes(k.bytes)}`))) : null,
      server.chats.length ? h('h4', null, t('stor.by_chat')) : h('p', { class: 'muted' }, t('stor.nothing')),
      ...server.chats.slice(0, 12).map((c) => h('div', { class: 'st-row' }, h('span', { class: 'ellipsis' }, c.chat.title || c.chat.peer || ''), h('b', null, `${formatBytes(c.bytes)} · ${c.n}`))),
      server.biggest.length ? h('h4', null, t('stor.biggest')) : null,
      ...server.biggest.slice(0, 15).map((f) => h('div', { class: 'st-file' },
        h('span', { class: 'ellipsis' }, f.name),
        h('small', { class: 'muted' }, `${formatBytes(f.size)} · ${S.chats.get(f.chat_id)?.title || S.chats.get(f.chat_id)?.peer?.name || ''}`),
        h('button', { class: 'btn link', type: 'button', onclick: async () => {
          if (!(await confirmDialog(t('stor.delete_confirm', { name: f.name }), { okLabel: t('common.delete'), danger: true }))) return;
          try {
            await api('DELETE', `/api/messages/${f.message_id}`);
            server.biggest = server.biggest.filter((x) => x !== f);
            server.used -= f.size;
            draw();
          } catch (e) { toast(errText(e.code)); }
        } }, t('common.delete')))),
    ].filter(Boolean));
  };
  void local;
  draw();
}
