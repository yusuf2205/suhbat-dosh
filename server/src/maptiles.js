// Map pictures for the messages with a place (like the map card of Telegram). The tiles come from OpenStreetMap through this server:
// the people's devices never contact the map site (their address is not shown to it), and every tile is kept on disk, so the map
// site is asked once per tile for everybody.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError, log, rateLimit } from './util.js';

export const maptiles = express.Router();

const DIR = path.join(config.dataDir, 'maptiles');
const MAX_TILE = 200 * 1024;
const SOURCE = process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org';

maptiles.get('/map/tile/:z/:x/:y.png', async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const n = 2 ** z;
  if (![z, x, y].every(Number.isInteger) || z < 2 || z > 18 || x < 0 || y < 0 || x >= n || y >= n) throw new HttpError(400, 'invalid_input');
  const file = path.join(DIR, String(z), String(x), `${y}.png`);
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  res.type('png');
  if (fs.existsSync(file)) return res.sendFile(file);
  if (!rateLimit(`tile:${req.user.id}`, 1500, 60_000)) throw new HttpError(429, 'too_many_requests');
  try {
    const r = await fetch(`${SOURCE}/${z}/${x}/${y}.png`, {
      headers: { 'User-Agent': 'SuhbatDosh/1.0 (self-hosted messenger; map cards)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok || !/^image\/png/.test(r.headers.get('content-type') || '')) throw new Error(`status ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_TILE) throw new Error('size');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    res.send(buf);
  } catch (e) {
    log('warn', 'map tile failed', { z, x, y, err: e.message });
    res.removeHeader('Cache-Control');
    throw new HttpError(502, 'map_unavailable');
  }
});
