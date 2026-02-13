// ================== national_rail.js ==================
// National Rail (Darwin LDBWS) integration

const NR = {
  active: false,
  timer: null,
  crs: "",
  boardType: "departures",
  provider: "raildata",
  markers: new Map(), // crs -> marker
  stationGeoCache: new Map(), // stationName -> [lat, lon]
  stationGeoByCrsCache: new Map(), // CRS -> [lat, lon]
  stationSuggestTimer: null,
  stationLookupByKey: new Map(),
  serviceDetailCache: new Map(), // serviceId -> detail payload
  routesLayer: null,
  routeLines: [],
  lastRouteSignature: "",
  health: { configured: false, endpoint: "" }
};

const UK_RAIL_STATIONS_CATALOG_URL = "https://raw.githubusercontent.com/davwheat/uk-railway-stations/main/stations.json";
let UK_RAIL_STATIONS_CACHE = null;

function geoDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function extractNrccMessageText(msg) {
  if (msg == null) return "";
  if (typeof msg === "string") return msg.trim();
  if (typeof msg === "object") {
    const direct = String(msg.message || msg.value || msg.text || msg.reason || msg.content || "").trim();
    if (direct) return direct;
    try {
      const first = Object.values(msg).find((v) => typeof v === "string" && String(v).trim());
      return first ? String(first).trim() : "";
    } catch (_) {
      return "";
    }
  }
  return "";
}

async function fetchNrJson(path) {
  const r = await fetch(apiUrl(path), { headers: { "Accept": "application/json" } });
  if (!r.ok) {
    let detail = "";
    try {
      const text = await r.text();
      detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.detail || parsed?.error || text;
      } catch (_) {
        // keep raw text
      }
    } catch (_) {
      detail = "";
    }
    throw new Error(`HTTP ${r.status}${detail ? ` ${String(detail).slice(0, 260)}` : ""}`);
  }
  return r.json();
}

function normalizeRailDataBoard(raw, boardType, crsFallback = "") {
  if (!raw || typeof raw !== "object") {
    return {
      generatedAt: "",
      locationName: "",
      crs: String(crsFallback || ""),
      nrccMessages: [],
      services: []
    };
  }
  const servicesIn = Array.isArray(raw.trainServices) ? raw.trainServices : [];
  const services = servicesIn
    .filter((svc) => svc && typeof svc === "object")
    .map((svc) => {
      const origin = Array.isArray(svc.origin)
        ? svc.origin
          .map((x) => String(x?.locationName || "").trim())
          .filter(Boolean)
        : [];
      const destination = Array.isArray(svc.destination)
        ? svc.destination
          .map((x) => String(x?.locationName || "").trim())
          .filter(Boolean)
        : [];
      return {
        serviceID: String(svc.serviceID || svc.serviceId || ""),
        std: String(svc.std || ""),
        etd: String(svc.etd || ""),
        sta: String(svc.sta || ""),
        eta: String(svc.eta || ""),
        platform: String(svc.platform || ""),
        operator: String(svc.operator || ""),
        operatorCode: String(svc.operatorCode || ""),
        length: String(svc.length || ""),
        origin,
        destination
      };
    });
  return {
    generatedAt: String(raw.generatedAt || ""),
    locationName: String(raw.locationName || ""),
    crs: String(raw.crs || crsFallback || ""),
    nrccMessages: Array.isArray(raw.nrccMessages)
      ? raw.nrccMessages.map(extractNrccMessageText).filter(Boolean)
      : [],
    services
  };
}

function normalizeCallingStop(raw) {
  if (!raw || typeof raw !== "object") return null;
  const crs = String(raw.crs || raw.CRS || "").trim().toUpperCase();
  const name = String(raw.locationName || raw.stationName || raw.name || "").trim();
  if (!crs && !name) return null;
  return { crs, name };
}

function pushUniqueStop(out, seen, stop) {
  const s = normalizeCallingStop(stop);
  if (!s) return;
  const key = s.crs || s.name.toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  out.push(s);
}

function collectCallingStops(raw, out, seen) {
  if (!raw) return;
  if (Array.isArray(raw)) {
    raw.forEach((item) => collectCallingStops(item, out, seen));
    return;
  }
  if (typeof raw !== "object") return;
  pushUniqueStop(out, seen, raw);
  ["callingPoint", "callingPoints", "previousCallingPoints", "subsequentCallingPoints"].forEach((k) => {
    if (raw[k] != null) collectCallingStops(raw[k], out, seen);
  });
}

