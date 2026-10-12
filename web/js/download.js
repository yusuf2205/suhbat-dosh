import { h, clear } from './dom.js';
import './ripple.js';

const T = {
  ru: {
    title: 'Скачайте Suhbat-dosh',
    lead: 'Свой мессенджер: переписка, файлы и голосовые сообщения. Данные хранятся на сервере владельца.',
    web: 'Открыть веб-версию',
    howto: 'Как установить',
    foot: 'Приложения подключаются к серверу Suhbat-dosh. Входите через Telegram.',
    download: 'Скачать',
    recommended: 'Для вашего устройства',
    soon: 'Скоро',
    size: 'Размер',
    pwa: 'Установить как приложение',
    win: 'Windows', linux: 'Linux', android: 'Android', macos: 'macOS', ios: 'iPhone / iPad',
    installer: 'Установщик', portable: 'Портативная версия (zip)', archive: 'Архив (tar.gz)', appimage: 'AppImage', deb: 'Пакет .deb', apk: 'APK-файл', dmg: 'Образ .dmg',
    none: 'Файлы ещё не загружены. Загляните позже.',
    h_win: ['Скачайте и запустите установщик.', 'Если Windows покажет предупреждение SmartScreen: «Подробнее» → «Выполнить в любом случае» (приложение пока без цифровой подписи).', 'При первом запуске введите адрес сервера (подставится автоматически).'],
    h_android: ['Скачайте APK на телефон и откройте его.', 'Разрешите установку из этого источника, когда Android попросит.', 'Если Play Protect предупредит — выберите «Всё равно установить».'],
    h_linux: ['AppImage: сделайте файл исполняемым (chmod +x) и запустите.', 'deb: sudo apt install ./Suhbat-dosh-*.deb', 'tar.gz: распакуйте и запустите suhbat-desktop.'],
    h_macos: ['Скачайте .dmg, перетащите Suhbat-dosh в «Программы».', 'Первый запуск: правый клик → «Открыть».', 'Пока нет сборки — используйте веб-версию.'],
    h_ios: ['Откройте эту страницу в Safari.', 'Нажмите «Поделиться» → «На экран “Домой”».', 'Suhbat-dosh появится как приложение и будет работать в полноэкранном режиме.'],
  },
  uz: {
    title: 'Suhbat-dosh’ni yuklab oling',
    lead: 'O‘z messenjeringiz: yozishmalar, fayllar va ovozli xabarlar. Ma’lumotlar egasining serverida saqlanadi.',
    web: 'Veb-versiyani ochish',
    howto: 'O‘rnatish',
    foot: 'Ilovalar Suhbat-dosh serveriga ulanadi. Telegram orqali kiring.',
    download: 'Yuklab olish',
    recommended: 'Qurilmangiz uchun',
    soon: 'Tez orada',
    size: 'Hajmi',
    pwa: 'Ilova sifatida o‘rnatish',
    win: 'Windows', linux: 'Linux', android: 'Android', macos: 'macOS', ios: 'iPhone / iPad',
    installer: 'O‘rnatuvchi', portable: 'Portativ versiya (zip)', archive: 'Arxiv (tar.gz)', appimage: 'AppImage', deb: '.deb paketi', apk: 'APK fayl', dmg: '.dmg obrazi',
    none: 'Fayllar hali yuklanmagan. Keyinroq qaytib keling.',
    h_win: ['O‘rnatuvchini yuklab oling va ishga tushiring.', 'SmartScreen ogohlantirsa: «Batafsil» → «Baribir bajarish» (ilova hali raqamli imzosiz).', 'Birinchi ishga tushirishda server manzilini kiriting (avtomatik to‘ldiriladi).'],
    h_android: ['APK’ni telefonga yuklab oching.', 'Android so‘raganda ushbu manbadan o‘rnatishga ruxsat bering.', 'Play Protect ogohlantirsa — «Baribir o‘rnatish».'],
    h_linux: ['AppImage: faylni bajariladigan qiling (chmod +x) va ishga tushiring.', 'deb: sudo apt install ./Suhbat-dosh-*.deb', 'tar.gz: oching va suhbat-desktop’ni ishga tushiring.'],
    h_macos: ['.dmg’ni yuklab, Suhbat-dosh’ni «Programmalar»ga o‘tkazing.', 'Birinchi ishga tushirish: o‘ng tugma → «Ochish».', 'Hozircha o‘rnatuvchi bo‘lmasa — veb-versiyadan foydalaning.'],
    h_ios: ['Sahifani Safari’da oching.', '«Ulashish» → «Bosh ekranga qo‘shish».', 'Suhbat-dosh ilova sifatida to‘liq ekranda ishlaydi.'],
  },
};

