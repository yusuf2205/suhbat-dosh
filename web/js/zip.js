// A small ZIP writer and reader for backups: entries are stored without compression (media is compressed already), written as
// a stream so a long archive never has to sit in memory. Archives above 4 GB (ZIP64) are not supported.
const te = new TextEncoder();

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i += 1) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

export const MAX_ZIP = 3.8 * 1024 ** 3;

/** sink: { write(Uint8Array) } - a FileSystemWritableFileStream or the object returned by blobSink(). */
export class ZipWriter {
  constructor(sink) { this.sink = sink; this.pos = 0; this.entries = []; }

  async put(chunk) { await this.sink.write(chunk); this.pos += chunk.length; }

  /** data: Uint8Array | string | Blob. */
  async add(name, data, date = new Date()) {
    const nameBytes = te.encode(name);
    const offset = this.pos;
    const hdr = new DataView(new ArrayBuffer(30));
    hdr.setUint32(0, 0x04034b50, true);
    hdr.setUint16(4, 20, true);
    hdr.setUint16(6, 0x0808, true); // UTF-8 names, sizes follow the data
    hdr.setUint16(8, 0, true);
    hdr.setUint16(10, dosTime(date), true);
    hdr.setUint16(12, dosDate(date), true);
    hdr.setUint16(26, nameBytes.length, true);
    await this.put(new Uint8Array(hdr.buffer));
    await this.put(nameBytes);
    let crc = 0;
    let size = 0;
    const feed = async (u8) => { crc = crc32(u8, crc); size += u8.length; await this.put(u8); };
    if (typeof data === 'string') await feed(te.encode(data));
    else if (data instanceof Uint8Array) await feed(data);
    else {
      const reader = data.stream().getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; await feed(value); }
    }
    if (this.pos > MAX_ZIP) throw Object.assign(new Error('zip too big'), { code: 'zip_too_big' });
    const dd = new DataView(new ArrayBuffer(16));
    dd.setUint32(0, 0x08074b50, true);
    dd.setUint32(4, crc, true);
    dd.setUint32(8, size, true);
    dd.setUint32(12, size, true);
    await this.put(new Uint8Array(dd.buffer));
    this.entries.push({ nameBytes, crc, size, offset, time: dosTime(date), date: dosDate(date) });
  }

  async close() {
    const start = this.pos;
    for (const e of this.entries) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0808, true);
      c.setUint16(12, e.time, true);
      c.setUint16(14, e.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.size, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, e.nameBytes.length, true);
      c.setUint32(42, e.offset, true);
      await this.put(new Uint8Array(c.buffer));
      await this.put(e.nameBytes);
    }
    const size = this.pos - start;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, start, true);
    await this.put(new Uint8Array(end.buffer));
  }
}

/** Collects the written pieces as Blobs (the browser keeps big ones on disk). */
export function blobSink() {
  const parts = [];
  return { write: (u8) => { parts.push(u8.slice()); }, blob: () => new Blob(parts, { type: 'application/zip' }) };
}

/** Entries of a zip file: Map(name -> { size, file() }). Handles stored and deflated entries. */
export async function readZip(file) {
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break; }
  if (e < 0) throw new Error('not a zip');
  const end = new DataView(tail.buffer, tail.byteOffset + e, 22);
  const count = end.getUint16(10, true);
  const cdSize = end.getUint32(12, true);
  const cdOffset = end.getUint32(16, true);
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const out = new Map();
  const dec = new TextDecoder();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i += 1) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true);
    const elen = cd.getUint16(p + 30, true);
    const clen = cd.getUint16(p + 32, true);
    const offset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    out.set(name, {
      size,
      async file() {
        const lh = new DataView(await file.slice(offset, offset + 30).arrayBuffer());
        const start = offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(start, start + csize);
        const base = name.split('/').pop();
        if (method === 0) return new File([raw], base);
        if (method === 8) return new File([await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob()], base);
        throw new Error('unsupported zip method');
      },
    });
  }
  return out;
}
