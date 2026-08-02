const CACHE_NAME = 'rss-reader-v3';
// ランタイムキャッシュの最大エントリ数。Vite のハッシュ付きアセットはデプロイの
// たびに増えるため、上限を超えたら古いエントリから削除して肥大化を防ぐ。
const MAX_RUNTIME_CACHE_ENTRIES = 200;
// キャッシュする静的アセットのリスト
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png'
];

// インストール時に事前キャッシュしたアプリシェルかどうか。
// ナビゲーションは network-first で再キャッシュされないため、退避対象から除外する。
// クエリ付き（/?view=... 等）のランタイムエントリは無制限に増え得るため除外しない。
function isAppShellEntry(key) {
  const url = new URL(key.url);
  return url.search === '' && ASSETS_TO_CACHE.includes(url.pathname);
}

// キャッシュ書き込みは並行 fetch イベント間で競合しないよう直列化する。
// （keys スナップショットの競合で上限超過や取り違えが起きるのを防ぐ）
let cacheWriteQueue = Promise.resolve();

function putWithEviction(request, response) {
  const task = cacheWriteQueue
    .catch(() => {})
    .then(() => doPutWithEviction(request, response));
  cacheWriteQueue = task;
  return task;
}

// キャッシュに追記する。put が容量超過で失敗しないよう、先に古いエントリから
// 退避してから挿入する（失敗は握り潰し、レスポンス配信を妨げない）。
// 注意: cache.keys() の並びは実装上は挿入順だが仕様上保証されないため、
// 退避は「おおよそ古いものから」のベストエフォート。
async function doPutWithEviction(request, response) {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  // 今回の put 分も収まるように 1 件多めに空きを作る
  const excess = keys.length - MAX_RUNTIME_CACHE_ENTRIES + 1;
  let removed = 0;
  for (const key of keys) {
    if (removed >= excess) {
      break;
    }
    if (isAppShellEntry(key)) {
      continue;
    }
    await cache.delete(key);
    removed += 1;
  }
  await cache.put(request, response);
}

// インストール時に静的ファイルをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => 
      cache.addAll(ASSETS_TO_CACHE)
    ).then(() => self.skipWaiting())
  );
});

// 古いキャッシュの削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => 
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
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
      fetch(event.request).catch(() => 
        caches.match(event.request)
      )
    );
    return;
  }

  // 3. その他の静的アセット（JS, CSS, 画像）はキャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request)
        .then((response) => {
          // 取得したアセットをキャッシュに追記する（初回以降はオフラインでも表示可能に）。
          // キャッシュ対象は同一オリジンの GET 成功レスポンスのみ。
          // キャッシュ書き込みはレスポンスの配信をブロックしないよう waitUntil に委ねる
          // （fetch イベントの dispatch は respondWith の Promise が解決するまで継続するため、
          //  この時点での waitUntil 呼び出しは有効）。
          try {
            if (response.ok && !response.redirected && event.request.method === 'GET') {
              const url = new URL(event.request.url);
              // ランタイムキャッシュはビルド成果物（/assets/* と静的ファイル拡張子）に限定する。
              // それ以外の同一オリジン GET（将来の動的エンドポイント等）を無期限キャッシュしない。
              const isStaticAsset =
                url.pathname.startsWith('/assets/') ||
                /\.(?:js|css|woff2?|png|jpe?g|gif|webp|svg|ico)$/.test(url.pathname);
              if (url.origin === self.location.origin && isStaticAsset) {
                const copy = response.clone();
                const writePromise = putWithEviction(event.request, copy).catch(() => {});
                // FetchEvent は respondWith の Promise が解決するまで dispatch が継続するため、
                // この時点（非同期コールバック内）の waitUntil 呼び出しは有効。万一ブラウザが
                // InvalidStateError を投げた場合も、応答配信を妨げないよう握り潰す。
                try {
                  event.waitUntil(writePromise);
                } catch {
                  // waitUntil が使えない環境では書き込み完了前に SW が終了し得るが、
                  // 次回アクセス時に再キャッシュされるため問題ない
                }
              }
            }
          } catch {
            // キャッシュ処理の例外（clone 等）はレスポンス配信に影響させない
          }
          return response;
        })
        .catch(() => {
          // オフライン時はネットワークエラーとして扱う（JS/CSS に HTML を返すと
          // MIME エラーになるため、エントリページへのフォールバックはしない）。
          return Response.error();
        });
    })
  );
});