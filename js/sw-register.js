(function registerControlRoomSW() {
  if (!("serviceWorker" in navigator)) return;
  if (window.location.protocol === "file:") return;
  const host = String(window.location.hostname || "").toLowerCase();
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1";

  // In local development, force-disable SW to avoid stale cache-first assets.
  if (isLocalhost) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
      .catch(() => {});
    if (window.caches && typeof window.caches.keys === "function") {
      window.caches.keys()
        .then((keys) => Promise.all(keys
          .filter((k) => String(k || "").startsWith("control-room-"))
          .map((k) => window.caches.delete(k))))
        .catch(() => {});
    }
    return;
  }

  const scope = document.currentScript?.dataset?.scope || "/";
  const swUrl = document.currentScript?.dataset?.sw || "/sw.js";
  const register = () => {
    navigator.serviceWorker.register(swUrl, { scope })
      .then((registration) => {
        if (registration.waiting) {
          registration.waiting.postMessage("SKIP_WAITING");
        }
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (worker) {
            worker.addEventListener("statechange", () => {
              if (worker.state === "installed" && navigator.serviceWorker.controller) {
                console.info("Control Room assets updated. Reload to use the latest build.");
              }
            });
          }
        });
      })
      .catch((err) => {
        console.warn("Service worker registration failed", err);
      });
  };
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
})();
