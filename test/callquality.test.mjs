import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LADDER, Summary, VideoAdapter, sampleFromStats, score } from '../web/js/callquality.js';

test('score reflects delay, loss and jitter', () => {
  assert.equal(score({ rtt: 40, lossPct: 0, jitter: 5 }), 3);
  assert.equal(score({ rtt: 220, lossPct: 0, jitter: 5 }), 2);
  assert.equal(score({ rtt: 40, lossPct: 3, jitter: 5 }), 2);
  assert.equal(score({ rtt: 500, lossPct: 0, jitter: 5 }), 1);
  assert.equal(score({ rtt: 40, lossPct: 12, jitter: 5 }), 1);
  assert.equal(score({ rtt: 40, lossPct: 0, jitter: 120 }), 1);
});

test('auto mode starts at 1080p30 and steps the video down on a bad link', () => {
  const a = new VideoAdapter('auto');
  assert.equal(a.params().label, '1080p30');
  assert.equal(a.push(1), null);          // one bad sample is tolerated
  assert.equal(a.push(1).label, '720p30'); // two in a row: step down
  a.push(1); a.push(1);
  assert.equal(a.params().label, '540p24');
  for (let i = 0; i < 20; i++) a.push(1);
  assert.equal(a.params().label, LADDER.at(-1).label); // never below the last rung
});

test('auto mode recovers step by step when the link is good again', () => {
  const a = new VideoAdapter('auto');
  for (let i = 0; i < 6; i++) a.push(1);
  const low = a.level;
  assert.ok(low >= 2);
  for (let i = 0; i < 6; i++) a.push(3);
  assert.equal(a.level, low - 1);
  for (let i = 0; i < 30; i++) a.push(3);
  assert.equal(a.level, 0);
});

test('fair samples neither degrade nor upgrade quickly', () => {
  const a = new VideoAdapter('auto');
  for (let i = 0; i < 20; i++) a.push(2);
  assert.equal(a.level, 0);
});

test('bandwidth estimate caps the bitrate', () => {
  const a = new VideoAdapter('auto');
  const step = a.push(3, 1000); // only 1 Mbit/s available: 3000 kbps rung is too much
  assert.ok(step && step.kbps <= 850);
});

test('high quality mode resists degradation and keeps at least 540p; save mode is fixed low', () => {
  const h = new VideoAdapter('high');
  for (let i = 0; i < 40; i++) h.push(1);
  assert.ok(h.level <= 2);
  assert.equal(h.params().label, '540p24');
  const s = new VideoAdapter('save');
  assert.equal(s.params().label, '360p15');
  assert.equal(s.push(3), null);
  for (let i = 0; i < 20; i++) s.push(3);
  assert.equal(s.params().label, '360p15');
});

test('sampleFromStats turns raw WebRTC stats into rates, loss and delay', () => {
  const mk = (arr) => new Map(arr.map((r) => [r.id, r]));
  const t0 = mk([
    { id: 'in-a', type: 'inbound-rtp', kind: 'audio', bytesReceived: 1000, packetsReceived: 100, packetsLost: 0, jitter: 0.004 },
    { id: 'in-v', type: 'inbound-rtp', kind: 'video', bytesReceived: 50_000, packetsReceived: 400, packetsLost: 0, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, codecId: 'c1' },
    { id: 'out-v', type: 'outbound-rtp', kind: 'video', bytesSent: 40_000 },
    { id: 'c1', type: 'codec', mimeType: 'video/VP8' },
    { id: 'p', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.045, availableOutgoingBitrate: 2_500_000, localCandidateId: 'l' },
    { id: 'l', type: 'local-candidate', candidateType: 'host' },
  ]);
  const first = sampleFromStats(null, t0, 2);
  const t1 = mk([
    { id: 'in-a', type: 'inbound-rtp', kind: 'audio', bytesReceived: 3000, packetsReceived: 200, packetsLost: 5, jitter: 0.008 },
    { id: 'in-v', type: 'inbound-rtp', kind: 'video', bytesReceived: 150_000, packetsReceived: 800, packetsLost: 15, frameWidth: 1280, frameHeight: 720, framesPerSecond: 29, codecId: 'c1' },
    { id: 'out-v', type: 'outbound-rtp', kind: 'video', bytesSent: 140_000 },
    { id: 'c1', type: 'codec', mimeType: 'video/VP8' },
    { id: 'p', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.06, availableOutgoingBitrate: 2_500_000, localCandidateId: 'l' },
    { id: 'l', type: 'local-candidate', candidateType: 'relay' },
  ]);
  const s = sampleFromStats(first.raw, t1, 2);
  assert.equal(Math.round(s.rtt), 60);
  assert.equal(Math.round(s.kbpsIn), 408);   // (150000+3000-51000) bytes * 8 / 2 s
  assert.equal(Math.round(s.kbpsOut), 400);
  assert.equal(s.width, 1280);
  assert.equal(s.codec, 'VP8');
  assert.equal(s.relay, true);
  assert.ok(s.lossPct > 3.5 && s.lossPct < 4.2, String(s.lossPct)); // 20 lost of 520
  assert.equal(Math.round(s.availableKbps), 2500);
});

