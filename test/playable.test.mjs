// Old voice messages (Ogg/Opus from Telegram) and videos with the index at the end: an Apple browser gets a playable copy, the others the original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-playable-'));
process.env.DATA_DIR = dir;
process.env.DB_DIR = dir;
process.env.NODE_ENV = 'development';
const hasFfmpeg = !spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error;

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

test('the Apple browsers are told apart from the others', async () => {
  const { isAppleWebkit } = await import('../server/src/playable.js');
  assert.equal(isAppleWebkit(IPHONE), true);
  assert.equal(isAppleWebkit(SAFARI_MAC), true);
  assert.equal(isAppleWebkit(CHROME), false);
  assert.equal(isAppleWebkit(''), false);
});

test('an old Ogg voice message and a video with the index at the end get a playable copy for an iPhone only', { skip: !hasFfmpeg }, async () => {
  const { playableFor, moovAtStart } = await import('../server/src/playable.js');
  const { config } = await import('../server/src/config.js');
  fs.mkdirSync(config.filesDir, { recursive: true });
  const ogg = path.join(config.filesDir, 'voiceTESTfile01');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', '-f', 'ogg', ogg]).status, 0, 'a test voice message was made');
  const f = { id: 'voiceTESTfile01', mime: 'audio/ogg', size: fs.statSync(ogg).size };
  assert.equal(await playableFor(f, CHROME), null, 'a computer browser plays the original');
  const alt = await playableFor(f, IPHONE);
  assert.ok(alt && alt.mime === 'audio/mp4' && fs.existsSync(alt.path) && alt.path.endsWith('.m4a'), 'an iPhone gets an m4a');
  assert.equal((await playableFor(f, IPHONE)).path, alt.path, 'the copy is kept and used again');
  assert.equal(fs.readFileSync(ogg).subarray(0, 4).toString(), 'OggS', 'the original is untouched');

  const mp4 = path.join(config.filesDir, 'videoTESTfile01');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25', '-t', '20', '-c:v', 'mpeg4', '-q:v', '2', '-f', 'mp4', mp4]).status, 0, 'a test video was made');
  assert.equal(moovAtStart(mp4), false, 'the index of this video is at the end, like in the Telegram files');
  const v = { id: 'videoTESTfile01', mime: 'video/mp4', size: fs.statSync(mp4).size };
  assert.ok(v.size > 1_000_000, `big enough (${v.size})`);
  assert.equal(await playableFor(v, CHROME), null);
  const fast = await playableFor(v, IPHONE);
  assert.ok(fast && fs.existsSync(fast.path), 'an iPhone gets the video with the index first');
  assert.equal(moovAtStart(fast.path), true, 'and the index is at the start now');
  assert.equal(await playableFor({ id: 'x', mime: 'image/png', size: 5 }, IPHONE), null, 'a picture is left alone');
});
