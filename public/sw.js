// Service worker: makes the dashboard installable, opens instantly, and shows push notifications.
// App files are network-first (so updates land immediately) with a cached fallback. API calls are never cached.
const CACHE = 'digiteq-v3';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png', '/icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(async () => (await caches.match(e.request)) || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error())));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Digiteq', body: e.data?.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    // App already on screen: it shows its own in-app alert, so skip the system one.
    if (list.some((c) => c.visibilityState === 'visible')) return undefined;
    return self.registration.showNotification(data.title || 'Digiteq', {
      body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
      tag: data.tag, data: { url: data.url || '/' }, renotify: !!data.tag,
    });
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list[0];
    if (win) { win.postMessage({ type: 'open', url }); return win.focus(); }
    return self.clients.openWindow(url);
  }));
});