test('summary averages and never contains media', () => {
  const sum = new Summary('auto');
  sum.add({ rtt: 40, lossPct: 0, jitter: 5, kbpsIn: 800, kbpsOut: 700, width: 1280, height: 720, fps: 30, codec: 'VP8', relay: false });
  sum.add({ rtt: 80, lossPct: 2, jitter: 15, kbpsIn: 600, kbpsOut: 500, width: 1280, height: 720, fps: 24, codec: 'VP8', relay: false });
  const j = sum.toJSON(120);
  assert.equal(j.rtt_ms, 60);
  assert.equal(j.rtt_max_ms, 80);
  assert.equal(j.loss_pct, 1);
  assert.equal(j.samples, 2);
  assert.equal(j.duration, 120);
  assert.deepEqual(Object.keys(j).filter((k) => typeof j[k] === 'string'), ['codec', 'mode']);
});

test('video is switched off when even the lowest rung is bad, and comes back after a calm stretch', async () => {
  const { VideoAdapter, LADDER } = await import('../web/js/callquality.js');
  const a = new VideoAdapter('auto');
  const events = [];
  for (let i = 0; i < 30; i++) { a.push(1); if (a.event) events.push(a.event); }
  assert.deepEqual(events, ['pause']);
  assert.equal(a.paused, true);
  for (let i = 0; i < 4; i++) a.push(3);
  assert.equal(a.paused, true);              // not yet: a calm stretch is needed
  a.push(1);                                  // a bad sample resets the stretch
  for (let i = 0; i < 4; i++) a.push(3);
  assert.equal(a.paused, true);
  const step = a.push(3);
  assert.equal(a.event, 'resume');
  assert.equal(a.paused, false);
  assert.equal(step.label, LADDER.at(-1).label); // probes on the lowest rung, then climbs normally
});

test('the high and save modes never switch the video off', async () => {
  const { VideoAdapter } = await import('../web/js/callquality.js');
  for (const mode of ['high', 'save']) {
    const a = new VideoAdapter(mode);
    for (let i = 0; i < 40; i++) a.push(1);
    assert.equal(a.paused, false);
  }
});

test('the second pause waits longer before probing again', async () => {
  const { VideoAdapter } = await import('../web/js/callquality.js');
  const a = new VideoAdapter('auto');
  const waitAfterPause = () => {
    let n = 0;
    while (!a.paused) a.push(1);
    while (a.paused) { a.push(3); n += 1; }
    return n;
  };
  const first = waitAfterPause();
  const second = waitAfterPause();
  assert.ok(second > first);
});

test('the audio stream gets leaner on a bad link and recovers', async () => {
  const { AudioAdapter } = await import('../web/js/callquality.js');
  const a = new AudioAdapter();
  assert.equal(a.push(1), null);
  assert.equal(a.push(1), null);
  assert.equal(a.push(1), 24000);
  for (let i = 0; i < 5; i++) assert.equal(a.push(3), null);
  assert.equal(a.push(3), 64000);
});

test('a silent but "connected" call is detected', async () => {
  const { Stall } = await import('../web/js/callquality.js');
  const s = new Stall();
  assert.equal(s.push(0), false);   // the first sample has nothing to compare with
  assert.equal(s.push(40), false);
  assert.equal(s.push(0), false);
  assert.equal(s.push(0), false);
  assert.equal(s.push(0), true);
  assert.equal(s.push(0), false);   // counting starts again after a nudge
});
