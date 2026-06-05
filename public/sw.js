const CACHE_NAME = 'rss-reader-v2';
// キャッシュする静的アセットのリスト
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png'
];

// インストール時に静的ファイルをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// 古いキャッシュの削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// キャッシュ優先（Cache-First）でネットワーク通信を傍受
self.addEventListener('fetch', (event) => {
  // 1. APIリクエストは常にネットワークから
  if (event.request.url.includes('/api/')) {
    return;
  }

  // 2. 画面の遷移（HTML）はネットワーク優先
  // 認証切れの際にCloudflare Accessのログイン画面へ正しくリダイレクトさせるため
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request);
      })
    );
    return;
  }

  // 3. その他の静的アセット（JS, CSS, 画像）はキャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request);
    })
  );
});