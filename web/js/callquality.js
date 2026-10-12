// Pure helpers for call quality: turning WebRTC stats into a score, and adapting the video send
// parameters to the network. No DOM access, so it can be unit-tested.

/** 3 = good, 2 = fair, 1 = poor */
export function score({ rtt, lossPct, jitter }) {
  const r = rtt ?? 0;
  const l = lossPct ?? 0;
  const j = jitter ?? 0;
  if (r > 400 || l > 8 || j > 80) return 1;
  if (r > 180 || l > 2.5 || j > 35) return 2;
  return 3;
}

/**
 * Video send ladder, best first. Audio is never touched: when the link degrades the video
 * is reduced first so the voice stays intelligible.
 */
export const LADDER = [
  { kbps: 3000, scale: 1, fps: 30, label: '1080p30' },
  { kbps: 1500, scale: 1.5, fps: 30, label: '720p30' },
  { kbps: 800, scale: 2, fps: 24, label: '540p24' },
  { kbps: 400, scale: 3, fps: 15, label: '360p15' },
  { kbps: 180, scale: 4, fps: 12, label: '270p12' },
];

const MODE_START = { auto: 0, high: 0, save: 3 };

export class VideoAdapter {
  constructor(mode = 'auto') {
    this.mode = mode;
    this.level = MODE_START[mode] ?? 0;
    this.bad = 0;
    this.good = 0;
  }

  params() {
    return LADDER[this.level];
  }

  /** Feed one sample; returns the new ladder step when it changed, otherwise null. */
  push(s, availableKbps = null) {
    if (this.mode === 'save') return null; // fixed low profile
    const before = this.level;
    // "high" degrades more reluctantly (needs a longer run of bad samples) and never goes below 540p
    const floor = this.mode === 'high' ? 2 : LADDER.length - 1;
    const badNeeded = this.mode === 'high' ? 4 : 2;
    if (s === 1) {
      this.bad += 1;
      this.good = 0;
    } else if (s === 3) {
      this.good += 1;
      this.bad = 0;
    } else {
      this.bad = 0;
      this.good = Math.max(0, this.good - 1);
    }
    if (this.bad >= badNeeded && this.level < floor) { this.level += 1; this.bad = 0; }
    if (this.good >= 6 && this.level > 0) { this.level -= 1; this.good = 0; }
    // never ask for more than the bandwidth estimate allows
    if (availableKbps) {
      while (LADDER[this.level].kbps > availableKbps * 0.85 && this.level < floor) this.level += 1;
    }
    return this.level !== before ? LADDER[this.level] : null;
  }
}

/** Turn two consecutive getStats() reports into one sample (kbps, loss %, rtt, jitter, size). */
export function sampleFromStats(prev, report, dtSec) {
  let rtt = null; let jitter = null; let width = null; let height = null; let fps = null; let codec = null; let relay = false;
  let availableKbps = null;
  let inBytes = 0; let outBytes = 0; let lost = 0; let recv = 0;
  const codecs = new Map();
  const pairs = [];
  report.forEach((r) => {
    if (r.type === 'codec') codecs.set(r.id, r.mimeType);
    if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded') && r.currentRoundTripTime !== undefined) pairs.push(r);
  });
  report.forEach((r) => {
    if (r.type === 'inbound-rtp') {
      inBytes += r.bytesReceived || 0;
      lost += r.packetsLost || 0;
      recv += r.packetsReceived || 0;
      if (r.kind === 'audio' && r.jitter !== undefined) jitter = r.jitter * 1000;
      if (r.kind === 'video') {
        width = r.frameWidth ?? width;
        height = r.frameHeight ?? height;
        fps = r.framesPerSecond ?? fps;
        codec = codecs.get(r.codecId)?.replace('video/', '') ?? codec;
      }
    } else if (r.type === 'outbound-rtp') {
      outBytes += r.bytesSent || 0;
    }
  });
  const best = pairs.sort((a, b) => (b.nominated ? 1 : 0) - (a.nominated ? 1 : 0))[0];
  if (best) {
    rtt = best.currentRoundTripTime * 1000;
    if (best.availableOutgoingBitrate) availableKbps = best.availableOutgoingBitrate / 1000;
    const local = report.get ? report.get(best.localCandidateId) : null;
    relay = local?.candidateType === 'relay';
  }
  const dIn = prev ? Math.max(0, inBytes - prev.inBytes) : 0;
  const dOut = prev ? Math.max(0, outBytes - prev.outBytes) : 0;
  const dLost = prev ? Math.max(0, lost - prev.lost) : 0;
  const dRecv = prev ? Math.max(0, recv - prev.recv) : 0;
  const lossPct = dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : 0;
  return {
    raw: { inBytes, outBytes, lost, recv },
    rtt, jitter, lossPct, width, height, fps, codec, relay, availableKbps,
    kbpsIn: dt(dIn, dtSec), kbpsOut: dt(dOut, dtSec),
  };
}

function dt(bytes, sec) {
  return sec > 0 ? (bytes * 8) / 1000 / sec : 0;
}

/** Running summary, sent to the server at the end (numbers only). */
export class Summary {
  constructor(mode) {
    this.mode = mode;
    this.n = 0;
    this.rttSum = 0; this.rttMax = 0; this.lossSum = 0; this.jitterSum = 0; this.inSum = 0; this.outSum = 0;
    this.last = {};
    this.reconnects = 0;
  }

  add(s) {
    this.n += 1;
    if (s.rtt !== null) { this.rttSum += s.rtt; this.rttMax = Math.max(this.rttMax, s.rtt); }
    this.lossSum += s.lossPct || 0;
    this.jitterSum += s.jitter || 0;
    this.inSum += s.kbpsIn || 0;
    this.outSum += s.kbpsOut || 0;
    this.last = { width: s.width ?? this.last.width, height: s.height ?? this.last.height, fps: s.fps ?? this.last.fps, codec: s.codec ?? this.last.codec, relay: s.relay };
  }

  toJSON(durationSec) {
    const n = Math.max(1, this.n);
    return {
      rtt_ms: this.rttSum / n, rtt_max_ms: this.rttMax, loss_pct: this.lossSum / n, jitter_ms: this.jitterSum / n,
      kbps_in: this.inSum / n, kbps_out: this.outSum / n, ...this.last, mode: this.mode,
      reconnects: this.reconnects, duration: durationSec, samples: this.n,
    };
  }
}
