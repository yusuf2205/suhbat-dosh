// Effects for the camera and the microphone in calls: blur of the background and a strong noise remover.
// Both run on this device (a small segmentation model and the RNNoise filter), and are loaded only when somebody turns them on.
// Every place that opens the camera or the microphone for a call goes through fxUserMedia().
import { S } from './state.js';
import { t } from './i18n.js';
import { toast } from './ui.js';

const MP = '/js/vendor/mediapipe';
let segmenterP = null;
let announced = false;

async function segmenter() {
  segmenterP ||= (async () => {
    if (!announced) { announced = true; toast(t('fx.loading'), 4000); }
    const vision = await import('./vendor/mediapipe/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const make = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${MP}/selfie_segmenter.tflite`, delegate },
      runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    try { return await make('GPU'); } catch { return make('CPU'); }
  })();
  segmenterP.catch(() => { segmenterP = null; });
  return segmenterP;
}

/** A camera track whose background is blurred. The returned track stops the camera too when it is stopped. */
async function blurTrack(source) {
  const seg = await segmenter();
  const s = source.getSettings();
  const w = Math.min(s.width || 640, 960);
  const hgt = Math.round(w * ((s.height || 360) / (s.width || 640)));
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  await video.play();
  const out = document.createElement('canvas');
  out.width = w; out.height = hgt;
  const octx = out.getContext('2d');
  const fg = document.createElement('canvas');
  fg.width = w; fg.height = hgt;
  const fctx = fg.getContext('2d');
  const maskCanvas = document.createElement('canvas');
  const mctx = maskCanvas.getContext('2d');
  let alive = true;
  let last = -1;
  const frame = () => {
    if (!alive) return;
    if (video.readyState >= 2 && video.currentTime !== last) {
      last = video.currentTime;
      try {
        seg.segmentForVideo(video, performance.now(), (res) => {
          const m = res.confidenceMasks?.[res.confidenceMasks.length > 1 ? 1 : 0];
          if (!m) return;
          const data = m.getAsFloat32Array();
          if (maskCanvas.width !== m.width) { maskCanvas.width = m.width; maskCanvas.height = m.height; }
          const img = mctx.createImageData(m.width, m.height);
          for (let i = 0; i < data.length; i += 1) {
            const a = Math.max(0, Math.min(1, (data[i] - 0.3) / 0.35)); // soft edge instead of a hard cut
            img.data[i * 4 + 3] = a * 255;
          }
          mctx.putImageData(img, 0, 0);
          octx.filter = 'blur(14px)';
          octx.drawImage(video, 0, 0, w, hgt);
          octx.filter = 'none';
          fctx.globalCompositeOperation = 'source-over';
          fctx.clearRect(0, 0, w, hgt);
          fctx.drawImage(video, 0, 0, w, hgt);
          fctx.globalCompositeOperation = 'destination-in';
          fctx.drawImage(maskCanvas, 0, 0, w, hgt);
          octx.drawImage(fg, 0, 0);
          res.confidenceMasks.forEach((x) => x.close?.());
        });
      } catch { /* a dropped frame */ }
    }
    setTimeout(frame, 1000 / 24);
  };
  frame();
  const track = out.captureStream(24).getVideoTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => { alive = false; stop(); source.stop(); video.srcObject = null; };
  track.__source = source;
  return track;
}

/** A microphone track filtered by RNNoise (48 kHz). */
async function cleanTrack(source) {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const lib = await import('./vendor/noise/index.js');
  const wasm = await lib.loadRnnoise({ url: '/js/vendor/noise/rnnoise.wasm', simdUrl: '/js/vendor/noise/rnnoise_simd.wasm' });
  await ctx.audioWorklet.addModule('/js/vendor/noise/rnnoise-worklet.js');
  const src = ctx.createMediaStreamSource(new MediaStream([source]));
  const node = new lib.RnnoiseWorkletNode(ctx, { wasmBinary: wasm, maxChannels: 1 });
  const dest = ctx.createMediaStreamDestination();
  src.connect(node);
  node.connect(dest);
  const track = dest.stream.getAudioTracks()[0];
  const stop = track.stop.bind(track);
  track.stop = () => { stop(); source.stop(); try { node.destroy?.(); ctx.close(); } catch { /* closed */ } };
  track.__source = source;
  return track;
}

/** getUserMedia plus the effects the person chose; if an effect cannot start, the plain track is used. */
export async function fxUserMedia(constraints) {
  const wantNoise = !!S.prefs.strongNoise && !!constraints.audio;
  const c = wantNoise && typeof constraints.audio === 'object' ? { ...constraints, audio: { ...constraints.audio, noiseSuppression: false } } : constraints;
  const st = await navigator.mediaDevices.getUserMedia(c);
  const wantBlur = !!S.prefs.bgBlur && st.getVideoTracks().length > 0;
  if (!wantBlur && !(wantNoise && st.getAudioTracks().length)) return st;
  const out = new MediaStream();
  for (const tr of st.getTracks()) {
    let use = tr;
    try {
      if (tr.kind === 'video' && wantBlur) use = await blurTrack(tr);
      else if (tr.kind === 'audio' && wantNoise) use = await cleanTrack(tr);
    } catch (e) {
      toast(t(tr.kind === 'video' ? 'fx.blur_failed' : 'fx.noise_failed'), 5000);
      use = tr;
      void e;
    }
    out.addTrack(use);
  }
  return out;
}
