// PDF inside the app (pdf.js): pages are drawn to canvases as they scroll into view; works in every browser and the apps.
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
  const status = h('div', { class: 'pdf-status muted' }, t('doc.loading'));
  const pages = h('div', { class: 'pdf-pages' });
  const root = h('div', { class: 'pdf-view' }, status, pages);
  const off = onDownload((x) => {
    if (x.id !== file.id || x.state === 'done') return;
    status.textContent = `${t('doc.loading')} ${formatBytes(x.loaded)} / ${formatBytes(x.total)}`;
  });
  (async () => {
    try {
      const [pdfjs, blob] = await Promise.all([lib(), fileBlob(file, 2)]);
      off();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
      status.textContent = '';
      status.hidden = true;
      const width = Math.min(900, Math.max(280, root.clientWidth || 640));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const slot = e.target;
          io.unobserve(slot);
          draw(slot, Number(slot.dataset.n));
        }
      }, { root: null, rootMargin: '600px 0px' });
      async function draw(slot, n) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (width / base.width) * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
        canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        slot.replaceChildren(canvas);
      }
      const first = await doc.getPage(1); // page 1 sets the size of the placeholders until each page is drawn
      const vp = first.getViewport({ scale: width / first.getViewport({ scale: 1 }).width });
      for (let n = 1; n <= doc.numPages; n += 1) {
        const slot = h('div', { class: 'pdf-page', dataset: { n: String(n) } });
        slot.style.width = `${Math.floor(vp.width)}px`;
        slot.style.minHeight = `${Math.floor(vp.height)}px`;
        pages.append(slot);
        io.observe(slot);
      }
      root.append(h('div', { class: 'pdf-count muted' }, `${doc.numPages} ${t('pdf.pages')}`));
    } catch (e) {
      off();
      if (fallback) root.replaceChildren(fallback(e));
      else status.textContent = t('doc.failed');
    }
  })();
  return root;
}
