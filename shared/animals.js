// Animal personas for a group: a friendly avatar and a made-up name, so somebody can take part without showing who they are.
// Used by the server (to check the choice) and by the web client (to draw it).
export const ANIMALS = [
  { id: 'goose', emoji: '\u{1FABF}', color: ['#fbc700', '#ff9f1c'], g: 'm', ru: 'Гусь', uz: 'G‘oz' },
  { id: 'raccoon', emoji: '\u{1F99D}', color: ['#94a3b8', '#475569'], g: 'm', ru: 'Енот', uz: 'Yenot' },
  { id: 'crocodile', emoji: '\u{1F40A}', color: ['#4ade80', '#15803d'], g: 'm', ru: 'Крокодил', uz: 'Timsoh' },
  { id: 'panda', emoji: '\u{1F43C}', color: ['#e2e8f0', '#94a3b8'], g: 'f', ru: 'Панда', uz: 'Panda' },
  { id: 'fox', emoji: '\u{1F98A}', color: ['#fb923c', '#ea580c'], g: 'f', ru: 'Лиса', uz: 'Tulki' },
  { id: 'hedgehog', emoji: '\u{1F994}', color: ['#a8a29e', '#78716c'], g: 'm', ru: 'Ёж', uz: 'Tipratikan' },
  { id: 'owl', emoji: '\u{1F989}', color: ['#c4a484', '#8b5e3c'], g: 'f', ru: 'Сова', uz: 'Boyqush' },
  { id: 'penguin', emoji: '\u{1F427}', color: ['#60a5fa', '#1d4ed8'], g: 'm', ru: 'Пингвин', uz: 'Pingvin' },
  { id: 'octopus', emoji: '\u{1F419}', color: ['#f472b6', '#be185d'], g: 'm', ru: 'Осьминог', uz: 'Sakkizoyoq' },
  { id: 'giraffe', emoji: '\u{1F992}', color: ['#fde047', '#ca8a04'], g: 'm', ru: 'Жираф', uz: 'Jirafa' },
  { id: 'beaver', emoji: '\u{1F9AB}', color: ['#b45309', '#78350f'], g: 'm', ru: 'Бобр', uz: 'Qunduz' },
  { id: 'sloth', emoji: '\u{1F9A5}', color: ['#d6d3d1', '#78716c'], g: 'm', ru: 'Ленивец', uz: 'Dangasa' },
  { id: 'llama', emoji: '\u{1F999}', color: ['#fcd34d', '#d97706'], g: 'f', ru: 'Лама', uz: 'Lama' },
  { id: 'chameleon', emoji: '\u{1F98E}', color: ['#34d399', '#047857'], g: 'm', ru: 'Хамелеон', uz: 'Xameleon' },
  { id: 'flamingo', emoji: '\u{1F9A9}', color: ['#fb7185', '#e11d48'], g: 'n', ru: 'Фламинго', uz: 'Flamingo' },
  { id: 'seal', emoji: '\u{1F9AD}', color: ['#7dd3fc', '#0369a1'], g: 'm', ru: 'Тюлень', uz: 'Tyulen' },
  { id: 'rabbit', emoji: '\u{1F430}', color: ['#fbcfe8', '#db2777'], g: 'm', ru: 'Кролик', uz: 'Quyon' },
  { id: 'bear', emoji: '\u{1F43B}', color: ['#a16207', '#713f12'], g: 'm', ru: 'Медведь', uz: 'Ayiq' },
  { id: 'tiger', emoji: '\u{1F42F}', color: ['#fdba74', '#c2410c'], g: 'm', ru: 'Тигр', uz: 'Yo‘lbars' },
  { id: 'wolf', emoji: '\u{1F43A}', color: ['#cbd5e1', '#334155'], g: 'm', ru: 'Волк', uz: 'Bo‘ri' },
  { id: 'dolphin', emoji: '\u{1F42C}', color: ['#38bdf8', '#0e7490'], g: 'm', ru: 'Дельфин', uz: 'Delfin' },
  { id: 'parrot', emoji: '\u{1F99C}', color: ['#86efac', '#dc2626'], g: 'm', ru: 'Попугай', uz: 'To‘ti' },
  { id: 'turtle', emoji: '\u{1F422}', color: ['#86efac', '#166534'], g: 'f', ru: 'Черепаха', uz: 'Toshbaqa' },
  { id: 'koala', emoji: '\u{1F428}', color: ['#cbd5e1', '#64748b'], g: 'f', ru: 'Коала', uz: 'Koala' },
];

export const ANIMAL_IDS = new Set(ANIMALS.map((a) => a.id));
export const animalById = (id) => ANIMALS.find((a) => a.id === id) || null;

const ADJ_RU = [
  { m: 'Неопознанный', f: 'Неопознанная', n: 'Неопознанное' },
  { m: 'Загадочный', f: 'Загадочная', n: 'Загадочное' },
  { m: 'Весёлый', f: 'Весёлая', n: 'Весёлое' },
  { m: 'Сонный', f: 'Сонная', n: 'Сонное' },
  { m: 'Хитрый', f: 'Хитрая', n: 'Хитрое' },
  { m: 'Секретный', f: 'Секретная', n: 'Секретное' },
  { m: 'Важный', f: 'Важная', n: 'Важное' },
  { m: 'Лихой', f: 'Лихая', n: 'Лихое' },
];
const ADJ_UZ = ['Noma’lum', 'Sirli', 'Quvnoq', 'Uyqusirovchi', 'Ayyor', 'Maxfiy', 'Muhim', 'Jasur'];

/** "Неопознанный Гусь" / "Noma’lum G‘oz". pick: a number 0..1 (random by default). */
export function animalName(id, lang = 'ru', pick = Math.random()) {
  const a = animalById(id);
  if (!a) return '';
  if (lang === 'uz') return `${ADJ_UZ[Math.floor(pick * ADJ_UZ.length) % ADJ_UZ.length]} ${a.uz}`;
  return `${ADJ_RU[Math.floor(pick * ADJ_RU.length) % ADJ_RU.length][a.g]} ${a.ru}`;
}