function normalizeRailDataServiceDetails(raw, serviceIdFallback = "") {
  const safe = (raw && typeof raw === "object") ? raw : {};
  const stops = [];
  const seen = new Set();

  const previous = [];
  const next = [];
  collectCallingStops(safe.previousCallingPoints, previous, new Set());
  collectCallingStops(safe.subsequentCallingPoints, next, new Set());
  previous.forEach((s) => pushUniqueStop(stops, seen, s));
  pushUniqueStop(stops, seen, { crs: safe.crs, name: safe.locationName });
  next.forEach((s) => pushUniqueStop(stops, seen, s));

  if (!stops.length) {
    collectCallingStops(safe.origin, stops, seen);
    pushUniqueStop(stops, seen, { crs: safe.crs, name: safe.locationName });
    collectCallingStops(safe.destination, stops, seen);
  }

  return {
    serviceID: String(safe.serviceID || safe.serviceId || serviceIdFallback || ""),
    operator: String(safe.operator || ""),
    std: String(safe.std || ""),
    etd: String(safe.etd || ""),
    sta: String(safe.sta || ""),
    eta: String(safe.eta || ""),
    platform: String(safe.platform || ""),
    delayReason: String(safe.delayReason || ""),
    cancelReason: String(safe.cancelReason || ""),
    locationName: String(safe.locationName || ""),
    crs: String(safe.crs || "").toUpperCase(),
    callingPoints: stops
  };
}

async function fetchRailDataBoardFallback(crs, type, rows) {
  const q = new URLSearchParams({
    crs: String(crs || "").toUpperCase(),
    rows: String(rows || 12)
  });
  const raw = await fetchNrJson(`/raildata/live-board?${q.toString()}`);
  return {
    ok: true,
    provider: "raildata",
    type,
    board: normalizeRailDataBoard(raw, type, crs)
  };
}

async function fetchRailDataServiceDetailsFallback(serviceId) {
  const q = new URLSearchParams({ serviceid: String(serviceId || "") });
  const payload = await fetchNrJson(`/raildata/service-details?${q.toString()}`);
  return {
    ok: true,
    provider: "raildata",
    service: normalizeRailDataServiceDetails(payload, serviceId)
  };
}

async function fetchStationsCatalogDirect() {
  if (Array.isArray(UK_RAIL_STATIONS_CACHE)) return UK_RAIL_STATIONS_CACHE;
  const r = await fetch(UK_RAIL_STATIONS_CATALOG_URL, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Stations catalog HTTP ${r.status}`);
  const list = await r.json();
  UK_RAIL_STATIONS_CACHE = Array.isArray(list) ? list : [];
  return UK_RAIL_STATIONS_CACHE;
}

async function fetchBoard(crs, type) {
  const rows = CONTROL_ROOM_CONFIG?.nationalRail?.defaultRows || 12;
  try {
    const rd = await fetchRailDataBoardFallback(crs, type, rows);
    NR.provider = "raildata";
    return rd;
  } catch (raildataErr) {
    throw new Error(`RailData live board unavailable (${String(raildataErr?.message || raildataErr)}).`);
  }
}

async function fetchStationSuggestions(query, limit = 20) {
  const q = new URLSearchParams({ q: String(query || ""), limit: String(limit) });
  try {
    const data = await fetchNrJson(`/nre/stations?${q.toString()}`);
    return Array.isArray(data?.stations) ? data.stations : [];
  } catch (_) {
    const needle = String(query || "").trim().toLowerCase();
    if (needle.length < 2) return [];
    const list = await fetchStationsCatalogDirect();
    return list
      .map((r) => ({
        crs: String(r?.crsCode || "").toUpperCase(),
        name: String(r?.stationName || ""),
        lat: r?.lat,
        lon: r?.long
      }))
      .filter((s) => s.crs && s.name)
      .filter((s) => s.crs.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle))
      .slice(0, limit);
  }
}

function parseCrsFromInput(raw) {
  const text = String(raw || "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(text)) return text;
  const m = text.match(/\b([A-Z]{3})\b/);
  return m ? m[1] : "";
}

function hydrateCrsDatalist(stations) {
  const list = document.getElementById("nr-crs-list");
  if (!list) return;
  const items = Array.isArray(stations) ? stations : [];
  NR.stationLookupByKey.clear();
  list.innerHTML = items
    .slice(0, 40)
    .map((st) => {
      const key = `${st.crs} - ${st.name}`;
      NR.stationLookupByKey.set(key.toUpperCase(), st);
      return `<option value="${escapeHtml(key)}"></option>`;
    })
    .join("");
}

async function fetchServiceDetails(serviceId) {
  const key = String(serviceId || "").trim();
  if (!key) return { ok: false, service: {} };
  if (NR.serviceDetailCache.has(key)) return NR.serviceDetailCache.get(key);
  try {
    const detail = await fetchRailDataServiceDetailsFallback(key);
    NR.serviceDetailCache.set(key, detail);
    return detail;
  } catch (_) {
    const q = new URLSearchParams({ service_id: key });
    const detail = await fetchNrJson(`/nre/service?${q.toString()}`);
    NR.serviceDetailCache.set(key, detail);
    return detail;
  }
}

async function fetchNrHealth() {
  try {
    const health = await fetchNrJson("/nre/health");
    NR.health = {
      configured: !!health?.configured,
      endpoint: String(health?.endpoint || ""),
      provider: String(health?.provider || ""),
      fallback: health?.fallback || null
    };
    if (NR.health.configured) return NR.health;
  } catch (_) {
    // continue to RailData health fallback
  }

  // Fallback: treat RailData as a valid rail provider when configured.
  try {
    const rd = await fetchNrJson("/raildata/health");
    NR.health = {
      configured: !!rd?.configured,
      endpoint: String(rd?.endpoint || ""),
      provider: "raildata"
    };
    return NR.health;
  } catch (_) {
    NR.health = { configured: false, endpoint: "" };
    return NR.health;
  }
}

async function fetchRailDataRaw(path) {
  const resp = await fetch(apiUrl(path), {
    headers: { Accept: "application/json, application/xml, text/xml, text/plain" }
  });
  const ct = String(resp.headers.get("content-type") || "").toLowerCase();
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${text.slice(0, 220)}`);
  }
  if (ct.includes("application/json")) {
    try {
      return { contentType: ct, payload: JSON.parse(text), raw: text };
    } catch (_) {
      return { contentType: ct, payload: null, raw: text };
    }
  }
  return { contentType: ct || "text/plain", payload: null, raw: text };
}

