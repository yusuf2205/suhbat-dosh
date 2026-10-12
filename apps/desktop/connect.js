const q = new URLSearchParams(location.search);
const input = document.getElementById('url');
const err = document.getElementById('err');
const btn = document.querySelector('button');
input.value = q.get('def') || '';
if (q.get('error')) err.textContent = q.get('error');

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  try {
    await window.suhbatShell.setServer(input.value);
  } catch (ex) {
    err.textContent = `Не удаётся подключиться / Ulanib bo‘lmadi: ${String(ex.message || ex).replace(/^Error invoking remote method '[^']+': /, '')}`;
    btn.disabled = false;
  }
});
