/* ===========================================
   sw.js — オフライン動作用のサービスワーカー
   一度でもオンラインで開けば、以降はネット接続が無くても
   アプリをそのまま使えるようにする（全ファイルを端末にキャッシュ）。
   =========================================== */
const APP_VERSION = 'v128';
const CACHE = 'shiftapp-' + APP_VERSION;

// 起動に必要な一式。バージョン付きURLで取得しているものも
// クエリを外した形で登録しておき、取得時は無視して照合する。
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/data.v6.js',
  './js/optimizer.v6.js',
  './js/worker-client.v6.js',
  './js/ai-explain.v6.js',
  './js/ui.v6.js',
  './js/milp.v6.js',
  './js/app.v6.js',
  './js/milp.worker.js',
  './js/data.js',
  './js/optimizer.js',
  './js/milp-core.js',
  './js/optimizer.worker.js',
  './js/vendor/xlsx.full.min.js',
  './js/vendor/highs.js',
  './js/vendor/highs.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 1つでも失敗すると全体が失敗するため、個別に取得して失敗は無視する
    await Promise.all(ASSETS.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// クエリ(?v=NNN)を無視してキャッシュ照合するためのキー
function cacheKey(request) {
  const url = new URL(request.url);
  url.search = '';
  return url.toString();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 同一オリジンのみ扱う

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = cacheKey(req);
    try {
      // オンライン時は最新を取りに行き、成功したらキャッシュを更新する
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(key, fresh.clone());
      return fresh;
    } catch (_) {
      // オフライン時はキャッシュから返す
      const hit = await cache.match(key);
      if (hit) return hit;
      const idx = await cache.match(cacheKey(new Request('./index.html', { })));
      if (idx && req.mode === 'navigate') return idx;
      throw _;
    }
  })());
});
