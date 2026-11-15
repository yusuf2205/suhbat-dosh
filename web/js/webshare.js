// "Share" from another app into the installed web app (Android Chrome, Windows/Chromium): the browser sends the files and the text to /share-target,
// the service worker keeps them and opens the app with ?shared=1, and here the person picks the chat. (iPhone has no such door for web apps.)
import { h, clear, formatBytes } from './dom.js';
import { S, chatTitle } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';
import { t } from './i18n.js';

async function wipe() {
  for (const k of await caches.keys()) {
    const c = await caches.open(k);
    for (const r of await c.keys()) if (new URL(r.url).pathname.startsWith('/__share/')) await c.delete(r);
  }
}

export async function checkShared() {
  if (!/[?&]shared=1(&|$)/.test(location.search)) return;
  history.replaceState(null, '', location.pathname + location.hash);
  let meta;
  try { meta = await (await caches.match('/__share/meta'))?.json(); } catch { meta = null; }
  if (!meta || (!meta.files?.length && !meta.text)) return;
  // the chats may still be loading when the app has just been opened
  for (let i = 0; i < 40 && !S.chats.size; i++) await new Promise((r) => setTimeout(r, 250));
  const total = (meta.files || []).reduce((a, f) => a + (f.size || 0), 0);
  let query = '';
  const list = h('div', { class: 'ws-list' });
  const draw = () => {
    clear(list);
    const q = query.trim().toLowerCase();
    const chats = [...S.chats.values()].filter((c) => !q || chatTitle(c).toLowerCase().includes(q))
      .sort((a, b) => (b.last_message?.created_at || 0) - (a.last_message?.created_at || 0)).slice(0, 40);
    list.append(...(chats.length ? chats.map((c) => h('button', { class: 'cal-row', type: 'button', onclick: () => send(c.id) }, h('span', { class: 'cal-main' }, h('b', null, chatTitle(c)))))
      : [h('p', { class: 'muted' }, t('ws.none'))]));
  };
  const m = modal({ title: t('ws.title'), className: 'drive', body: [
    h('p', null, meta.files?.length ? h('b', null, meta.files.length === 1 ? meta.files[0].name : t('ws.n_files', { n: meta.files.length })) : h('span', null, (meta.text || '').slice(0, 200)), meta.files?.length ? ` · ${formatBytes(total)}` : ''),
    h('input', { class: 'input', type: 'search', placeholder: t('ws.search'), 'aria-label': t('ws.search'), oninput: (e) => { query = e.target.value; draw(); } }),
    list,
  ], onClose: () => { wipe(); } });
  const send = async (chatId) => {
    m.close();
    try {
      if (meta.files?.length) {
        const files = [];
        for (const f of meta.files) {
          const r = await caches.match(`/__share/${f.i}`);
          files.push(new File([await r.blob()], f.name || 'file', { type: f.type || '' }));
        }
        window.__openChat?.(chatId);
        const { attachFiles } = await import('./chat.js');
        attachFiles(chatId, files);
      }
      if (meta.text) await api('POST', `/api/chats/${chatId}/messages`, { text: meta.text.slice(0, 4000), client_id: crypto.randomUUID() });
      if (!meta.files?.length) window.__openChat?.(chatId);
    } catch { toast(t('ws.failed'), 5000); }
  };
  draw();
}
