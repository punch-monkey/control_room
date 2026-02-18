const APP_VERSION = "2026.02.18.1";
const STATIC_CACHE = `control-room-static-${APP_VERSION}`;
const DATA_CACHE = `control-room-data-${APP_VERSION}`;
const SW_URL = new URL(self.location.href);
const BASE_URL = SW_URL.href.slice(0, SW_URL.href.lastIndexOf("/") + 1);

function resolveAsset(path) {
  return new URL(path, BASE_URL).href;
}

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/config.js",
  "./js/api_base.js",
  "./js/map.js",
  "./js/icons.js",
  "./js/dashboard.js",
  "./js/network_graph.js",
  "./js/timeline.js",
  "./js/context_menu.js",
  "./js/intel_export.js",
  "./js/intel_import.js",
  "./js/doc_converter.js",
  "./js/system_health.js",
  "./js/tfl_live.js",
  "./js/national_rail_live.js",
  "./js/flights.js",
  "./js/dvla.js",
  "./js/i2_workspace.js"
].map(resolveAsset);

const STATIC_ASSET_SET = new Set(STATIC_ASSETS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const keep = new Set([STATIC_CACHE, DATA_CACHE]);
      return Promise.all(
        keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

function cacheFirst(request) {
  return caches.open(STATIC_CACHE).then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  });
}

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

function shouldHandleRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== SW_URL.origin) return false;
  return true;
}

function isDataRequest(url) {
  return (
    url.pathname.startsWith(new URL("./data/", BASE_URL).pathname) ||
    url.pathname.endsWith(".geojson") ||
    url.pathname.endsWith(".json")
  );
}

self.addEventListener("fetch", (event) => {
  if (!shouldHandleRequest(event.request)) return;
  const url = new URL(event.request.url);
  if (STATIC_ASSET_SET.has(url.href)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  if (isDataRequest(url)) {
    event.respondWith(
      networkFirst(event.request).catch(() => caches.match(event.request))
    );
    return;
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
