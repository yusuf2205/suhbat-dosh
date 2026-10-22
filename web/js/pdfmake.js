// A minimal PDF writer: every page is one JPEG picture. Enough for scans, and it needs no library.

const enc = new TextEncoder();

/**
 * jpegs: Uint8Array[] (JPEG files); sizes: [[width, height], ...] in pixels. Pages are A4-wide, as high as the picture needs.
 * Returns a Uint8Array with the PDF.
 */
export function jpegPdf(jpegs, sizes) {
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (data) => { const b = typeof data === 'string' ? enc.encode(data) : data; parts.push(b); pos += b.length; };
  const obj = (n, body) => { offsets[n] = pos; push(`${n} 0 obj\n`); if (typeof body === 'string') push(`${body}\nendobj\n`); else { body(); push('\nendobj\n'); } };

  const n = jpegs.length;
  // objects: 1 catalog, 2 pages, then for each page: page, content, image
  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  jpegs.forEach((jpg, i) => {
    const [w, h] = sizes[i];
    const pw = 595;
    const ph = Math.round((pw * h) / w);
    const page = 3 + i * 3;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(page + 1, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    obj(page + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
      push(jpg);
      push('\nendstream');
    });
  });
  const count = 3 + n * 3;
  const xref = pos;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i += 1) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
