// Appearance of one chat: a background of two colours with an optional pattern, and the colour of your own bubbles.
// Personal by default; in a one-to-one chat (or as an administrator of a group) it can be set for everybody.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';

export const PRESETS = {
  sunrise: { c1: '#fff3c4', c2: '#ffd1a8', accent: '#ff8a00' },
  ocean: { c1: '#d6f1ff', c2: '#b9d8ff', accent: '#1d6fd8' },
  forest: { c1: '#e1f5e1', c2: '#c9e8d2', accent: '#2f8f4e' },
  lavender: { c1: '#efe6ff', c2: '#dfd0ff', accent: '#7a4fd6' },
  rose: { c1: '#ffe3ea', c2: '#ffd0dc', accent: '#d6336c' },
  mint: { c1: '#d9fff3', c2: '#c8f0ff', accent: '#00a389' },
  paper: { c1: '#f6f1e7', c2: '#efe6d4', accent: '#a8742a' },
  candy: { c1: '#ffeaa7', c2: '#fab1a0', accent: '#e17055' },
  graphite: { c1: '#1b1d22', c2: '#2a2d35', accent: '#ffd23f' },
  night: { c1: '#0f1730', c2: '#1c2850', accent: '#5aa9ff' },
};

const luma = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
const PATTERNS = [
  null,
  'radial-gradient(rgba(255,255,255,.35) 1.5px, transparent 1.6px)',
  'linear-gradient(rgba(255,255,255,.22) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.22) 1px, transparent 1px)',
  'repeating-linear-gradient(45deg, rgba(255,255,255,.18) 0 6px, transparent 6px 16px)',
  'radial-gradient(circle at 20% 30%, rgba(255,255,255,.28) 0 28px, transparent 29px), radial-gradient(circle at 75% 65%, rgba(255,255,255,.2) 0 40px, transparent 41px)',
];
const SIZES = [null, '18px 18px', '28px 28px', null, null];

export function resolveTheme(theme) {
  if (!theme) return null;
  const base = theme.preset && PRESETS[theme.preset] ? PRESETS[theme.preset] : {};
  const c1 = theme.c1 || base.c1;
  const c2 = theme.c2 || base.c2 || c1;
  const accent = theme.accent || base.accent;
  if (!c1) return null;
  return { c1, c2, accent, pattern: theme.pattern ?? 0 };
}

/** Paint the message area of the open chat. */
export function applyChatTheme(el, theme) {
  if (!el) return;
  const r = resolveTheme(theme);
  const s = el.style;
  if (!r) {
    s.background = '';
    s.backgroundSize = '';
    s.removeProperty('--bubble-out');
    s.removeProperty('--bubble-out-ink');
    el.removeAttribute('data-themed');
    return;
  }
  const layers = [PATTERNS[r.pattern], `linear-gradient(160deg, ${r.c1}, ${r.c2})`].filter(Boolean);
  s.background = layers.join(', ');
  s.backgroundSize = SIZES[r.pattern] ? `${SIZES[r.pattern]}, auto` : 'auto';
  el.setAttribute('data-themed', luma(r.c1) < 0.4 ? 'dark' : 'light');
  if (r.accent) {
    s.setProperty('--bubble-out', r.accent);
    s.setProperty('--bubble-out-ink', luma(r.accent) > 0.6 ? '#1b1b1d' : '#ffffff');
  }
}

export function openChatTheme(chat) {
  let sel = chat.theme ? { ...chat.theme } : null;
  const shareable = chat.type === 'direct' || chat.my_role === 'owner' || chat.my_role === 'admin';
  const shared = h('input', { type: 'checkbox', checked: !!chat.theme_shared });
  const grid = h('div', { class: 'theme-grid' });
  const custom = {
    c1: h('input', { type: 'color', value: resolveTheme(sel)?.c1 || '#fff3c4', 'aria-label': t('theme.c1') }),
    c2: h('input', { type: 'color', value: resolveTheme(sel)?.c2 || '#ffd1a8', 'aria-label': t('theme.c2') }),
    accent: h('input', { type: 'color', value: resolveTheme(sel)?.accent || '#ff8a00', 'aria-label': t('theme.accent') }),
  };
  const pattern = h('select', { class: 'input', 'aria-label': t('theme.pattern') }, [0, 1, 2, 3, 4].map((i) => h('option', { value: i, selected: (sel?.pattern ?? 0) === i }, t(`theme.p${i}`))));
  const preview = h('div', { class: 'theme-preview' },
    h('div', { class: 'theme-bubble in' }, t('theme.sample_in')), h('div', { class: 'theme-bubble out' }, t('theme.sample_out')));
  const paint = () => { applyChatTheme(preview, sel); };
  const draw = () => {
    grid.replaceChildren(...Object.entries(PRESETS).map(([id, p]) => {
      const b = h('button', { class: `theme-swatch${sel?.preset === id ? ' on' : ''}`, type: 'button', 'aria-label': id, onclick: () => { sel = { preset: id, pattern: Number(pattern.value) }; draw(); paint(); } });
      b.style.background = `linear-gradient(160deg, ${p.c1}, ${p.c2})`;
      b.style.borderColor = sel?.preset === id ? p.accent : 'transparent';
      return b;
    }));
  };
  for (const k of ['c1', 'c2', 'accent']) custom[k].addEventListener('input', () => { sel = { c1: custom.c1.value, c2: custom.c2.value, accent: custom.accent.value, pattern: Number(pattern.value) }; draw(); paint(); });
  pattern.addEventListener('change', () => { if (sel) { sel.pattern = Number(pattern.value); paint(); } });
  const save = async (theme) => {
    try {
      const r = await api('POST', `/api/chats/${chat.id}/theme`, { theme, shared: shareable && shared.checked });
      S.chats.set(r.chat.id, r.chat);
      fire('chats');
      fire('chat-theme', r.chat.id);
      win.close();
    } catch (e) { toast(errText(e.code)); }
  };
  const win = modal({
    title: t('theme.title'),
    body: [preview, grid, h('div', { class: 'theme-custom' }, h('label', null, t('theme.c1'), custom.c1), h('label', null, t('theme.c2'), custom.c2), h('label', null, t('theme.accent'), custom.accent)),
      h('label', { class: 'field' }, h('span', null, t('theme.pattern')), pattern),
      shareable ? h('label', { class: 'focus-row' }, h('span', null, h('b', null, t('theme.shared')), h('small', { class: 'muted' }, t('theme.shared_hint'))), shared) : null,
      h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => save(null) }, t('theme.reset')),
        h('button', { class: 'btn', type: 'button', onclick: () => save(sel) }, t('quick.save')))].filter(Boolean),
  });
  draw();
  paint();
}
