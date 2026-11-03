// How long a person waits, measured on this device and sent to the server once a minute: durations only, nothing else.
const KINDS = ['send', 'send_net', 'ping', 'open', 'open_net'];
let box = {};

export function measure(kind, ms) {
  if (!KINDS.includes(kind) || !Number.isFinite(ms) || ms < 0) return;
  const list = (box[kind] ||= []);
  if (list.length < 200) list.push(Math.round(ms));
}

function flush() {
  if (!Object.keys(box).length) return;
  const body = JSON.stringify(box);
  box = {};
  // keepalive: still delivered when the page is being closed
  fetch('/api/metrics', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' }, body }).catch(() => {});
}

setInterval(flush, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
