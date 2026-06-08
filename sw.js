const CACHE_NAME = "stracon-docs-v3";
const RUNTIME_CACHE = "stracon-docs-runtime-v3";
const APP_SHELL = [
  "./",
  "./simple.html",
  "./manifest.webmanifest",
  "./stracon-app-icon-192.png",
  "./stracon-app-icon-512.png",
  "./sw.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => ![CACHE_NAME, RUNTIME_CACHE].includes(key))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request, "./simple.html"));
    return;
  }

  if (["/simple.html", "/manifest.webmanifest", "/sw.js"].includes(url.pathname)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (url.pathname === "/api/library") {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (url.pathname.startsWith("/uploads/")) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return fallbackUrl ? caches.match(fallbackUrl) : Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetched = fetch(request)
    .then(async (response) => {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || fetched;
}
