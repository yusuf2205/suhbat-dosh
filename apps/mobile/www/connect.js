// Local launcher page. The messenger UI itself is served by the user's own Suhbat-dosh server.
const KEY = 'suhbat.server';
const input = document.getElementById('url');
const err = document.getElementById('err');
const btn = document.querySelector('#f button');
const params = new URLSearchParams(location.search);
const DEFAULT = 'https://suhbat-dosh.uz';
const saved = localStorage.getItem(KEY);
const form = document.getElementById('f');
const retry = document.getElementById('retry');
const advanced = document.getElementById('advanced');

// The app goes straight to the messenger: no server question. The form is only shown for ?change.
async function connectNow(target) {
  err.textContent = '';
  retry.hidden = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    await fetch(`${target}/healthz`, { mode: 'no-cors', signal: ctl.signal });
    clearTimeout(timer);
    location.replace(target);
  } catch {
    clearTimeout(timer);
    document.getElementById('lead').textContent = 'Нет подключения к серверу / Server bilan aloqa yo‘q';
    retry.hidden = false;
  }
}
if (params.has('change')) {
  form.hidden = false;
  input.value = saved || DEFAULT;
} else {
  document.getElementById('lead').textContent = 'Подключение… / Ulanmoqda…';
  connectNow(saved || DEFAULT);
  retry.addEventListener('click', () => connectNow(saved || DEFAULT));
}

function normalize(v) {
  let s = v.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
  return u.origin;
}

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  try {
    const origin = normalize(input.value);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    // opaque response is enough to prove the host answers; the server speaks no CORS on purpose
    await fetch(`${origin}/healthz`, { mode: 'no-cors', signal: ctl.signal });
    clearTimeout(timer);
    localStorage.setItem(KEY, origin);
    location.replace(origin);
  } catch {
    err.textContent = 'Не удаётся подключиться / Ulanib bo‘lmadi';
    btn.disabled = false;
  }
});
