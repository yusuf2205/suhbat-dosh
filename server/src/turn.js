// ICE servers for calls: STUN + (optional) TURN, so media can flow even when both people are behind strict NATs
// (typical for mobile networks). Two ways to provide TURN:
//   * TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL  - your own coturn (see docker-compose profile "turn")
//   * CF_TURN_KEY_ID / CF_TURN_API_TOKEN           - Cloudflare Realtime TURN (no open ports needed; short-lived credentials)
import { config } from './config.js';
import { log } from './util.js';

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TTL = 86400;
let cached = null; // array of RTCIceServer from Cloudflare
let lastError = null;
let failures = 0;

export const cloudflareTurnConfigured = () => !!(process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN);

function normalize(body) {
  const v = body?.iceServers ?? body;
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.filter((s) => s && s.urls).map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username, credential: s.credential } : {}) }));
}

async function fetchCloudflare() {
  const id = process.env.CF_TURN_KEY_ID;
  const headers = { authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`, 'content-type': 'application/json' };
  for (const path of ['generate-ice-servers', 'generate']) {
    const r = await fetch(`${API}/${encodeURIComponent(id)}/credentials/${path}`, {
      method: 'POST', headers, body: JSON.stringify({ ttl: TTL }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { lastError = `HTTP ${r.status}`; continue; }
    const list = normalize(await r.json());
    if (list.length) { lastError = null; return list; }
  }
  throw new Error(lastError || 'empty response');
}

let retryTimer = null;
async function refresh() {
  clearTimeout(retryTimer);
  try {
    cached = await fetchCloudflare();
    failures = 0;
    log('info', 'cloudflare turn credentials refreshed', { servers: cached.length });
  } catch (e) {
    lastError = e.message;
    failures += 1;
    // right after a (re)start the network may not be up yet, and a failure must not leave calls without TURN for hours: try again soon, then less often
    const wait = Math.min(300_000, 5_000 * 2 ** Math.min(failures - 1, 6));
    log('warn', 'cloudflare turn refresh failed', { err: e.message, retry_in_s: Math.round(wait / 1000) });
    retryTimer = setTimeout(refresh, wait);
    retryTimer.unref();
  }
}

export function startTurn() {
  if (!cloudflareTurnConfigured()) return;
  refresh();
  setInterval(refresh, 6 * 3600_000).unref();
}

/** What clients get in /api/config and when joining a group call. */
export function currentIceServers() {
  return cached ? [...config.iceServers, ...cached] : config.iceServers;
}

export function turnStatus() {
  const own = config.iceServers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith('turn')));
  return {
    configured: own || !!cached,
    source: cached ? 'cloudflare' : own ? 'coturn' : null,
    cloudflare_configured: cloudflareTurnConfigured(),
    error: cloudflareTurnConfigured() && !cached ? lastError : null,
  };
}
