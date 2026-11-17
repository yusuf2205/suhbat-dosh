// The administrator page is a set of modules; if one of them does not arrive (a hiccup in the connection) the page stays white.
// If a file of ours fails, this script reloads once by itself; if the page is still empty after a while it says so and offers a button.
// Only files of this site count: Cloudflare adds a script of its own that the page policy blocks, and that is not a failure of the page.
(function () {
  var root = function () { return document.getElementById('admin-root'); };
  var shown = false;
  function ours(t) {
    try { return new URL(t.src || t.href, location.href).origin === location.origin; } catch (e) { return false; }
  }
  function say() {
    var r = root();
    if (shown || !r || r.childNodes.length) return;
    shown = true;
    r.innerHTML = '<div style="max-width:360px;margin:20vh auto;padding:0 16px;text-align:center;font:16px system-ui,sans-serif">' +
      '<p>Страница администратора не загрузилась.<br>Проверьте соединение и попробуйте ещё раз.</p>' +
      '<button id="admin-retry" style="padding:10px 22px;font:inherit;border:0;border-radius:10px;background:#ffd400;cursor:pointer">Обновить</button></div>';
    document.getElementById('admin-retry').onclick = function () { try { sessionStorage.removeItem('admin-reloaded'); } catch (e) { /* no storage */ } location.reload(); };
  }
  function failed() {
    var again = false;
    try { again = sessionStorage.getItem('admin-reloaded') !== '1'; sessionStorage.setItem('admin-reloaded', '1'); } catch (e) { /* no storage: never reload by itself */ }
    if (again) location.reload(); else say();
  }
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK') && ours(t)) failed();
  }, true);
  window.addEventListener('load', function () {
    // the reload counts as used until the page has really drawn something
    setTimeout(function () {
      var r = root();
      if (r && r.childNodes.length) { try { sessionStorage.removeItem('admin-reloaded'); } catch (e) { /* no storage */ } } else say();
    }, 12000);
  });
})();
