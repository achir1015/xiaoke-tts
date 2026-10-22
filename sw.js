// Service Worker：讓手機／電腦可以「安裝」成 App，並快取網頁外殼（斷線時也能打開）。
// 語音引擎（hf.space、自架伺服器）是其他網域，一律直接走網路，不經過這裡。
const CACHE = "xiaoke-tts-v1.0.2";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/audio.js", "js/drama.js", "js/engines.js", "js/id3.js",
  "js/project.js", "js/sounds.js", "js/store.js", "js/version.js", "js/voices.js", "js/voices-builtin.js", "vendor/lame.min.js",
  "manifest.webmanifest", "icons/icon-192.png", "favicon-32.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // 先拿網路上的新版，失敗才用快取
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && !url.pathname.includes("/samples/")) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