function renderRailDataResult(title, data) {
  const wrap = document.getElementById("raildata-results");
  if (!wrap) return;

  const ct = escapeHtml(String(data?.contentType || "unknown"));
  const payload = data?.payload;
  const FEEDS = {
    disruptions: {
      label: "NationalRail Disruptions",
      help: "Rail incident and disruption notices affecting services."
    },
    performance: {
      label: "NWR Realtime Performance",
      help: "Operational performance reference for selected rail operator groups."
    },
    reference: {
      label: "Reference Data",
      help: "Static railway reference entities such as stations, operators, and related metadata."
    },
    naptan: {
      label: "NaPTAN",
      help: "National Public Transport Access Nodes. It identifies stops, stations, and access points."
    },
    nptg: {
      label: "NPTG",
      help: "National Public Transport Gazetteer. It defines place/locality hierarchy used in transport datasets."
    },
    feeds: {
      label: "RailData My Feeds",
      help: "Your configured/available RailData feeds and access scope."
    }
  };

  const feed = FEEDS[String(title || "").toLowerCase()] || { label: title, help: "RailData feed output." };
  const formatValue = (v) => {
    if (v == null) return "";
    if (typeof v === "string") {
      const s = v.trim();
      return s === "[object Object]" ? "" : s;
    }
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) {
      if (!v.length) return "0 items";
      const first = v[0];
      if (typeof first === "string" || typeof first === "number") return `${v.slice(0, 3).join(", ")}${v.length > 3 ? ", ..." : ""}`;
      return `${v.length} items`;
    }
    if (typeof v === "object") {
      const direct = String(v.name || v.description || v.title || v.code || v.id || "").trim();
      if (direct && direct !== "[object Object]") return direct;
      const parts = [];
      for (const [k, val] of Object.entries(v)) {
        const str = formatValue(val);
        if (!str) continue;
        parts.push(`${k}: ${str}`);
        if (parts.length >= 3) break;
      }
      if (parts.length) return parts.join(" | ");
      try {
        const compact = JSON.stringify(v);
        return compact && compact !== "{}" ? compact.slice(0, 100) : "";
      } catch (_) {
        return "";
      }
    }
    return String(v || "");
  };
  const toText = (v) => {
    const out = formatValue(v);
    return out || "";
  };
  const findArray = (obj, keys = []) => {
    if (!obj || typeof obj !== "object") return [];
    for (const k of keys) {
      if (Array.isArray(obj[k])) return obj[k];
    }
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
      if (k.toLowerCase().includes("list") && Array.isArray(v)) return v;
    }
    return [];
  };
  const pickColumns = (rows) => {
    const preferred = ["tocCode", "desc", "code", "name", "description", "id", "status"];
    const seen = new Set();
    const cols = [];
    preferred.forEach((p) => {
      if (rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, p))) {
        cols.push(p);
        seen.add(p);
      }
    });
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      for (const k of Object.keys(r)) {
        if (seen.has(k)) continue;
        cols.push(k);
        seen.add(k);
        if (cols.length >= 4) return cols;
      }
    }
    return cols.slice(0, 4);
  };

  let summary = "";
  let bodyHtml = "";
  if (payload && typeof payload === "object") {
    const rootKeys = Object.keys(payload);
    let rows = [];
    const key = String(title || "").toLowerCase();
    if (key === "performance") rows = findArray(payload, ["operatorList", "operators"]);
    else if (key === "disruptions") rows = findArray(payload, ["incidents", "disruptions", "messages"]);
    else if (key === "reference") rows = findArray(payload, ["stations", "tocs", "routes", "records"]);
    else if (key === "naptan") rows = findArray(payload, ["stops", "stopPoints", "naptanStops", "records"]);
    else if (key === "nptg") rows = findArray(payload, ["localities", "places", "records", "areas"]);
    else if (key === "feeds") rows = findArray(payload, ["feeds", "items", "data"]);
    else rows = findArray(payload, []);

    if (Array.isArray(payload)) rows = payload;
    summary = rows.length ? `${rows.length} record${rows.length === 1 ? "" : "s"}` : `${rootKeys.length} fields`;

    const groupName = toText(payload?.group?.groupName || payload?.group?.name || "");
    const groupDesc = toText(payload?.group?.description || "");
    const groupLine = groupName ? `${groupName}${groupDesc ? ` (${groupDesc})` : ""}` : "";
    const cols = pickColumns(rows);
    const rowHtml = rows.slice(0, 12).map((r) => {
      if (!r || typeof r !== "object") return "";
      const c1 = toText(r[cols[0]]);
      const c2 = toText(r[cols[1]]);
      const c3 = toText(r[cols[2]]);
      const fallbackText = toText(r.name || r.description || r.title || r.id || "");
      return (
        `<div class="nr-service">` +
        `<span class="nr-eta">${escapeHtml(c1 || "--")}</span>` +
        `<span class="nr-plat">${escapeHtml(c2 || "--")}</span>` +
        `<span class="nr-dest">${escapeHtml(c3 || fallbackText || "--")}</span>` +
        `</div>`
      );
    }).join("");
    const rawPreview = escapeHtml(JSON.stringify(payload, null, 2).slice(0, 1400));
    bodyHtml =
      (groupLine ? `<div class="nr-card-meta">Group: ${escapeHtml(groupLine)}</div>` : "") +
      (rowHtml || `<pre style="white-space:pre-wrap;max-height:220px;overflow:auto;margin:8px 0 0 0;">${rawPreview}</pre>`);
  } else {
    const raw = String(data?.raw || "");
    summary = `${raw.length} chars`;
    bodyHtml = `<pre style="white-space:pre-wrap;max-height:220px;overflow:auto;margin:8px 0 0 0;">${escapeHtml(raw.slice(0, 1600))}</pre>`;
  }

  wrap.innerHTML =
    `<div class="nr-card">` +
    `<div class="nr-card-title">${escapeHtml(feed.label)} <span class="nr-card-meta" title="${escapeHtml(feed.help)}" style="cursor:help;">[?]</span></div>` +
    `<div class="nr-card-meta">Content-Type: ${ct} | ${escapeHtml(summary)}</div>` +
    bodyHtml +
    `</div>`;
}

