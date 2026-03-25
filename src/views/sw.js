const CACHE = 'alonbot-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  // Network-first for API calls, cache-first for static
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// Web Push notifications
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    const title = data.title || '360Shmikley';
    const options = {
      body: data.body || '',
      icon: '/icon-wa-blue-192.png',
      badge: '/icon-wa-blue-192.png',
      tag: data.tag || 'wa-message',
      renotify: true,
      data: { url: data.url || '/wa-mobile', phone: data.phone },
      vibrate: [200, 100, 200],
    };
    e.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    // fallback for plain text
    e.waitUntil(self.registration.showNotification('360Shmikley', { body: e.data.text() }));
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/wa-mobile';
  const phone = e.notification.data?.phone;
  const target = phone ? `${url}#chat-${phone}` : url;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes('/wa-mobile') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return self.clients.openWindow(target);
    })
  );
});
