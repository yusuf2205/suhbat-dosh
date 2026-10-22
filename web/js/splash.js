// Removes the launch animation once it has played and the app has drawn something.
(function () {
  var el = document.getElementById('splash');
  if (!el) return;
  var started = Date.now();
  var MIN = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 3000;
  var done = false;
  function hide() {
    if (done) return; done = true;
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 600);
  }
  function check() {
    var root = document.getElementById('root');
    var ready = root && root.childElementCount > 0;
    if (ready && Date.now() - started >= MIN) hide();
    else if (Date.now() - started > 9000) hide();
    else setTimeout(check, 80);
  }
  check();
})();
