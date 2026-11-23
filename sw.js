const prefix = 'wortschatz-v2:' + self.registration.scope + ':';
const V = prefix + '12', FILES = ['./', 'index.html', 'app.js', 'logic.js', 'words.json', 'manifest.json', 'icon-180-v27.png', 'icon-192-v27.png', 'icon-512-v27.png', 'icon-maskable-192-v27.png', 'icon-maskable-512-v27.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith(prefix) && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => { if (e.request.method !== 'GET' || !e.request.url.startsWith(self.registration.scope)) return; e.respondWith(caches.match(e.request, { ignoreSearch: true, cacheName: V }).then(r => r || fetch(e.request))); });
