// Service Worker - 静的ファイルのみキャッシュ。APIなし(localStorage運用)
const CACHE_NAME = 'katei-zaiko-v20260426f';
const ASSETS = [
  './',
  './index.html',
  './src/style.css',
  './src/main.js',
  './src/sync.js',
  './src/templates.js',
  './manifest.webmanifest',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(()=>{}))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

function isHtmlRequest(req, url){
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  if (url.pathname.endsWith('.html')) return true;
  if (url.pathname.endsWith('/')) return true;
  return false;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // HTML はキャッシュせず必ずネットワーク取得 (オフライン時のみキャッシュ)
  // → 新しいスクリプトタグの ?v=... を即座に拾えるようにする
  if (isHtmlRequest(req, url)){
    e.respondWith((async () => {
      try {
        return await fetch(req, { cache: 'no-store' });
      } catch {
        return (await caches.match(req)) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // 静的アセット (JS/CSS/icons): ネットワークファースト + キャッシュ更新
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(()=>{});
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw new Error('offline');
    }
  })());
});
