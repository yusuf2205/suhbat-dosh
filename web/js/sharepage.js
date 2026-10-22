// Public page of a share link: shows the file, asks for the password when there is one, then downloads.
import { h, clear, formatBytes } from './dom.js';
import { fileIcon } from './fileicons.js';

const T = {
  ru: {
    from: 'Вам отправил файл', password: 'Пароль', open: 'Скачать', wrong: 'Неверный пароль', gone: 'Ссылка не действует: срок истёк, лимит скачиваний исчерпан или доступ закрыт.',
    until: 'Действует до', starting: 'Загрузка началась', again: 'Это одноразовая ссылка: повторно скачать не получится.', busy: 'Слишком много попыток. Подождите несколько минут.', err: 'Не удалось. Попробуйте ещё раз.',
  },
  uz: {
    from: 'Sizga fayl yuborildi', password: 'Parol', open: 'Yuklab olish', wrong: 'Parol noto‘g‘ri', gone: 'Havola amal qilmaydi: muddati tugagan, yuklab olish limiti tugagan yoki kirish yopilgan.',
    until: 'Amal qilish muddati', starting: 'Yuklab olish boshlandi', again: 'Bu bir martalik havola: qayta yuklab bo‘lmaydi.', busy: 'Juda ko‘p urinish. Bir necha daqiqa kuting.', err: 'Bajarilmadi. Qayta urinib ko‘ring.',
  },
};
const lang = (localStorage.getItem('suhbat.dl.lang') || (navigator.language?.startsWith('uz') ? 'uz' : 'ru'));
const t = (k) => T[lang]?.[k] ?? T.ru[k];
const token = location.pathname.split('/').filter(Boolean)[1] || '';
const card = document.getElementById('card');

async function main() {
  let meta;
  try {
    const r = await fetch(`/api/s/${encodeURIComponent(token)}/meta`);
    if (!r.ok) throw new Error(String(r.status));
    meta = await r.json();
  } catch {
    clear(card).append(h('div', { class: 'share-gone' }, h('h2', null, '\u{1F6AB}'), h('p', null, t('gone'))));
    return;
  }
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: t('password'), 'aria-label': t('password') });
  const msg = h('p', { class: 'share-msg', role: 'alert' });
  const btn = h('button', { class: 'btn big', type: 'button' }, t('open'));
  const go = async () => {
    btn.disabled = true;
    msg.textContent = '';
    try {
      const r = await fetch(`/api/s/${encodeURIComponent(token)}/unlock`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw.value }),
      });
      if (r.status === 403) { msg.textContent = t('wrong'); btn.disabled = false; return; }
      if (r.status === 429) { msg.textContent = t('busy'); btn.disabled = false; return; }
      if (!r.ok) { msg.textContent = t('gone'); return; }
      const { url } = await r.json();
      msg.textContent = t('starting');
      const a = h('a', { href: url, download: meta.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => { btn.disabled = false; }, 4000);
    } catch { msg.textContent = t('err'); btn.disabled = false; }
  };
  btn.onclick = go;
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  clear(card).append(
    h('div', { class: 'share-file' }, fileIcon(meta.name, meta.mime, 72), h('h1', null, meta.name),
      h('p', { class: 'muted' }, `${formatBytes(meta.size)}${meta.from ? ` · ${t('from')}: ${meta.from}` : ''}`),
      meta.expires_at ? h('p', { class: 'muted' }, `${t('until')}: ${new Date(meta.expires_at).toLocaleString(lang === 'uz' ? 'uz-UZ' : 'ru-RU')}`) : null),
    meta.needs_password ? pw : null, btn, msg);
  if (meta.needs_password) pw.focus();
}
main();
