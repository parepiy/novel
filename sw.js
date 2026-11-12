/* ห้องสมุดนิยาย — service worker

   - Navigations (opening the app): network-first with a 3.5 s timeout, then the
     cached page. Fresh code on every online launch, and still opens offline /
     on a slow network (no more "A problem repeatedly occurred").
   - Cover images from this site: shown straight from their own cache (IMG) and
     refreshed in the background. That cache is kept across deploys.
   - Apps Script replies (they hold your notes) are never cached.
   - Everything else (the Sheet CSV, …): network-first with a cache fallback. */
const CACHE = 'novel-v42';
const IMG = 'novel-img-v1';   // covers: NOT tied to the app version, so a deploy keeps them
const SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== IMG).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  /* App-shell navigations: network-first with a short timeout, falling back
     to cache. This loads freshly-deployed code on every online launch while
     still opening instantly (from cache) when offline or on a slow network. */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const net = await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
        ]);
        if (net && net.ok) { cache.put('./index.html', net.clone()); return net; }
        throw new Error('bad status');
      } catch (_) {
        const cached = (await cache.match('./index.html')) || (await cache.match('./'));
        return cached || new Response(
          '<h1>ออฟไลน์</h1><p>เชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  const url = new URL(req.url);
  /* Apps Script (your library with notes, reminders, …): straight to the network, never stored. */
  if (/(^|\.)script\.google(usercontent)?\.com$/.test(url.hostname)) return;

  /* Covers from this site: from the cover cache at once, refreshed in the background. */
  if (req.destination === 'image' && url.origin === self.location.origin) {
    e.respondWith(caches.open(IMG).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res && res.ok) c.put(req, res.clone()); return res; });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    })));
    return;
  }

  /* Everything else (the Sheet CSV, …): network-first, cache fallback. */
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || Response.error()))
  );
});

/* ===== PUSH NOTIFICATIONS (reading reminders) ===== */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (_) { data = { title: 'ถึงเวลาอ่านนิยาย 📖', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'ถึงเวลาอ่านนิยาย 📖';
  const options = {
    body: data.body || '',
    data: { url: data.url || './' },
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || ('novel-' + Date.now()),
    renotify: true
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { try { c.navigate(url); } catch (_) {} return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
