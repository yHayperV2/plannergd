const CACHE_NAME = 'financas-cache-v1787342338';
const urlsToCache = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Ignora requisições que não sejam GET
  if (event.request.method !== 'GET') return;

  // NUNCA faz cache de requisições para a API do Supabase
  const url = new URL(event.request.url);
  if (url.hostname.includes('supabase.co')) {
    return; // Deixa o navegador lidar com a requisição normalmente (sem cache do SW)
  }

  // Estratégia Network First para o resto (arquivos locais HTML, JS, CSS)
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const respClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, respClone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});