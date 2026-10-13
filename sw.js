/* ベンチ13週プログラム - Service Worker
   目的：ジムの電波が無い場所でも確実に開くこと。

   方針
   - HTML（ナビゲーション）: ネットワーク優先 + 3秒タイムアウト → キャッシュ
     ＝オンラインなら常に最新、圏外や不安定な回線なら即キャッシュを返す
   - それ以外（アイコン等）: キャッシュ優先
   - 記録データは localStorage なので SW は一切関与しない（消さない）
*/
"use strict";

const VERSION = "v1";
const PREFIX = "bench13-";
const CACHE = `${PREFIX}${VERSION}`;
const TIMEOUT = 3000;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 1件でも失敗すると全部入らない addAll は避ける
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      // 同一オリジン（*.github.io）に別アプリが同居しうるので、
      // 自分のprefixが付いた旧バージョンだけを消す
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function fromNetwork(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(req).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML：ネットワーク優先（圏外ならキャッシュ）
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(
      fromNetwork(req, TIMEOUT)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./index.html", copy));
          }
          return res;
        })
        .catch(() =>
          caches.match("./index.html").then((hit) =>
            hit || new Response(
              "<!doctype html><meta charset=utf-8><body style='background:#0f1115;color:#e8eaf0;font-family:sans-serif;padding:40px'>オフラインです。一度オンラインで開くと、次からは圏外でも使えます。",
              { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
            )
          )
        )
    );
    return;
  }

  // その他：キャッシュ優先
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
