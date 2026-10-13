// PDF inside the app (pdf.js): pages are drawn to canvases as they scroll into view; works in every browser and the apps.
// Readable on any screen: pages fit the width, zoom in / out, current page counter.
import { h, formatBytes } from './dom.js';
import { t } from './i18n.js';
import { fileBlob, onDownload } from './downloads.js';

let libP = null;
function lib() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  libP ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/pdf.js';
    s.async = true;
    s.onload = () => {
      if (!window.pdfjsLib) return reject(new Error('pdfjs'));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('pdfjs'));
    document.head.appendChild(s);
  });
  return libP;
}

/** A scrollable PDF reader for `file` ({id,url,name,size}). `fallback` builds the node shown if the PDF cannot be read. */
export function pdfNode(file, { fallback } = {}) {
  const status = h('div', { class: 'pdf-status' }, t('doc.loading'));
  const pages = h('div', { class: 'pdf-pages' });
  const counter = h('span', { class: 'pdf-counter' }, '');
  const zoomLabel = h('span', { class: 'pdf-zoom' }, '100%');
  const bar = h('div', { class: 'pdf-bar', hidden: true });
  const scroller = h('div', { class: 'pdf-scroll' }, status, pages);
  const root = h('div', { class: 'pdf-view' }, bar, scroller);
  const off = onDownload((x) => {
    if (x.id !== file.id || x.state === 'done') return;
    status.textContent = `${t('doc.loading')} ${formatBytes(x.loaded)} / ${formatBytes(x.total)}`;
  });

  (async () => {
    try {
      const [pdfjs, blob] = await Promise.all([lib(), fileBlob(file, 2)]);
      off();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
      status.hidden = true;
      const first = await doc.getPage(1);
      const base = first.getViewport({ scale: 1 });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let zoom = 1;
      let io = null;

      async function draw(slot, n, width) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
        canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        slot.replaceChildren(canvas);
      }

      function layout() {
        io?.disconnect();
        const avail = Math.max(260, (scroller.clientWidth || 640) - 24);
        const width = Math.round(Math.min(1400, avail * zoom));
        const height = Math.round(width * (base.height / base.width));
        pages.replaceChildren();
        io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            draw(e.target, Number(e.target.dataset.n), width).catch(() => {});
          }
        }, { root: scroller, rootMargin: '800px 0px' });
        for (let n = 1; n <= doc.numPages; n += 1) {
          const slot = h('div', { class: 'pdf-page', dataset: { n: String(n) } });
          slot.style.width = `${width}px`;
          slot.style.minHeight = `${height}px`;
          pages.append(slot);
          io.observe(slot);
        }
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      }

      const btn = (label, aria, fn) => h('button', { class: 'icon-btn pdf-btn', type: 'button', 'aria-label': aria, onclick: fn }, label);
      bar.append(
        btn('−', t('viewer.zoom_out'), () => { zoom = Math.max(0.5, +(zoom - 0.25).toFixed(2)); layout(); }),
        zoomLabel,
        btn('+', t('viewer.zoom_in'), () => { zoom = Math.min(3, +(zoom + 0.25).toFixed(2)); layout(); }),
        btn('⤢', t('viewer.fit'), () => { zoom = 1; layout(); }),
        counter);
      bar.hidden = false;
      layout();

      // which page is on screen
      scroller.addEventListener('scroll', () => {
        const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
        for (const slot of pages.children) {
          const r = slot.getBoundingClientRect();
          if (r.top <= mid && r.bottom >= mid) { counter.textContent = `${slot.dataset.n} / ${doc.numPages}`; break; }
        }
      }, { passive: true });
      counter.textContent = `1 / ${doc.numPages}`;
      let rt = 0;
      window.addEventListener('resize', () => {
        if (!root.isConnected) return;
        clearTimeout(rt);
        rt = setTimeout(layout, 250);
      });
    } catch (e) {
      off();
      if (fallback) root.replaceChildren(fallback(e));
      else status.textContent = t('doc.failed');
    }
  })();
  return root;
}
