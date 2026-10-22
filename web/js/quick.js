// Quick replies: your own ready-made texts. Type "/" and a few letters in any chat and pick one; they are kept on the server,
// so they are the same on every device.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { api } from './net.js';
import { modal, toast, confirmDialog } from './ui.js';

let cache = null;
export async function quickList(force = false) {
  if (!cache || force) { try { cache = (await api('GET', '/api/me/quick')).replies; } catch { cache = cache || []; } }
  return cache;
}
export const forgetQuick = () => { cache = null; };

/** The "/shortcut" suggestions above the message field. */
export function attachQuick(ta, host, disabled) {
  const pop = h('div', { class: 'quick-pop', role: 'listbox', hidden: true });
  host.append(pop);
  let items = [];
  let sel = 0;
  const close = () => { pop.hidden = true; items = []; };
  const pick = (r) => {
    ta.value = r.text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    close();
  };
  const draw = () => {
    clear(pop).append(...items.map((r, i) => h('button', { class: `quick-item${i === sel ? ' sel' : ''}`, type: 'button', role: 'option', onmousedown: (e) => { e.preventDefault(); pick(r); } },
      h('b', null, `/${r.shortcut}`), h('span', { class: 'ellipsis' }, r.text))));
    pop.hidden = !items.length;
  };
  ta.addEventListener('input', async () => {
    const m = /^\/([\p{L}\p{N}_-]*)$/u.exec(ta.value);
    if (!m || disabled()) { close(); return; }
    const all = await quickList();
    const key = m[1].toLowerCase();
    items = all.filter((r) => r.shortcut.startsWith(key)).slice(0, 6);
    sel = 0;
    draw();
  });
  ta.addEventListener('keydown', (e) => {
    if (pop.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); sel = (sel + 1) % items.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); sel = (sel - 1 + items.length) % items.length; draw(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pick(items[sel]); }
    else if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); }
  }, true);
  ta.addEventListener('blur', () => setTimeout(close, 150));
}

/** The list of replies with add / edit / delete. onPick: show a "use" button that returns the text. */
export async function openQuickManager({ onPick } = {}) {
  const list = h('div', { class: 'quick-list' });
  const short = h('input', { class: 'input', maxLength: 24, placeholder: t('quick.shortcut_ph'), 'aria-label': t('quick.shortcut_ph') });
  const text = h('textarea', { class: 'input', rows: 2, maxLength: 1000, placeholder: t('quick.text_ph'), 'aria-label': t('quick.text_ph') });
  const err = h('div', { class: 'err', role: 'alert' });
  const win = modal({ title: t('quick.title'), className: 'drive', body: [h('p', { class: 'muted' }, t('quick.hint')), list, h('h3', null, t('quick.add')), short, text, err,
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      err.textContent = '';
      try {
        cache = (await api('POST', '/api/me/quick', { shortcut: short.value, text: text.value })).replies;
        short.value = ''; text.value = '';
        draw();
      } catch (e) { err.textContent = e.code === 'shortcut_taken' ? t('quick.taken') : errText(e.code); }
    } }, t('quick.save'))] });
  const draw = async () => {
    const all = await quickList();
    clear(list);
    if (!all.length) list.append(h('p', { class: 'muted' }, t('quick.empty')));
    for (const r of all) {
      list.append(h('div', { class: 'quick-row' },
        h('div', { class: 'quick-main' }, h('b', null, `/${r.shortcut}`), h('span', null, r.text)),
        onPick ? h('button', { class: 'btn small', type: 'button', onclick: () => { win.close(); onPick(r.text); } }, t('quick.use')) : null,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.delete'), onclick: async () => {
          if (!(await confirmDialog(t('quick.delete_confirm', { name: `/${r.shortcut}` }), { okLabel: t('common.delete'), danger: true }))) return;
          try { cache = (await api('DELETE', `/api/me/quick/${r.id}`)).replies; draw(); } catch (e) { toast(errText(e.code)); }
        } }, '✕')));
    }
  };
  draw();
}
