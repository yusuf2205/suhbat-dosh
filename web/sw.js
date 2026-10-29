// Offline app shell. API and WebSocket traffic is never cached (private data).
const CACHE = 'suhbat-shell-v131';
const SHELL = ['/', '/styles.css?v=24', '/splash.css?v=3', '/design2.css?v=14', '/js/main.js?v=7', '/icon.svg?v=2', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    // all modules of the build too: otherwise a start without a network works only after a second online visit
    try {
      const list = await (await fetch('/shell.json', { cache: 'no-store' })).json();
      await Promise.allSettled(list.map((u) => c.add(u)));
    } catch { /* the shell alone is still cached */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  // network-first so updates ship immediately; cache is the offline fallback
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  );
});

// ---- background notifications (Web Push): the app can be closed
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Suhbat-dosh', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // do not bother the user when the app is open and focused: it already shows the message
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // the number on the icon of the installed app (iPhone 16.4+, Android, desktop)
    if (typeof d.badge === 'number') { try { await (d.badge > 0 ? self.navigator.setAppBadge?.(d.badge) : self.navigator.clearAppBadge?.()); } catch { /* not supported */ } }
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(d.title || 'Suhbat-dosh', {
      body: d.body || '', icon: '/icon.svg?v=2', badge: '/icon.svg?v=2', tag: d.tag || 'suhbat', renotify: true,
      ...(d.call ? { requireInteraction: true, vibrate: [300, 150, 300, 150, 300] } : {}),
      data: { chat_id: d.chat_id, message_id: d.message_id },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chatId = e.notification.data?.chat_id;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      await w.focus().catch(() => {});
      w.postMessage({ type: 'open-chat', chat_id: chatId });
      return;
    }
    await self.clients.openWindow(chatId ? `/?chat=${chatId}` : '/');
  })());
});
