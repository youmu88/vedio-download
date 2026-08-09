/* 视频缓存 Service Worker：HLS 分片/清单请求优先命中本地缓存，未命中透传网络 */
const CACHE = 'vd-media-cache';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  // 仅处理同源或 /downloads 与流媒体类资源，避免干扰 API
  try {
    const u = new URL(url);
    if (!u.origin || u.pathname.startsWith('/api/')) return;
    if (!/\.(m3u8|ts|mp4|flv)(\?|$)/i.test(u.pathname)) {
      // 也拦截 manifest 相关（无扩展名时跳过）
      return;
    }
  } catch { return; }

  e.respondWith(
    caches.open(CACHE)
      .then((c) => c.match(req))
      .then((hit) => hit || fetch(req))
      .catch(() => fetch(req))
  );
});