/* CAMP SYNC — service worker
   Pri každom nasadení novej verzie HTML bumpni číslo CACHE! */
const CACHE = 'campsync-v71';
const INTENT_CACHE = 'campsync-intent';   // kam otvoriť appku po kliku na notifikáciu (nemazať pri aktualizácii)

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
      Promise.all(keys.filter(k => k !== CACHE && k !== INTENT_CACHE).map(k => caches.delete(k)))
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
  const n = d.data || d.notification || {};
  const link = n.link || './app.html';
  const tab = (() => { try { return new URL(link, self.registration.scope).searchParams.get('tab') || ''; } catch (err) { return ''; } })();
  e.waitUntil(self.registration.showNotification(n.title || '⛺ CampSync', {
    body: n.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [150, 80, 150],
    tag: tab === 'chat' ? 'campsync-chat' : tab === 'invite' ? 'campsync-invite' : 'campsync-items',
    renotify: true,
    data: { link }
  }));
});

/* Klik na notifikáciu: zámer (tab + partia + svet) najprv uložíme do Cache Storage.
   Ak Android appku na pozadí medzičasom zatvoril alebo ju pri návrate načíta nanovo,
   appka si zámer prečíta pri štarte — parametre v URL by sa vtedy stratili. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || './app.html';
  let intent = null;
  try {
    const u = new URL(link, self.registration.scope);
    const tab = u.searchParams.get('tab');
    if (tab) intent = { tab, party: u.searchParams.get('party') || '', mode: u.searchParams.get('mode') || '', ts: Date.now() };
  } catch (err) {}
  const openUrl = intent
    ? `./app.html?tab=${encodeURIComponent(intent.tab)}&party=${encodeURIComponent(intent.party)}&mode=${encodeURIComponent(intent.mode)}`
    : './app.html';

  e.waitUntil((async () => {
    if (intent) {
      try {
        const c = await caches.open(INTENT_CACHE);
        await c.put(self.registration.scope + '__intent',
          new Response(JSON.stringify(intent), { headers: { 'Content-Type': 'application/json' } }));
      } catch (err) {}
    }
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.includes('app.html')) {
        if (intent) c.postMessage({ intent });
        return c.focus();
      }
    }
    return clients.openWindow(openUrl);
  })());
});
