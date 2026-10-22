// A name and an animal avatar used in one group instead of the real name (set per group, see personal.js on the server).
import { h } from './dom.js';
import { t, getLang } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { ANIMALS, animalById, animalName } from '../../shared/animals.js';
import { avatar, modal, toast } from './ui.js';
import { errText } from './i18n.js';

/** { n: name, a: animal id, real? } of a person in this chat, or null. */
export const aliasOf = (chat, userId) => (chat && chat.type === 'group' ? chat.aliases?.[userId] || null : null);

/** The name to show for somebody in a chat: the animal name if they use one. */
export function shownName(chat, userId, real) {
  const a = aliasOf(chat, userId);
  return a ? a.n : real;
}

/** An entity for avatar(): the animal if there is one, else the person. */
export function shownEntity(chat, user) {
  const a = aliasOf(chat, user?.id);
  return a ? { id: user.id, name: a.n, animal: a.a } : user;
}

/** Part of a signature for cached message nodes: changes when somebody changes their alias. */
export const aliasSig = (chat, userId) => { const a = aliasOf(chat, userId); return a ? `${a.a}|${a.n}|${a.real || ''}` : ''; };

/** The animal inside a round avatar (drawn with CSS gradients: no pictures to load). */
export function animalAvatar(animalId, size = '') {
  const a = animalById(animalId);
  const el = h('span', { class: `avatar animal ${size}`, 'aria-hidden': 'true' }, a ? a.emoji : '?');
  if (a) el.style.background = `linear-gradient(145deg, ${a.color[0]}, ${a.color[1]})`;
  return el;
}

/** "My profile in this group": pick an animal and a name. */
export function openAliasDialog(chat) {
  const cur = aliasOf(chat, S.me.id);
  let animal = cur?.a || ANIMALS[Math.floor(Math.random() * ANIMALS.length)].id;
  const lang = getLang() === 'uz' ? 'uz' : 'ru';
  const name = h('input', { class: 'input', maxLength: 40, value: cur?.n || animalName(animal, lang) });
  let nameTouched = !!cur;
  name.addEventListener('input', () => { nameTouched = true; });
  const preview = h('div', { class: 'alias-preview' });
  const grid = h('div', { class: 'alias-grid', role: 'listbox' });
  const paint = () => {
    preview.replaceChildren(animalAvatar(animal, 'xl'), h('b', null, name.value || '—'));
    grid.replaceChildren(...ANIMALS.map((a) => h('button', {
      class: `alias-pick${a.id === animal ? ' on' : ''}`, type: 'button', role: 'option', 'aria-selected': String(a.id === animal), title: lang === 'uz' ? a.uz : a.ru,
      onclick: () => { animal = a.id; if (!nameTouched || ANIMALS.some((x) => animalName(x.id, lang, 0) === name.value)) name.value = animalName(animal, lang); paint(); },
    }, animalAvatar(a.id, 'md'))));
  };
  name.addEventListener('input', paint);
  paint();
  const m = modal({
    title: t('al.title'),
    body: [
      h('p', { class: 'muted' }, t('al.intro')),
      preview, grid,
      h('div', { class: 'row', style: { gap: '8px', margin: '8px 0' } }, name,
        h('button', { class: 'btn secondary', type: 'button', onclick: () => { const a = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]; animal = a.id; name.value = animalName(a.id, lang); nameTouched = false; paint(); } }, t('al.random'))),
      h('p', { class: 'muted small' }, t('al.note')),
      h('div', { class: 'row', style: { gap: '8px' } },
        cur ? h('button', { class: 'btn secondary', type: 'button', style: { flex: 1 }, onclick: () => save('') }, t('al.off')) : null,
        h('button', { class: 'btn', type: 'button', style: { flex: 1 }, onclick: () => save(animal) }, t('settings.save'))),
    ],
  });
  async function save(a) {
    try {
      const r = await api('PUT', `/api/chats/${chat.id}/alias`, { animal: a, name: name.value.trim() });
      S.chats.set(r.chat.id, r.chat);
      import('./state.js').then((s) => s.fire('chats'));
      toast(a ? t('al.saved') : t('al.removed'));
      m.close();
    } catch (e) { toast(errText(e.code)); }
  }
  return m;
}
void avatar;
