// ================== streetview.js ==================
// Google Street View Static API integration for entity enrichment
(function () {
  "use strict";

  var DEFAULT_SIZE = "400x250";
  var DEFAULT_FOV = 90;
  var DEFAULT_HEADING = 0;
  var DEFAULT_PITCH = 0;

  // ── Get API key ──
  function _getApiKey() {
    return window.GOOGLE_STREETVIEW_API_KEY || "";
  }

  // ── Check if Street View is configured ──
  function isConfigured() {
    return !!_getApiKey();
  }

  // ── Build Street View Static API URL ──
  function getStaticUrl(lat, lng, options) {
    var key = _getApiKey();
    if (!key) return null;
    options = options || {};
    var size = options.size || DEFAULT_SIZE;
    var fov = options.fov || DEFAULT_FOV;
    var heading = options.heading != null ? options.heading : DEFAULT_HEADING;
    var pitch = options.pitch != null ? options.pitch : DEFAULT_PITCH;

    return "https://maps.googleapis.com/maps/api/streetview" +
      "?size=" + encodeURIComponent(size) +
      "&location=" + encodeURIComponent(lat + "," + lng) +
      "&fov=" + encodeURIComponent(fov) +
      "&heading=" + encodeURIComponent(heading) +
      "&pitch=" + encodeURIComponent(pitch) +
      "&key=" + encodeURIComponent(key);
  }

  // ── Check if Street View coverage exists at location ──
  // Uses the metadata endpoint (free, no image served)
  async function hasStreetView(lat, lng) {
    var key = _getApiKey();
    if (!key) return false;

    var url = "https://maps.googleapis.com/maps/api/streetview/metadata" +
      "?location=" + encodeURIComponent(lat + "," + lng) +
      "&key=" + encodeURIComponent(key);

    try {
      var resp = await fetch(url);
      var data = await resp.json();
      return data.status === "OK";
    } catch (e) {
      return false;
    }
  }

  // ── Render Street View thumbnail into container ──
  function renderThumbnail(container, lat, lng, options) {
    if (!container) return;
    if (!isConfigured()) {
      container.innerHTML = '<div class="sv-unavailable">Street View not configured</div>';
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      container.innerHTML = '';
      return;
    }

    options = options || {};
    var size = options.size || "360x200";
    var url = getStaticUrl(lat, lng, { size: size, fov: options.fov, heading: options.heading, pitch: options.pitch });
    if (!url) {
      container.innerHTML = '<div class="sv-unavailable">Street View unavailable</div>';
      return;
    }

    var img = document.createElement("img");
    img.className = "inspector-streetview";
    img.alt = "Street View at " + lat.toFixed(5) + ", " + lng.toFixed(5);
    img.loading = "lazy";
    img.src = url;
    img.style.cursor = "pointer";
    img.title = "Click to open in Google Maps";

    img.onerror = function () {
      container.innerHTML = '<div class="sv-unavailable">No Street View coverage</div>';
    };

    img.onclick = function () {
      var mapsUrl = "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" + lat + "," + lng;
      window.open(mapsUrl, "_blank");
    };

    container.innerHTML = "";
    container.appendChild(img);
  }

  // ── Render larger Street View for inspector panel ──
  function renderInspectorView(container, lat, lng) {
    renderThumbnail(container, lat, lng, { size: "640x300", fov: 80 });
  }

  // ── Add Street View to entity popup HTML ──
  function getPopupThumbnailHtml(lat, lng) {
    if (!isConfigured() || !Number.isFinite(lat) || !Number.isFinite(lng)) return "";
    var url = getStaticUrl(lat, lng, { size: "300x150", fov: 90 });
    if (!url) return "";
    return '<img class="sv-popup-thumb" src="' + url + '" alt="Street View" loading="lazy" ' +
      'onerror="this.style.display=\'none\'" ' +
      'onclick="window.open(\'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + lat + ',' + lng + '\',\'_blank\')" ' +
      'style="width:100%;border-radius:4px;margin-top:6px;cursor:pointer;border:1px solid rgba(255,255,255,0.08)" ' +
      'title="Click to open Street View">';
  }

  // ── Public API ──
  window.StreetView = {
    isConfigured: isConfigured,
    getStaticUrl: getStaticUrl,
    hasStreetView: hasStreetView,
    renderThumbnail: renderThumbnail,
    renderInspectorView: renderInspectorView,
    getPopupThumbnailHtml: getPopupThumbnailHtml
  };

})();
