// The administrator page is a set of modules; if one of them does not arrive (a hiccup in the connection) the page stays white.
// This small script reloads once by itself, and if the page is still empty after a while it says so and offers a button.
(function () {
  var root = function () { return document.getElementById('admin-root'); };
  var shown = false;
  function say() {
    var r = root();
    if (shown || !r || r.childNodes.length) return;
    shown = true;
    r.innerHTML = '<div style="max-width:360px;margin:20vh auto;padding:0 16px;text-align:center;font:16px system-ui,sans-serif">' +
      '<p>Страница администратора не загрузилась.<br>Проверьте соединение и попробуйте ещё раз.</p>' +
      '<button id="admin-retry" style="padding:10px 22px;font:inherit;border:0;border-radius:10px;background:#ffd400;cursor:pointer">Обновить</button></div>';
    document.getElementById('admin-retry').onclick = function () { location.reload(); };
  }
  function failed() {
    var again = false;
    try { again = sessionStorage.getItem('admin-reloaded') !== '1'; sessionStorage.setItem('admin-reloaded', '1'); } catch (e) { /* no storage */ }
    if (again) location.reload(); else say();
  }
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) failed();
  }, true);
  window.addEventListener('load', function () {
    try { sessionStorage.removeItem('admin-reloaded'); } catch (e) { /* no storage */ }
    setTimeout(say, 12000);
  });
})();
