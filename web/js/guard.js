// Classic (non-module) script: if the messenger does not start, show why instead of an empty page.
(function () {
  var errors = [];
  function note(m) { if (errors.length < 6) errors.push(String(m).slice(0, 260)); }
  window.addEventListener('error', function (e) {
    note((e.message || 'error') + (e.filename ? ' @' + String(e.filename).split('/').pop() + ':' + (e.lineno || 0) : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    note('promise: ' + ((r && r.message) || r));
  });
  function el(tag, text, css) {
    var n = document.createElement(tag);
    if (text) n.textContent = text;
    if (css) for (var k in css) n.style[k] = css[k];
    return n;
  }
  function reset() {
    var jobs = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
      }
      if (window.caches && caches.keys) {
        jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
      }
    } catch (e) { /* ignore */ }
    Promise.all(jobs).then(go, go);
    function go() { location.replace('/?r=' + Date.now()); }
  }
  function show() {
    var root = document.getElementById('root');
    if (document.getElementById('guard-panel')) return;
    if (root && root.children.length) return;
    var box = el('div', null, { position: 'fixed', left: '0', top: '0', right: '0', bottom: '0', background: '#fff8dc', color: '#222', font: '16px/1.4 -apple-system, Roboto, sans-serif', padding: '24px', overflow: 'auto', zIndex: '99999' });
    box.id = 'guard-panel';
    box.appendChild(el('h2', 'Не удалось загрузить Suhbat-dosh', { margin: '0 0 8px' }));
    box.appendChild(el('p', 'Suhbat-dosh yuklanmadi. Попробуйте обновить страницу.', { margin: '0 0 16px' }));
    var b1 = el('button', 'Обновить / Yangilash', { padding: '12px 18px', margin: '0 8px 8px 0', border: '0', borderRadius: '12px', background: '#fbc700', fontSize: '16px', fontWeight: '600' });
    b1.onclick = function () { location.reload(); };
    var b2 = el('button', 'Очистить кэш и обновить', { padding: '12px 18px', margin: '0 8px 8px 0', border: '0', borderRadius: '12px', background: '#eee', fontSize: '16px' });
    b2.onclick = reset;
    box.appendChild(b1);
    box.appendChild(b2);
    var info = (errors.length ? errors.join('\n') : 'нет ошибок скрипта (страница не отвечает)') + '\n\n' + navigator.userAgent;
    box.appendChild(el('pre', info, { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', color: '#555', marginTop: '16px' }));
    document.body.appendChild(box);
    var iv = setInterval(function () {
      if (root && root.children.length) { box.remove(); clearInterval(iv); }
    }, 1000);
  }
  setTimeout(show, 6000);
  setTimeout(show, 15000);
})();