// Own icon set: static SVG strings (never user data), drawn on a 24x24 grid.
const G = {
  android: '<path d="M6 10.5a6 6 0 0 1 12 0z" fill="currentColor"/><rect x="6" y="11.5" width="12" height="7.5" rx="2" fill="currentColor"/><path d="m8.2 4.6 1.5 2.3M15.8 4.6l-1.5 2.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="9.7" cy="8.2" r=".95" class="eye"/><circle cx="14.3" cy="8.2" r=".95" class="eye"/>',
  win: '<rect x="3.5" y="3.5" width="8" height="8" rx="1.6" fill="currentColor"/><rect x="12.5" y="3.5" width="8" height="8" rx="1.6" fill="currentColor"/><rect x="3.5" y="12.5" width="8" height="8" rx="1.6" fill="currentColor"/><rect x="12.5" y="12.5" width="8" height="8" rx="1.6" fill="currentColor"/>',
  macos: '<path d="M16.5 12.7c0-2.1 1.7-3 1.8-3.1-1-1.4-2.5-1.6-3-1.7-1.3-.1-2.500.8-3.100.8-.6 0-1.600-.7-2.700-.7-1.400 0-2.700.8-3.400 2.100-1.500 2.500-.4 6.200 1 8.200.7 1 1.500 2.100 2.600 2.100 1 0 1.400-.7 2.700-.7s1.600.7 2.700.7c1.100 0 1.800-1 2.500-2 .8-1.200 1.100-2.300 1.100-2.400-.1 0-2.200-.8-2.200-3.300zM14.500 6.400c.6-.7 1-1.700.9-2.600-.9 0-1.900.6-2.500 1.300-.5.600-1 1.600-.9 2.500 1 .1 1.900-.5 2.500-1.200z" fill="currentColor"/>',
  linux: '<rect x="3" y="4.5" width="18" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m7.5 9.500 3 2.500-3 2.500M12.500 15h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  ios: '<rect x="6.5" y="2.5" width="11" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 15.500V9M9.500 11.500 12 9l2.500 2.500M10.500 18.500h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  download: '<g class="dl-arrow" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.500v10.500M7.500 9.500 12 14l4.500-4.500"/></g><path class="dl-tray" d="M4.500 15.500v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/><path class="dl-check" d="m7 12 3.500 3.500L17.500 8" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round"/>',
  web: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.500 12h17M12 3c2.700 2.600 2.700 15.400 0 18M12 3c-2.700 2.600-2.700 15.400 0 18" fill="none" stroke="currentColor" stroke-width="1.800"/>',
};
function glyph(name, size = 24) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
  s.innerHTML = G[name];
  return s;
}

const PLATFORMS = [
  { id: 'android', icon: 'android', c: ['#3ddc84', '#16a34a'] },
  { id: 'win', icon: 'win', api: 'windows', c: ['#38bdf8', '#2563eb'] },
  { id: 'macos', icon: 'macos', c: ['#94a3b8', '#334155'] },
  { id: 'linux', icon: 'linux', c: ['#fbbf24', '#ea580c'] },
  { id: 'ios', icon: 'ios', c: ['#f472b6', '#7c3aed'] },
];
const tile = (p, size = 'lg') => h('span', { class: `ptile ${size} p-${p.id}` }, glyph(p.icon, size === 'lg' ? 30 : 18));

