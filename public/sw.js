// Service Worker（オフライン対応）
const CACHE = 'visit-v5';
const STATIC = ['/manifest.json', '/logo.png'];

// 認証・管理系ページ: キャッシュ禁止、ネットワーク専用
// 古い HTML が返ると認証状態・画面内容の不整合を引き起こすため
const NO_CACHE_PATHS = new Set([
  '/login', '/login.html',
  '/admin', '/admin.html',
  '/admin-manual', '/admin-manual.html',
  '/change-password', '/change-password.html',
  '/forgot-password', '/forgot-password.html',
  '/reset-password', '/reset-password.html',
]);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // APIリクエストはキャッシュしない
  if (e.request.url.includes('/api/')) return;

  const url = new URL(e.request.url);

  // 認証・管理系ページはネットワーク専用（失敗してもキャッシュを返さない）
  if (NO_CACHE_PATHS.has(url.pathname)) {
    e.respondWith(fetch(e.request));
    return;
  }

  // その他のHTMLはネットワーク優先（成功時のみキャッシュ更新、失敗時はキャッシュ）
  if (e.request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 静的ファイルはキャッシュ優先
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
