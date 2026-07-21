/* CAMP SYNC — service worker
   Pri každom nasadení novej verzie HTML bumpni číslo CACHE! */
const CACHE = 'campsync-v38';

const SHELL = [
  './app.html',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Firebase volania NIKDY necachovať — offline dáta rieši Firestore persistence sám */
const FIREBASE = [
  'googleapis.com',
  'identitytoolkit',
  'securetoken',
  'firebaseio',
  'firebaseinstallations',
  'google-analytics.com',
  'analytics.google.com'
];

self.addEventListener('fetch', e => {
  const url = e.request.url;

  if (e.request.method !== 'GET') return;                 // POST a spol. vždy na sieť
  if (FIREBASE.some(f => url.includes(f))) return;        // Firebase vždy na sieť

  /* HTML / navigácie: network-first (online čerstvé, offline z cache) */
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => { try { c.put(e.request, copy); } catch (err) {} });
          return res;
        })
        .catch(() =>
          caches.match(e.request).then(hit => hit || caches.match('./app.html'))
        )
    );
    return;
  }

  /* statické assety (SDK z gstatic, fonty, ikony): cache-first */
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => { try { c.put(e.request, copy); } catch (err) {} });
        return res;
      });
    })
  );
});

/* ---------- PUSH notifikácie ---------- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  const n = d.notification || d.data || {};
  e.waitUntil(self.registration.showNotification(n.title || '⛺ CampSync', {
    body: n.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [150, 80, 150],
    tag: 'campsync-items',
    data: { link: './app.html' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
    for (const c of list) { if (c.url.includes('app.html') && 'focus' in c) return c.focus(); }
    return clients.openWindow('./app.html');
  }));
});