const KIND_LABEL = (name) => {
  if (/\.exe$/i.test(name)) return 'installer';
  if (/\.zip$/i.test(name)) return 'portable';
  if (/\.AppImage$/i.test(name)) return 'appimage';
  if (/\.deb$/i.test(name)) return 'deb';
  if (/\.tar\.gz$/i.test(name)) return 'archive';
  if (/\.apk$/i.test(name)) return 'apk';
  if (/\.dmg$/i.test(name)) return 'dmg';
  return 'archive';
};

function detect() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'win';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

const fmtSize = (n) => (n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
let lang = localStorage.getItem('suhbat.dl.lang') || (navigator.language?.startsWith('uz') ? 'uz' : 'ru');
let files = [];
let installEvent = null;

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; render(); });

const t = (k) => T[lang][k] ?? T.ru[k] ?? k;
const apiId = (p) => p.api || p.id;
const rank = (n) => (/.(exe|apk|dmg|appimage)$/i.test(n) ? 0 : /.deb$/i.test(n) ? 1 : /.tar.gz$/i.test(n) ? 2 : 3);
const filesFor = (p) => files.filter((f) => f.platform === apiId(p)).sort((a, b) => rank(a.name) - rank(b.name));

function dlButton(p, f, { big = false } = {}) {
  return h('a', { class: `btn cta${big ? ' big' : ''}`, href: `/downloads/${encodeURIComponent(f.name)}`, download: f.name },
    h('span', { class: 'cta-ico', 'aria-hidden': 'true' }, glyph('download', big ? 24 : 20)),
    h('span', { class: 'cta-text' }, big ? `${t('download')} — ${t(p.id)}` : `${t(KIND_LABEL(f.name))}`),
    h('small', null, fmtSize(f.size)));
}

function render() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });

  const mine = PLATFORMS.find((p) => p.id === detect());
  const primary = clear(document.getElementById('primary'));
  if (mine) {
    const fl = filesFor(mine);
    if (fl.length) {
      primary.append(h('div', { class: 'rec-badge' }, t('recommended')), dlButton(mine, fl[0], { big: true }));
    } else if (mine.id === 'ios' || installEvent) {
      primary.append(h('div', { class: 'rec-badge' }, t('recommended')));
    }
    if (installEvent) {
      primary.append(h('button', { class: 'btn big cta', type: 'button', onclick: async () => { installEvent.prompt(); installEvent = null; render(); } },
        h('span', { class: 'cta-ico', 'aria-hidden': 'true' }, glyph('plus', 22)), h('span', { class: 'cta-text' }, t('pwa'))));
    }
  }

  const grid = clear(document.getElementById('grid'));
  PLATFORMS.forEach((p, i) => {
    const fl = filesFor(p);
    const card = h('article', { class: `card-p${mine?.id === p.id ? ' mine' : ''}`, style: { animationDelay: `${i * 70}ms` } },
      tile(p),
      h('h3', null, t(p.id)),
      ...(fl.length
        ? fl.map((f) => dlButton(p, f))
        : [h('span', { class: 'pill' }, p.id === 'ios' ? 'PWA' : t('soon'))]));
    grid.append(card);
  });
  if (!files.length) grid.append(h('p', { class: 'muted' }, t('none')));

  const how = clear(document.getElementById('howto'));
  for (const p of PLATFORMS) {
    const key = `h_${p.id}`;
    how.append(h('details', { open: mine?.id === p.id }, h('summary', null, tile(p, 'sm'), h('span', null, t(p.id))), h('ol', null, T[lang][key].map((s) => h('li', null, s)))));
  }
}

// small feedback when a download starts: arrow drops into the tray and turns into a check
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a.cta[download]');
  if (!a) return;
  a.classList.add('busy');
  setTimeout(() => a.classList.remove('busy'), 2200);
});

// reveal sections as they scroll into view
const reveal = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); reveal.unobserve(en.target); } }), { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach((el) => reveal.observe(el));

const sel = document.getElementById('lang');
sel.value = lang;
sel.addEventListener('change', () => { lang = sel.value; localStorage.setItem('suhbat.dl.lang', lang); render(); });

fetch('/api/downloads').then((r) => r.json()).then((d) => { files = d.files || []; render(); }).catch(() => render());
render();
