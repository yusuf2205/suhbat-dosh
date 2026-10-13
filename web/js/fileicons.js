// File-type icons: a page with a folded corner, a colour per kind and the extension on it (like the common icon sets).
const NS = 'http://www.w3.org/2000/svg';

const KINDS = [
  { re: /\.(pdf)$/i, color: '#e5484d', label: 'PDF' },
  { re: /\.(docx?|odt|rtf)$/i, color: '#2b6cde', label: 'DOC' },
  { re: /\.(xlsx?|ods|csv)$/i, color: '#1f9d55', label: 'XLS' },
  { re: /\.(pptx?|odp)$/i, color: '#e8590c', label: 'PPT' },
  { re: /\.(zip|rar|7z|tar|gz|tgz)$/i, color: '#b7791f', label: 'ZIP' },
  { re: /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i, color: '#7c3aed', label: 'MP3' },
  { re: /\.(mp4|mov|avi|mkv|webm|m4v)$/i, color: '#db2777', label: 'MP4' },
  { re: /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i, color: '#0d9488', label: 'IMG' },
  { re: /\.(txt|md|log|json|xml|html?)$/i, color: '#64748b', label: 'TXT' },
  { re: /\.(apk)$/i, color: '#3ddc84', label: 'APK' },
  { re: /\.(exe|msi)$/i, color: '#475569', label: 'EXE' },
];

export function fileKind(name = '', mime = '') {
  const hit = KINDS.find((k) => k.re.test(name));
  if (hit) return hit;
  if (/^image\//.test(mime)) return KINDS.find((k) => k.label === 'IMG');
  if (/^video\//.test(mime)) return KINDS.find((k) => k.label === 'MP4');
  if (/^audio\//.test(mime)) return KINDS.find((k) => k.label === 'MP3');
  if (mime === 'application/pdf') return KINDS[0];
  const ext = (name.split('.').pop() || '').slice(0, 4).toUpperCase();
  return { color: '#475569', label: ext && ext !== name.toUpperCase() ? ext : 'FILE' };
}

/** An SVG icon `size` px wide for a file. */
export function fileIcon(name, mime, size = 42) {
  const k = fileKind(name, mime);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 56');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(Math.round(size * 56 / 48)));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'file-icon');
  const el = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, v);
    return n;
  };
  svg.append(
    el('path', { d: 'M6 4a4 4 0 0 1 4-4h20l12 12v40a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z', fill: k.color }),
    el('path', { d: 'M30 0l12 12H34a4 4 0 0 1-4-4z', fill: '#000', opacity: '.22' }),
    el('rect', { x: '6', y: '30', width: '36', height: '16', rx: '3', fill: '#fff', opacity: '.95' }),
  );
  const text = el('text', { x: '24', y: '42', 'text-anchor': 'middle', 'font-family': 'system-ui, Arial, sans-serif', 'font-weight': '700', 'font-size': k.label.length > 3 ? '10' : '12', fill: k.color });
  text.textContent = k.label;
  svg.append(text);
  return svg;
}
