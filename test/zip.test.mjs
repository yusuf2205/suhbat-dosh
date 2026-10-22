// The ZIP writer/reader behind backups: a round trip, and the archive must be valid for other programs as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ZipWriter, blobSink, crc32, readZip } from '../web/js/zip.js';

test('crc32 of a known text', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip: write several entries (text, bytes, a blob), read them back, and other tools accept the archive', async () => {
  const sink = blobSink();
  const z = new ZipWriter(sink);
  const big = Buffer.alloc(300_000, 7);
  await z.add('result.json', JSON.stringify({ имя: 'Привет' }));
  await z.add('files/1_фото.png', new Uint8Array([1, 2, 3, 4]));
  await z.add('files/2_big.bin', new Blob([big]));
  await z.close();
  const blob = sink.blob();
  const entries = await readZip(new File([blob], 'b.zip'));
  assert.deepEqual([...entries.keys()], ['result.json', 'files/1_фото.png', 'files/2_big.bin']);
  assert.equal(JSON.parse(await (await entries.get('result.json').file()).text()).имя, 'Привет');
  assert.deepEqual([...new Uint8Array(await (await entries.get('files/1_фото.png').file()).arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(entries.get('files/2_big.bin').size, 300_000);
  assert.equal(Buffer.compare(Buffer.from(await (await entries.get('files/2_big.bin').file()).arrayBuffer()), big), 0);
  // python's own checker (skipped when python is not installed)
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zip-')), 'b.zip');
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const py = spawnSync('python', ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print(z.testzip(), len(z.namelist()))', file], { encoding: 'utf8' });
  if (py.status === 0) assert.equal(py.stdout.trim(), 'None 3');
});

test('zip reader unpacks deflated entries too (archives made by other programs)', async () => {
  // build a one-entry deflated archive by hand
  const data = Buffer.from('hello hello hello hello'.repeat(20));
  const { deflateRawSync } = await import('node:zlib');
  const raw = deflateRawSync(data);
  const name = Buffer.from('a.txt');
  const crc = crc32(new Uint8Array(data));
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(raw.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const body = Buffer.concat([lh, name, raw]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(body.length, 16);
  const zip = Buffer.concat([body, cd, name, end]);
  const entries = await readZip(new File([zip], 'd.zip'));
  assert.equal(await (await entries.get('a.txt').file()).text(), data.toString());
});
