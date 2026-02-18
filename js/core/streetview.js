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

  function _escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function _isLocalHost() {
    var host = String(window.location && window.location.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }

  function _formatDateYYYYMMDD(d) {
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return String(yyyy) + mm + dd;
  }

  function _normalizeAddressForFile(address) {
    var out = String(address || "").replace(/[,]+/g, " ").replace(/\s+/g, " ").trim();
    return out || "Unknown Location";
  }

  function _buildDownloadFilename(address) {
    var dateStamp = _formatDateYYYYMMDD(new Date());
    var normalizedAddress = _normalizeAddressForFile(address);
    var base = dateStamp + " - Google Maps - " + normalizedAddress;
    // Windows-safe filename while preserving requested visual format.
    return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim() + ".png";
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

    var qs =
      "?size=" + encodeURIComponent(size) +
      "&location=" + encodeURIComponent(lat + "," + lng) +
      "&fov=" + encodeURIComponent(fov) +
      "&heading=" + encodeURIComponent(heading) +
      "&pitch=" + encodeURIComponent(pitch) +
      "&key=" + encodeURIComponent(key);
    if (_isLocalHost() && typeof window.apiUrl === "function") {
      return window.apiUrl("/streetview/static" + qs);
    }
    return "https://maps.googleapis.com/maps/api/streetview" + qs;
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

  async function getStreetViewStatus(lat, lng) {
    var key = _getApiKey();
    if (!key) return { ok: false, status: "NO_KEY" };
    var url = "https://maps.googleapis.com/maps/api/streetview/metadata" +
      "?location=" + encodeURIComponent(lat + "," + lng) +
      "&key=" + encodeURIComponent(key);
    try {
      var resp = await fetch(url);
      var data = await resp.json();
      var status = String(data?.status || "UNKNOWN");
      return { ok: status === "OK", status: status, data: data };
    } catch (e) {
      return { ok: false, status: "NETWORK_ERROR" };
    }
  }

  // ── Render Street View thumbnail into container ──
  async function renderThumbnail(container, lat, lng, options) {
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

    var meta = await getStreetViewStatus(lat, lng);
    if (!meta.ok) {
      var msg = "No Street View coverage";
      if (meta.status === "NO_KEY") msg = "Street View key missing";
      else if (meta.status === "REQUEST_DENIED") msg = "Street View request denied (API key/referrer)";
      else if (meta.status === "OVER_QUERY_LIMIT") msg = "Street View quota exceeded";
      else if (meta.status === "INVALID_REQUEST") msg = "Street View request invalid";
      if (meta?.data?.error_message) msg += ": " + _escapeHtml(meta.data.error_message);
      container.innerHTML = '<div class="sv-unavailable">' + msg + '</div>';
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

  async function downloadPng(lat, lng, options) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    options = options || {};
    var size = options.size || "1280x720";
    var url = getStaticUrl(lat, lng, { size: size, fov: options.fov, heading: options.heading, pitch: options.pitch });
    if (!url) return;
    var address = String(options.addressString || options.address || "").trim();
    var filename = String(options.filename || _buildDownloadFilename(address));

    try {
      var resp = await fetch(url);
      if (!resp.ok) throw new Error("download failed");
      var blob = await resp.blob();
      var bitmap = await createImageBitmap(blob);
      var canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      var pngBlob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, "image/png");
      });
      if (!pngBlob) throw new Error("png conversion failed");
      var objectUrl = URL.createObjectURL(pngBlob);
      var a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 2000);
    } catch (_e) {
      // Last resort: open source image in new tab if conversion/download fails.
      window.open(url, "_blank");
    }
  }

  // ── Add Street View to entity popup HTML ──
  function getPopupThumbnailHtml(lat, lng, options) {
    options = options || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
    var mapsUrl = "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" + lat + "," + lng;
    var addressJs = JSON.stringify(String(options.addressString || options.address || ""));
    if (!isConfigured()) {
      return '<div class="sv-unavailable">Street View not configured</div>' +
        '<a class="popup-psc-btn" href="' + mapsUrl + '" target="_blank" rel="noopener">Open in Google Maps</a>';
    }
    var url = getStaticUrl(lat, lng, { size: "300x150", fov: 90 });
    if (!url) {
      return '<a class="popup-psc-btn" href="' + mapsUrl + '" target="_blank" rel="noopener">Open in Google Maps</a>';
    }
    return '<img class="sv-popup-thumb" src="' + url + '" alt="Street View" loading="lazy" ' +
      'onerror="this.style.display=\'none\'" ' +
      'onclick="window.open(\'' + mapsUrl + '\',\'_blank\')" ' +
      'style="width:100%;border-radius:4px;margin-top:6px;cursor:pointer;border:1px solid rgba(255,255,255,0.08)" ' +
      'title="Click to open Street View">' +
      '<a class="popup-psc-btn" href="' + mapsUrl + '" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;">Open in Google Maps</a>' +
      '<button class="popup-psc-btn" type="button" onclick="window.StreetView.downloadPng(' + lat + ',' + lng + ',{addressString:' + addressJs + '})" style="display:inline-block;margin-top:6px;margin-left:6px;">Download PNG</button>';
  }

  // ── Public API ──
  window.StreetView = {
    isConfigured: isConfigured,
    getStaticUrl: getStaticUrl,
    hasStreetView: hasStreetView,
    getStreetViewStatus: getStreetViewStatus,
    renderThumbnail: renderThumbnail,
    renderInspectorView: renderInspectorView,
    getPopupThumbnailHtml: getPopupThumbnailHtml,
    downloadPng: downloadPng
  };

})();