async function runRailDataQuickCheck(path, feedKey) {
  try {
    const data = await fetchRailDataRaw(path);
    renderRailDataResult(feedKey, data);
    setStatus(`RailData loaded: ${feedKey}`);
  } catch (e) {
    const wrap = document.getElementById("raildata-results");
    if (wrap) {
      wrap.innerHTML = `<div class="nr-alert">RailData failed (${escapeHtml(feedKey)}): ${escapeHtml(String(e?.message || e))}</div>`;
    }
    setStatus("RailData fetch failed");
  }
}

async function geocodeStationName(stationName) {
  const key = String(stationName || "").toLowerCase().trim();
  if (!key) return null;
  if (NR.stationGeoCache.has(key)) return NR.stationGeoCache.get(key);

  try {
    const stations = await fetchStationSuggestions(stationName, 8);
    const exact = stations.find((s) => String(s?.name || "").trim().toLowerCase() === key) || stations[0];
    const lat = Number(exact?.lat);
    const lon = Number(exact?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("no station lat/lon");
    const latLng = [lat, lon];
    NR.stationGeoCache.set(key, latLng);
    const crs = String(exact?.crs || "").toUpperCase();
    if (crs) NR.stationGeoByCrsCache.set(crs, latLng);
    return latLng;
  } catch (_) {
    try {
      const q = new URLSearchParams({
        q: `${stationName} railway station uk`,
        limit: "1"
      });
      const r = await fetchNrJson(`/geo/search?${q.toString()}`);
      const hit = Array.isArray(r) ? r[0] : null;
      const lat = Number(hit?.lat);
      const lon = Number(hit?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const latLng = [lat, lon];
      NR.stationGeoCache.set(key, latLng);
      return latLng;
    } catch (_) {
      return null;
    }
  }
}

async function geocodeStationByCrs(crs, fallbackName = "") {
  const key = String(crs || "").trim().toUpperCase();
  if (!key || !/^[A-Z]{3}$/.test(key)) {
    return fallbackName ? geocodeStationName(fallbackName) : null;
  }
  if (NR.stationGeoByCrsCache.has(key)) return NR.stationGeoByCrsCache.get(key);
  try {
    const stations = await fetchStationSuggestions(key, 8);
    const exact = stations.find((s) => String(s?.crs || "").toUpperCase() === key) || stations[0];
    const lat = Number(exact?.lat);
    const lon = Number(exact?.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const latLng = [lat, lon];
      NR.stationGeoByCrsCache.set(key, latLng);
      if (exact?.name) NR.stationGeoCache.set(String(exact.name).toLowerCase(), latLng);
      return latLng;
    }
  } catch (_) {
    // ignore and try fallback below
  }
  if (fallbackName) return geocodeStationName(fallbackName);
  return null;
}

async function buildRailServicePath(board, entry, detail, originLatLng) {
  const boardStop = {
    crs: String(board?.crs || "").trim().toUpperCase(),
    name: String(board?.locationName || "").trim()
  };
  const svc = detail?.service && typeof detail.service === "object" ? detail.service : {};
  const rawStops = Array.isArray(svc.callingPoints) ? svc.callingPoints : [];
  const deduped = [];
  const seen = new Set();
  rawStops.forEach((stop) => pushUniqueStop(deduped, seen, stop));
  pushUniqueStop(deduped, seen, boardStop);

  let pathStops = deduped;
  if (deduped.length >= 2) {
    const boardIdx = deduped.findIndex((s) =>
      (boardStop.crs && s.crs === boardStop.crs) ||
      (boardStop.name && s.name.toLowerCase() === boardStop.name.toLowerCase())
    );
    if (boardIdx >= 0) {
      pathStops = NR.boardType === "arrivals"
        ? deduped.slice(0, boardIdx + 1)
        : deduped.slice(boardIdx);
    }
  }

  if (pathStops.length < 2) pathStops = [
    boardStop,
    { crs: "", name: String(entry?.name || "").trim() }
  ];

  const coords = [];
  let prev = null;
  for (const stop of pathStops) {
    const latLng = stop.crs
      ? await geocodeStationByCrs(stop.crs, stop.name)
      : await geocodeStationName(stop.name);
    if (!latLng) continue;
    if (prev && geoDistanceKm(prev[0], prev[1], latLng[0], latLng[1]) < 0.15) continue;
    coords.push(latLng);
    prev = latLng;
  }

  if (coords.length >= 2) return coords;
  if (Array.isArray(originLatLng) && originLatLng.length === 2) {
    const dest = await geocodeStationName(entry?.name || "");
    if (dest) return [originLatLng, dest];
  }
  return null;
}

function ensureNrRoutesLayer() {
  if (NR.routesLayer) return NR.routesLayer;
  NR.routesLayer = L.layerGroup();
  NR.routesLayer.addTo(layers.national_rail);
  return NR.routesLayer;
}

function clearNrRoutes() {
  if (NR.routesLayer) NR.routesLayer.clearLayers();
  NR.routeLines = [];
  NR.lastRouteSignature = "";
}

function buildNrRouteSignature(boardName, entries = []) {
  const encoded = entries
    .map((e) => `${String(e?.name || "").toLowerCase()}:${Number(e?.count || 0)}`)
    .sort()
    .join("|");
  return `${String(boardName || "").toLowerCase()}::${encoded}`;
}

function addNrStationNode(routesLayer, latLng, label, emphasis = false) {
  if (!routesLayer || !Array.isArray(latLng) || latLng.length < 2) return null;
  const marker = L.circleMarker(latLng, {
    pane: "nrStationsPane",
    radius: emphasis ? 6 : 4.2,
    color: emphasis ? "#e0f2fe" : "#bae6fd",
    fillColor: emphasis ? "#38bdf8" : "#0ea5e9",
    fillOpacity: emphasis ? 0.95 : 0.88,
    weight: emphasis ? 2.4 : 1.6,
    className: "nr-station-node"
  }).addTo(routesLayer);
  if (label) marker.bindTooltip(String(label), { sticky: true, direction: "top", opacity: 0.95 });
  return marker;
}

async function plotNrServiceLines(board, services) {
  if (!board?.locationName || !Array.isArray(services) || !services.length) return;
  if (!map.hasLayer(layers.national_rail)) return;

  const origin = await geocodeStationByCrs(board.crs, board.locationName);
  if (!origin) return;

  const destinationAgg = new Map();
  for (const svc of services.slice(0, 40)) {
    const names = NR.boardType === "arrivals" ? (svc.origin || []) : (svc.destination || []);
    for (const rawName of names) {
      const name = String(rawName || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!destinationAgg.has(key)) {
        destinationAgg.set(key, {
          name,
          count: 0,
          eta: svc.eta || svc.etd || svc.sta || svc.std || "--",
          serviceID: String(svc.serviceID || "")
        });
      }
      destinationAgg.get(key).count += 1;
    }
  }

  const entries = Array.from(destinationAgg.values()).sort((a, b) => b.count - a.count).slice(0, 10);
  if (!entries.length) return;
  const nextSignature = buildNrRouteSignature(board.locationName, entries);
  if (nextSignature === NR.lastRouteSignature) return;

  clearNrRoutes();
  NR.lastRouteSignature = nextSignature;

  const routesLayer = ensureNrRoutesLayer();
  addNrStationNode(routesLayer, origin, `${board.locationName} (${board.crs || NR.crs})`, true);

  const destinations = await Promise.all(entries.map(async (entry) => {
    let detail = null;
    if (entry.serviceID) {
      try {
        detail = await fetchServiceDetails(entry.serviceID);
      } catch (_) {
        detail = null;
      }
    }
    const routeCoords = await buildRailServicePath(board, entry, detail, origin);
    return { entry, routeCoords };
  }));

  for (const item of destinations) {
    const entry = item.entry;
    const routeCoords = Array.isArray(item.routeCoords) ? item.routeCoords : [];
    if (routeCoords.length < 2) continue;
    addNrStationNode(routesLayer, routeCoords[routeCoords.length - 1], entry.name);
    const line = L.polyline(routeCoords, {
      pane: "nrRoutesPane",
      color: "#38bdf8",
      weight: 4.6,
      opacity: 0.92,
      className: "nr-service-line"
    }).addTo(routesLayer);
    line.bindTooltip(
      `${board.locationName} -> ${entry.name} (${entry.count} services, next ${entry.eta})`,
      { sticky: true, direction: "top", opacity: 0.95 }
    );
    line.bindPopup(
      `<strong>${escapeHtml(board.locationName)} -> ${escapeHtml(entry.name)}</strong>` +
      `<div class="nr-card-meta">${entry.count} service${entry.count === 1 ? "" : "s"} | Next ${escapeHtml(entry.eta)}</div>`
    );
    NR.routeLines.push(line);
  }
}

function renderNrResults(payload) {
  const wrap = document.getElementById("nr-results");
  if (!wrap) return;

  if (!payload?.ok || !payload?.board) {
    const reason = payload?.error || payload?.reason || "No board data";
    wrap.innerHTML = `<div class="nr-empty">${escapeHtml(reason)}</div>`;
    return;
  }

  const board = payload.board;
  const services = Array.isArray(board.services) ? board.services : [];
  const generated = board.generatedAt ? new Date(board.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--";

  let html =
    `<div class="nr-card">` +
    `<div class="nr-card-title">${escapeHtml(board.locationName || "Station")} (${escapeHtml(board.crs || NR.crs)})</div>` +
    `<div class="nr-card-meta">${escapeHtml(payload.type || NR.boardType)} | Updated ${escapeHtml(generated)} | ${services.length} service${services.length === 1 ? "" : "s"}</div>`;

  if (Array.isArray(board.nrccMessages) && board.nrccMessages.length) {
    const firstMsg = extractNrccMessageText(board.nrccMessages[0]);
    if (firstMsg && firstMsg !== "[object Object]") {
      html += `<div class="nr-alert">${escapeHtml(firstMsg)}</div>`;
    }
  }

  if (!services.length) {
    html += '<div class="nr-empty">No live services for this board</div>';
  } else {
    for (const svc of services.slice(0, 20)) {
      const when = NR.boardType === "arrivals" ? (svc.eta || svc.sta || "--") : (svc.etd || svc.std || "--");
      const plat = svc.platform ? `P${svc.platform}` : "--";
      const toText = NR.boardType === "arrivals"
        ? (Array.isArray(svc.origin) && svc.origin.length ? svc.origin.join(", ") : "Unknown origin")
        : (Array.isArray(svc.destination) && svc.destination.length ? svc.destination.join(", ") : "Unknown destination");
      html +=
        `<div class="nr-service" data-service-id="${escapeHtml(svc.serviceID || "")}">` +
        `<span class="nr-eta">${escapeHtml(when)}</span>` +
        `<span class="nr-plat">${escapeHtml(plat)}</span>` +
        `<span class="nr-dest">${escapeHtml(toText)}</span>` +
        `</div>`;
    }
  }
  html += `</div>`;
  wrap.innerHTML = html;

  wrap.querySelectorAll(".nr-service[data-service-id]").forEach((row) => {
    row.addEventListener("click", async () => {
      const serviceId = row.dataset.serviceId;
      if (!serviceId) return;
      try {
        const detail = await fetchServiceDetails(serviceId);
        const svc = detail?.service || {};
        const msg = [
          `Operator: ${svc.operator || "Unknown"}`,
          `STD/ETD: ${svc.std || "--"} / ${svc.etd || "--"}`,
          `STA/ETA: ${svc.sta || "--"} / ${svc.eta || "--"}`,
          svc.platform ? `Platform: ${svc.platform}` : "",
          svc.delayReason ? `Delay: ${svc.delayReason}` : "",
          svc.cancelReason ? `Cancelled: ${svc.cancelReason}` : ""
        ].filter(Boolean).join("\n");
        alert(msg || "No additional service details");
      } catch (e) {
        console.warn("Service details failed:", e);
      }
    });
  });
}

async function upsertNrStationMarker(board) {
  if (!board?.locationName || !board?.crs) return;
  if (!map.hasLayer(layers.national_rail)) return;

  let marker = NR.markers.get(board.crs);
  if (marker) {
    marker.setPopupContent(
      `<strong>${escapeHtml(board.locationName)} (${escapeHtml(board.crs)})</strong>` +
      `<div class="nr-card-meta">National Rail live board loaded</div>`
    );
    return;
  }

  const latLng = await geocodeStationName(board.locationName);
  if (!latLng) return;

  marker = L.circleMarker(latLng, {
    pane: "nrStationsPane",
    radius: 7.5,
    color: "#e0f2fe",
    fillColor: "#38bdf8",
    fillOpacity: 0.95,
    weight: 2.4,
    className: "nr-station-node"
  }).addTo(layers.national_rail);

  marker.bindPopup(
    `<strong>${escapeHtml(board.locationName)} (${escapeHtml(board.crs)})</strong>` +
    `<div class="nr-card-meta">National Rail station marker</div>`
  );
  marker.bindTooltip(`${board.locationName} (${board.crs})`, { sticky: true, direction: "top", opacity: 0.95 });
  NR.markers.set(board.crs, marker);
}

function clearNrState() {
  layers.national_rail.clearLayers();
  clearNrRoutes();
  NR.markers.clear();
  NR.serviceDetailCache.clear();
  NR.crs = "";
  NR.lastRouteSignature = "";
  const wrap = document.getElementById("nr-results");
  if (wrap) wrap.innerHTML = '<div class="nr-empty">Cleared</div>';
}

async function refreshNrBoard() {
  if (!NR.crs) return;
  try {
    const data = await fetchBoard(NR.crs, NR.boardType);
    renderNrResults(data);
    if (data?.board) {
      await upsertNrStationMarker(data.board);
      await plotNrServiceLines(data.board, data.board.services || []);
      if (data.board.locationName) {
        setStatus(`National Rail ${NR.boardType}: ${data.board.locationName} (${NR.crs})`);
      }
    }
  } catch (e) {
    console.warn("National Rail board failed:", e);
    const wrap = document.getElementById("nr-results");
    if (wrap) {
      const detail = String(e?.message || "National Rail feed unavailable");
      wrap.innerHTML = `<div class="nr-empty">${escapeHtml(detail)}</div>`;
      if (!NR.health.configured) {
        wrap.innerHTML += '<div class="nr-alert">Rail live feed credentials not configured for RailData.</div>';
      }
    }
    setStatus("National Rail fetch failed");
  }
}

function startNrPolling() {
  if (NR.timer) clearInterval(NR.timer);
  NR.timer = setInterval(() => {
    if (NR.active && NR.crs) refreshNrBoard();
  }, CONTROL_ROOM_CONFIG?.nationalRail?.refreshInterval || 60000);
}

function stopNrPolling() {
  if (NR.timer) {
    clearInterval(NR.timer);
    NR.timer = null;
  }
}

function initNationalRail() {
  const fetchBtn = document.getElementById("nr-fetch-btn");
  const refreshBtn = document.getElementById("nr-refresh-btn");
  const clearBtn = document.getElementById("nr-clear-btn");
  const crsInput = document.getElementById("nr-crs-input");
  const typeSel = document.getElementById("nr-board-type");
  const wrap = document.getElementById("nr-results");
  const layerCb = document.querySelector('[data-layer="national_rail"]');
  const rdDisruptionsBtn = document.getElementById("raildata-disruptions-btn");
  const rdPerformanceBtn = document.getElementById("raildata-performance-btn");
  const rdReferenceBtn = document.getElementById("raildata-reference-btn");
  const rdNaptanBtn = document.getElementById("raildata-naptan-btn");
  const rdNptgBtn = document.getElementById("raildata-nptg-btn");
  const rdFeedsBtn = document.getElementById("raildata-feeds-btn");
  const rdWrap = document.getElementById("raildata-results");

  if (wrap) wrap.innerHTML = '<div class="nr-empty">Enter a CRS code and fetch a live board</div>';
  if (rdWrap) rdWrap.innerHTML = '<div class="nr-empty">RailData quick checks ready</div>';
  fetchNrHealth().then((health) => {
    if (!wrap) return;
    if (!health.configured) {
      const base = String(window.__CONTROL_ROOM_API_BASE || "").trim();
      const hostedWorker = /workers\.dev/i.test(base);
      const fallback = health?.fallback || {};
      const depReady = !!fallback?.raildata_departures_ready;
      const arrReady = !!fallback?.raildata_arrivals_ready;
      const raildataState = `RailData fallback: departures ${depReady ? "ready" : "not ready"}, arrivals ${arrReady ? "ready" : "not ready"}.`;
      const hostedHint = hostedWorker
        ? "This hosted proxy currently lacks live rail endpoints. Use `http://localhost:8000` (dev proxy) or deploy worker rail routes."
        : "Set RailData live board keys (`RAILDATA_LIVE_DEPARTURE_API_KEY` / `RAILDATA_LIVE_BOARD_API_KEY`).";
      wrap.innerHTML =
        '<div class="nr-empty">Rail provider not fully configured</div>' +
        `<div class="nr-alert">API base: ${escapeHtml(base || "(unset)")}. ${escapeHtml(raildataState)} ${escapeHtml(hostedHint)} Station search still works.</div>`;
    }
  });

  if (rdDisruptionsBtn) rdDisruptionsBtn.title = "Rail disruption and incident notices";
  if (rdPerformanceBtn) rdPerformanceBtn.title = "Realtime performance for operator groups";
  if (rdReferenceBtn) rdReferenceBtn.title = "Reference entities such as stations/operators";
  if (rdNaptanBtn) rdNaptanBtn.title = "NaPTAN: National Public Transport Access Nodes (stops/stations)";
  if (rdNptgBtn) rdNptgBtn.title = "NPTG: National Public Transport Gazetteer (places/localities)";
  if (rdFeedsBtn) rdFeedsBtn.title = "Your configured RailData feed access";

  rdDisruptionsBtn?.addEventListener("click", () => runRailDataQuickCheck("/raildata/disruptions", "disruptions"));
  rdPerformanceBtn?.addEventListener("click", () => runRailDataQuickCheck("/raildata/performance?stanoxGroup=EMR", "performance"));
  rdReferenceBtn?.addEventListener("click", () => runRailDataQuickCheck("/raildata/reference?currentVersion=1.0", "reference"));
  rdNaptanBtn?.addEventListener("click", () => runRailDataQuickCheck("/raildata/naptan", "naptan"));
  rdNptgBtn?.addEventListener("click", () => runRailDataQuickCheck("/raildata/nptg", "nptg"));
  rdFeedsBtn?.addEventListener("click", () => runRailDataQuickCheck("/raildata/feeds", "feeds"));

  const runFetch = async () => {
    const crs = parseCrsFromInput(crsInput?.value || "");
    if (!/^[A-Z]{3}$/.test(crs)) {
      if (wrap) wrap.innerHTML = '<div class="nr-empty">Use a 3-letter CRS code (e.g. KGX)</div>';
      return;
    }
    const health = await fetchNrHealth();
    if (!health?.configured) {
      if (wrap) {
        const base = String(window.__CONTROL_ROOM_API_BASE || "").trim();
        wrap.innerHTML =
          '<div class="nr-empty">Live board unavailable in current proxy/environment</div>' +
          `<div class="nr-alert">Current API base: ${escapeHtml(base || "(unset)")}. ` +
          'Configure RailData on this proxy, or run the local dev proxy (`python scripts/dev_server.py`) and open from `http://localhost:8000`.</div>';
      }
      return;
    }
    NR.crs = crs;
    NR.boardType = String(typeSel?.value || "departures");
    await refreshNrBoard();
    startNrPolling();
  };

  fetchBtn?.addEventListener("click", runFetch);
  refreshBtn?.addEventListener("click", refreshNrBoard);
  clearBtn?.addEventListener("click", clearNrState);
  crsInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      runFetch();
    }
  });
  crsInput?.addEventListener("input", () => {
    const q = String(crsInput.value || "").trim();
    if (NR.stationSuggestTimer) clearTimeout(NR.stationSuggestTimer);
    NR.stationSuggestTimer = setTimeout(async () => {
      if (!q || q.length < 2) return;
      try {
        const stations = await fetchStationSuggestions(q, 20);
        hydrateCrsDatalist(stations);
      } catch (_) {
        // keep silent on suggestion failures
      }
    }, 180);
  });
  crsInput?.addEventListener("change", () => {
    const raw = String(crsInput.value || "").trim();
    const key = raw.toUpperCase();
    const st = NR.stationLookupByKey.get(key);
    if (st?.crs) crsInput.value = st.crs;
  });
  typeSel?.addEventListener("change", () => {
    NR.boardType = String(typeSel.value || "departures");
    if (NR.crs) refreshNrBoard();
  });

  layerCb?.addEventListener("change", () => {
    NR.active = !!layerCb.checked;
    if (!NR.active) {
      stopNrPolling();
    } else {
      startNrPolling();
      if (NR.crs) refreshNrBoard();
    }
  });

  fetchStationSuggestions("", 30)
    .then((stations) => hydrateCrsDatalist(stations))
    .catch(() => {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initNationalRail);
} else {
  initNationalRail();
}
