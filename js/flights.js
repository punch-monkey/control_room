// ================== FLIGHTS_STATE.js ==================
// FlightRadar24-first live flight tracking

const FLIGHTS_STATE = {
  timer: null,
  lastFetch: 0,
  flightCount: 0,
  active: false,        // tracks whether the layer is enabled
  trails: new Map(),    // icao24 -> [{lat,lon,ts}]
  snapshot: null,
  flightsCache: [],
  filters: { passengerLargeOnly: true, ukNexusOnly: true },
  markerByIcao: new Map(),
  lastData: null,
  selectedRouteLine: null,
  selectedRouteMarkers: [],
  scheduleCache: new Map(),
  detailPanelEl: null,
  detailDrag: null,
  suppressNextMapClick: false,
  mapDeselectHooked: false
};

const UK_COUNTRY_KEYS = ["UNITED KINGDOM", "UK", "GREAT BRITAIN", "ENGLAND", "SCOTLAND", "WALES", "NORTHERN IRELAND"];
const UK_AIRPORT_IATA = new Set([
  "LHR","LGW","STN","LTN","LCY","SEN","MAN","BHX","BRS","LPL","NCL","EMA","NQY","EXT","SOU","BOH","NWI","MME","LBA","HUY","CWL",
  "EDI","GLA","ABZ","INV","PIK","DND",
  "BFS","BHD",
  "IOM","JER","GCI"
]);
const MILITARY_CALLSIGN_PREFIXES = ["RRR", "RCH", "ASY", "NATO", "QID", "MMF", "IAM", "CFC", "HAF", "BAF", "FAF", "USAF", "RAF"];
const ADSB_LARGE_OR_HEAVY = new Set([3, 4, 5]);

function flightDirectionClass(flight) {
  const originCode = String(flight?.originAirport?.iata || flight?.originAirport?.icao || flight?.origin || "")
    .trim()
    .toUpperCase();
  const destCode = String(flight?.destinationAirport?.iata || flight?.destinationAirport?.icao || flight?.destination || "")
    .trim()
    .toUpperCase();
  if (flight?.onGround) return "flight-ground";
  if (destCode && UK_AIRPORT_IATA.has(destCode)) return "flight-inbound";
  if (originCode && UK_AIRPORT_IATA.has(originCode)) return "flight-outbound";
  return "flight-transit";
}

function flightIconSvg(style = "plane") {
  if (style === "chevron") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18-10-5-10 5 10-18z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.6 0 1 .4 1 1v7.1l7.4 3.3c.5.2.8.7.7 1.2l-.3 1.4c-.1.6-.7 1-1.3.8l-6.5-1.7v3.9l2 1.5c.3.2.5.6.5 1v.8c0 .6-.5 1-1.1.9L12 22l-2.9.9c-.6.1-1.1-.3-1.1-.9v-.8c0-.4.2-.8.5-1l2-1.5v-3.9l-6.5 1.7c-.6.2-1.2-.2-1.3-.8l-.3-1.4c-.1-.5.2-1 .7-1.2L10.9 10.1V3c0-.6.4-1 1-1z"/></svg>';
}

function createFlightRefIcon(flight) {
  const rot = Number.isFinite(Number(flight?.track)) ? Number(flight.track) : 0;
  const cls = flightDirectionClass(flight);
  const html =
    `<div class="flight-icon ${cls}" style="--flight-icon-size:18px">` +
      `<span class="flight-inner" style="transform:rotate(${rot}deg)">` +
        `${flightIconSvg("plane")}` +
      `</span>` +
    `</div>`;
  return L.divIcon({
    className: "flight-marker",
    html,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -12]
  });
}

function isMilitaryFlightByCallsign(callsign) {
  const cs = String(callsign || "").trim().toUpperCase();
  if (!cs) return false;
  return MILITARY_CALLSIGN_PREFIXES.some((p) => cs.startsWith(p));
}

function isUkCountry(value) {
  const v = String(value || "").trim().toUpperCase();
  if (!v) return false;
  return UK_COUNTRY_KEYS.some((k) => v.includes(k));
}

function parseEmitterCategory(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function looksLikeTailRegistration(callsign) {
  const cs = String(callsign || "").trim().toUpperCase();
  if (!cs) return false;
  return (
    /^N\d+[A-Z]{0,2}$/.test(cs) ||
    /^G-[A-Z]{4}$/.test(cs) ||
    /^[A-Z]-[A-Z]{4}$/.test(cs)
  );
}

function looksLikeAirlineCallsign(callsign) {
  const cs = String(callsign || "").trim().toUpperCase();
  if (!cs || looksLikeTailRegistration(cs)) return false;
  return /^[A-Z]{2,3}\d{2,4}[A-Z]?$/.test(cs);
}

function isLikelyPassengerOrLarge(flight) {
  if (!flight) return false;
  if (isMilitaryFlightByCallsign(flight.callsign)) return false;
  const cat = parseEmitterCategory(flight.emitterCategory);
  if (cat != null && ADSB_LARGE_OR_HEAVY.has(cat)) return true;
  return looksLikeAirlineCallsign(flight.callsign);
}

function hasUkNexus(flight) {
  if (!flight) return false;
  const lat = Number(flight.lat);
  const lon = Number(flight.lon);
  // UK + near-coast corridor. Includes aircraft currently over Britain even if route metadata is sparse.
  const inUkAirspace = Number.isFinite(lat) && Number.isFinite(lon) && lat >= 49.3 && lat <= 61.3 && lon >= -9.8 && lon <= 2.8;
  if (inUkAirspace) return true;
  const originCode = String(flight.origin || "").trim().toUpperCase();
  const destCode = String(flight.destination || "").trim().toUpperCase();
  if (originCode && UK_AIRPORT_IATA.has(originCode)) return true;
  if (destCode && UK_AIRPORT_IATA.has(destCode)) return true;
  if (isUkCountry(flight.originAirport?.country)) return true;
  if (isUkCountry(flight.destinationAirport?.country)) return true;
  return false;
}

function classifyFlightType(flight) {
  if (!flight) return { code: "international", label: "International" };
  if (isMilitaryFlightByCallsign(flight.callsign)) return { code: "military", label: "Military" };
  const originCountry = String(flight.originAirport?.country || "");
  const destCountry = String(flight.destinationAirport?.country || "");
  if (originCountry && destCountry) {
    if (originCountry.toUpperCase() === destCountry.toUpperCase()) {
      if (isUkCountry(originCountry) && isUkCountry(destCountry)) {
        return { code: "domestic", label: "Domestic (UK)" };
      }
      return { code: "domestic", label: "Domestic" };
    }
    return { code: "international", label: "International" };
  }
  if (isUkCountry(originCountry) || isUkCountry(destCountry)) {
    return { code: "domestic", label: "Domestic / UK-linked" };
  }
  return { code: "international", label: "International" };
}

function formatFeet(metres) {
  if (!Number.isFinite(metres)) return "N/A";
  return `${Math.round(metres * 3.28084).toLocaleString("en-GB")} ft`;
}

function formatKnots(ms) {
  if (!Number.isFinite(ms)) return "N/A";
  return `${Math.round(ms * 1.94384)} kts`;
}

function getTrend(vertRate) {
  if (!Number.isFinite(vertRate)) return "L";
  if (vertRate > 1.3) return "UP";
  if (vertRate < -1.3) return "DOWN";
  return "LVL";
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function projectLatLon(lat, lon, bearingDeg, km) {
  const R = 6371;
  const brng = (bearingDeg * Math.PI) / 180;
  const dR = km / R;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(dR) * Math.cos(lat1),
      Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
}

function nearestAirport(lat, lon, maxKm = 180) {
  const idx = window.AIRPORT_INDEX;
  if (!idx || !Array.isArray(idx.all) || !idx.all.length) return null;
  const pool = idx.all;
  let best = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const ap of pool) {
    if (!Number.isFinite(ap.lat) || !Number.isFinite(ap.lon)) continue;
    const d = haversineKm(lat, lon, ap.lat, ap.lon);
    if (d < bestD) {
      bestD = d;
      best = ap;
    }
  }
  if (!best || bestD > maxKm) return null;
  return { ...best, distanceKm: bestD };
}

function airportText(ap) {
  if (!ap) return "";
  return [ap.iata, ap.icao, ap.name, ap.city, ap.country].filter(Boolean).join(" ");
}

function airportCode(ap) {
  if (!ap) return "N/A";
  return (ap.iata && ap.iata !== "N/A") ? ap.iata : (ap.icao || "N/A");
}

function airportLabel(ap) {
  if (!ap) return "Unknown";
  return `${ap.name || "Unknown"} (${airportCode(ap)})`;
}

function airportLogoPath(ap) {
  const path = String(ap?.logoPath || "").trim();
  return path || "";
}

function findAirportByRef(ref) {
  const q = String(ref || "").trim();
  if (!q) return null;
  const idx = window.AIRPORT_INDEX;
  if (!idx || !Array.isArray(idx.all)) return null;

  const upper = q.toUpperCase();
  if (idx.byIata?.[upper]) return idx.byIata[upper];
  if (idx.byIcao?.[upper]) return idx.byIcao[upper];

  const norm = q.toLowerCase();
  let best = null;
  for (const ap of idx.all) {
    const name = String(ap?.name || "").toLowerCase();
    if (!name) continue;
    if (name === norm) return ap;
    if (name.includes(norm) || norm.includes(name)) {
      best = ap;
    }
  }
  return best;
}

function flightPrimaryId(f) {
  const cs = String(f?.callsign || "").trim().toUpperCase();
  if (cs) return cs;
  const icao = String(f?.icao24 || "").trim().toUpperCase();
  return icao || "UNKNOWN";
}

function hasActiveFlightFilters() {
  const f = FLIGHTS_STATE.filters || {};
  return !!(
    String(f.airport || "").trim() ||
    String(f.origin || "").trim() ||
    String(f.destination || "").trim() ||
    String(f.aircraft || "").trim() ||
    String(f.flightNumber || "").trim() ||
    String(f.fromTime || "").trim() ||
    String(f.toTime || "").trim() ||
    !f.passengerLargeOnly ||
    !f.ukNexusOnly
  );
}

function formatFlightTime(ts) {
  if (!Number.isFinite(ts)) return "N/A";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatOpsTimeLabel(v) {
  if (!v) return "Unknown";
  if (Number.isFinite(v)) {
    const epoch = v > 1e12 ? v : v * 1000;
    return formatFlightTime(epoch);
  }
  const asNum = Number(v);
  if (Number.isFinite(asNum)) {
    const epoch = asNum > 1e12 ? asNum : asNum * 1000;
    return formatFlightTime(epoch);
  }
  const n = Date.parse(String(v));
  if (Number.isFinite(n)) return formatFlightTime(n);
  return "Unknown";
}

async function fetchFlightScheduleHints(flight) {
  const callsign = String(flight?.callsign || "").trim().toUpperCase();
  const icao24 = String(flight?.icao24 || "").trim().toLowerCase();
  if (!callsign && !icao24) return null;
  const key = `${callsign}|${icao24}`;
  const cached = FLIGHTS_STATE.scheduleCache.get(key);
  if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
    return cached.data;
  }

  const q = new URLSearchParams();
  if (callsign) q.set("callsign", callsign);
  if (icao24) q.set("icao24", icao24);
  try {
    const r = await fetch(apiUrl(`/flight/schedule?${q.toString()}`), { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const data = await r.json();
    FLIGHTS_STATE.scheduleCache.set(key, { ts: Date.now(), data });
    return data;
  } catch (_) {
    return null;
  }
}

function buildPlanePopupHtml(flight, trail, schedule = null, routeCtx = null, details = null) {
  const idLabel = flightPrimaryId(flight);
  const originAp = routeCtx?.originAirport || flight.originAirport || null;
  const destAp = routeCtx?.destinationAirport || flight.destinationAirport || null;
  const depCode = String(originAp?.iata || originAp?.icao || "UNK").toUpperCase();
  const arrCode = String(destAp?.iata || destAp?.icao || "UNK").toUpperCase();
  const depAirport = originAp?.name || "Unknown";
  const arrAirport = destAp?.name || "Unknown";
  const depLogo = airportLogoPath(originAp);
  const arrLogo = airportLogoPath(destAp);
  const depTime = formatOpsTimeLabel(schedule?.flight?.departure?.actual || schedule?.flight?.departure?.scheduled || schedule?.flight?.departure?.estimated || null);
  const arrTime = formatOpsTimeLabel(schedule?.flight?.arrival?.actual || schedule?.flight?.arrival?.estimated || schedule?.flight?.arrival?.scheduled || null);
  const depShown = depTime === "Unknown" ? "N/A" : depTime;
  const arrShown = arrTime === "Unknown" ? "N/A" : arrTime;
  const status = String(schedule?.flight?.status || details?.status?.text || "").trim() || (flight?.onGround ? "GROUND" : "AIR");
  const subhead = [`DEP ${depShown}`, `ARR ${arrShown}`].join(" â€¢ ");
  const carrier = String(details?.airline?.name || details?.airline?.short || flight?.airline || "N/A");
  const aircraftModel = String(details?.aircraft?.model?.text || flight?.aircraft || "N/A");
  const routeTrack = Array.isArray(trail) && trail.length >= 2 ? `${trail.length} points` : "No trail yet";
  const altitudeText = Number.isFinite(flight?.alt) ? formatFeet(flight.alt) : "N/A";
  const speedText = Number.isFinite(flight?.speed) ? formatKnots(flight.speed) : "N/A";
  const metaLine = `ALT ${altitudeText} â€¢ SPD ${speedText}`;
  const routeLogosHtml =
    depLogo || arrLogo
      ? (
        `<div class="fb-route-logos">` +
          (depLogo ? `<img class="fb-airport-logo" src="${escapeHtml(depLogo)}" alt="${escapeHtml(depAirport)} logo" loading="lazy">` : `<span class="fb-airport-code">${escapeHtml(depCode)}</span>`) +
          `<span class="fb-route-arrow">â†’</span>` +
          (arrLogo ? `<img class="fb-airport-logo" src="${escapeHtml(arrLogo)}" alt="${escapeHtml(arrAirport)} logo" loading="lazy">` : `<span class="fb-airport-code">${escapeHtml(arrCode)}</span>`) +
        `</div>`
      )
      : "";

  return (
    `<div class="flight-board">` +
      `<div class="fb-head">` +
        `<span class="fb-title-text">${escapeHtml(`${depCode} -> ${arrCode} â€¢ ${idLabel}`)}</span>` +
        `<span class="fb-status">${escapeHtml(status)}</span>` +
      `</div>` +
      routeLogosHtml +
      `<div class="fb-subhead">${escapeHtml(subhead)}</div>` +
      `<div class="fb-meta">` +
        `<span>${escapeHtml(metaLine)}</span>` +
        `<span class="fb-carrier">${escapeHtml(carrier)}</span>` +
      `</div>` +
      `<div class="fb-table">` +
        `<div class="fb-row fb-row-data"><div class="fb-row-head">DEPARTURE</div><div>${escapeHtml(depAirport)}</div></div>` +
        `<div class="fb-row fb-row-data"><div class="fb-row-head">ARRIVAL</div><div>${escapeHtml(arrAirport)}</div></div>` +
        `<div class="fb-row fb-row-data"><div class="fb-row-head">CARRIER</div><div>${escapeHtml(carrier)}</div></div>` +
        `<div class="fb-row fb-row-data"><div class="fb-row-head">PLANE</div><div>${escapeHtml(aircraftModel)}</div></div>` +
        `<div class="fb-row fb-row-data"><div class="fb-row-head">TRACK</div><div>${escapeHtml(routeTrack)}</div></div>` +
      `</div>` +
      `<div class="cp-btn-row" style="margin-top:8px;">` +
        `<button id="flight-promote-entity-btn" class="popup-psc-btn" type="button">Add As Entity</button>` +
      `</div>` +
    `</div>`
  );
}

function getAircraftEntityIconData() {
  const cat = ICON_CATEGORIES?.aviation || {};
  const icons = Array.isArray(cat.icons) ? cat.icons : [];
  const chosen = icons.find((i) => i?.id === "aircraft") || icons[0] || {
    id: "aircraft",
    name: "Aircraft",
    icon: "gfx/map_icons/email/paper_plane.png"
  };
  return {
    ...chosen,
    categoryColor: cat.color || "#38bdf8",
    categoryName: cat.name || "Aviation"
  };
}

function buildFlightI2EntityData(flight, routeCtx = null) {
  const values = [];
  const idLabel = flightPrimaryId(flight);
  const dep = routeCtx?.originAirport || flight?.originAirport || null;
  const arr = routeCtx?.destinationAirport || flight?.destinationAirport || null;
  const depRef = String(dep?.iata || dep?.icao || flight?.origin || "").toUpperCase();
  const arrRef = String(arr?.iata || arr?.icao || flight?.destination || "").toUpperCase();
  if (idLabel) values.push({ propertyName: "Registration Mark", value: String(idLabel) });
  if (flight?.icao24) values.push({ propertyName: "ICAO24", value: String(flight.icao24).toUpperCase() });
  if (flight?.aircraft) values.push({ propertyName: "Type", value: String(flight.aircraft) });
  if (flight?.airline) values.push({ propertyName: "Operator", value: String(flight.airline) });
  if (depRef) values.push({ propertyName: "Origin", value: depRef });
  if (arrRef) values.push({ propertyName: "Destination", value: arrRef });
  if (Number.isFinite(flight?.alt)) values.push({ propertyName: "Altitude", value: formatFeet(flight.alt) });
  if (Number.isFinite(flight?.speed)) values.push({ propertyName: "Speed", value: formatKnots(flight.speed) });
  return {
    entityId: "AIRCRAFT",
    entityName: "Aircraft",
    values
  };
}

function addLiveFlightAsEntity(flight, routeCtx = null) {
  if (!flight || typeof placeEntity !== "function") return null;
  const lat = Number(flight?.lat);
  const lon = Number(flight?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const idLabel = flightPrimaryId(flight);
  const dep = routeCtx?.originAirport || flight?.originAirport || null;
  const arr = routeCtx?.destinationAirport || flight?.destinationAirport || null;
  const depRef = String(dep?.iata || dep?.icao || flight?.origin || "").toUpperCase();
  const arrRef = String(arr?.iata || arr?.icao || flight?.destination || "").toUpperCase();
  const routeText = (depRef || arrRef) ? `${depRef || "UNK"} -> ${arrRef || "UNK"}` : "Unknown route";
  const label = idLabel || `Flight ${depRef || arrRef || "UNK"}`;
  const notes = `Live Flight | ${routeText}`;
  const iconData = getAircraftEntityIconData();
  const i2EntityData = buildFlightI2EntityData(flight, routeCtx);
  const entityId = placeEntity([lat, lon], iconData, label, "", notes, i2EntityData);
  if (entityId && typeof setStatus === "function") {
    setStatus(`Live flight added as entity: ${label}. Use Connect in the entity popup.`);
  }
  return entityId;
}

function ensureFlightDetailPanel() {
  if (FLIGHTS_STATE.detailPanelEl) return FLIGHTS_STATE.detailPanelEl;
  const panel = document.createElement("div");
  panel.id = "flight-detail-panel";
  panel.className = "flight-detail-panel";
  panel.style.display = "none";
  panel.innerHTML =
    `<div class="flight-detail-header">` +
      `<span id="flight-detail-title">Flight Detail</span>` +
      `<button type="button" id="flight-detail-close" class="flight-detail-close">x</button>` +
    `</div>` +
    `<div id="flight-detail-body" class="flight-detail-body"></div>`;
  document.body.appendChild(panel);
  FLIGHTS_STATE.detailPanelEl = panel;

  const closeBtn = panel.querySelector("#flight-detail-close");
  closeBtn?.addEventListener("click", () => {
    clearFlightSelection();
  });

  const header = panel.querySelector(".flight-detail-header");
  header?.addEventListener("mousedown", (e) => {
    FLIGHTS_STATE.detailDrag = {
      x: e.clientX - panel.offsetLeft,
      y: e.clientY - panel.offsetTop
    };
  });
  document.addEventListener("mousemove", (e) => {
    if (!FLIGHTS_STATE.detailDrag || panel.style.display === "none") return;
    panel.style.left = `${Math.max(8, e.clientX - FLIGHTS_STATE.detailDrag.x)}px`;
    panel.style.top = `${Math.max(8, e.clientY - FLIGHTS_STATE.detailDrag.y)}px`;
    panel.style.right = "auto";
  });
  document.addEventListener("mouseup", () => {
    FLIGHTS_STATE.detailDrag = null;
  });
  return panel;
}

function ensureFlightInfoPanel() {
  let panel = document.getElementById("flight-info");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "flight-info";
  panel.className = "flight-info-panel";
  panel.style.display = "none";
  panel.innerHTML =
    `<div class="flight-info-header">` +
      `<span>Live Flights</span>` +
      `<button type="button" id="flight-refresh-btn" class="flight-refresh-btn">Refresh</button>` +
      `<span id="flight-info-time" class="flight-info-time"></span>` +
    `</div>` +
    `<div id="flight-stats" class="flight-stats">` +
      `<span class="flight-info-text">Enable layer to track aircraft</span>` +
    `</div>`;

  const mapEl = document.getElementById("map");
  if (mapEl && mapEl.parentElement) {
    mapEl.parentElement.appendChild(panel);
  } else {
    document.body.appendChild(panel);
  }
  return panel;
}

function openFlightDetailPanel(flight, trail, schedule = null, routeCtx = null, details = null) {
  const panel = ensureFlightDetailPanel();
  const title = panel.querySelector("#flight-detail-title");
  const body = panel.querySelector("#flight-detail-body");
  if (title) title.textContent = flightPrimaryId(flight);
  if (body) body.innerHTML = buildPlanePopupHtml(flight, trail, schedule, routeCtx, details);
  const addEntityBtn = panel.querySelector("#flight-promote-entity-btn");
  addEntityBtn?.addEventListener("click", () => {
    addLiveFlightAsEntity(flight, routeCtx);
  });
  if (!panel.style.left) {
    panel.style.right = "12px";
    panel.style.top = "88px";
  }
  panel.style.display = "";
}

function clearSelectedFlightRoute() {
  if (FLIGHTS_STATE.selectedRouteLine) {
    try { layers.flights.removeLayer(FLIGHTS_STATE.selectedRouteLine); } catch (_) {}
    FLIGHTS_STATE.selectedRouteLine = null;
  }
  if (Array.isArray(FLIGHTS_STATE.selectedRouteMarkers) && FLIGHTS_STATE.selectedRouteMarkers.length) {
    for (const m of FLIGHTS_STATE.selectedRouteMarkers) {
      try { layers.flights.removeLayer(m); } catch (_) {}
    }
  }
  FLIGHTS_STATE.selectedRouteMarkers = [];
}

function clearFlightSelection() {
  clearSelectedFlightRoute();
  if (FLIGHTS_STATE.detailPanelEl) FLIGHTS_STATE.detailPanelEl.style.display = "none";
}

function getRouteContextFromSchedule(flight, schedule) {
  const dep = schedule?.flight?.departure || {};
  const arr = schedule?.flight?.arrival || {};
  const depRef = dep?.iata || dep?.icao || dep?.airport || "";
  const arrRef = arr?.iata || arr?.icao || arr?.airport || "";
  const originAirport = findAirportByRef(depRef) || flight.originAirport || null;
  const destinationAirport = findAirportByRef(arrRef) || flight.destinationAirport || null;
  return { originAirport, destinationAirport };
}

function drawSelectedFlightRoute(flight, routeCtx = null) {
  clearSelectedFlightRoute();
  if (!flight) return;
  const trailPoints = Array.isArray(routeCtx?.trailPoints) ? routeCtx.trailPoints : [];
  if (trailPoints.length >= 2) {
    const classCode = flight?.classification?.code || "international";
    const routeColor = classCode === "military" ? "#ef4444" : (classCode === "domestic" ? "#22c55e" : "#38bdf8");
    FLIGHTS_STATE.selectedRouteLine = L.polyline(
      trailPoints,
      {
        color: routeColor,
        weight: 3,
        opacity: 0.92,
        dashArray: "10 7",
        className: "flight-trail"
      }
    ).addTo(layers.flights);
    return;
  }
  const from = routeCtx?.originAirport || flight.originAirport;
  const to = routeCtx?.destinationAirport || flight.destinationAirport;
  const hasPlanePoint = Number.isFinite(flight.lat) && Number.isFinite(flight.lon);
  const classCode = flight?.classification?.code || "international";
  const routeColor = classCode === "military" ? "#ef4444" : (classCode === "domestic" ? "#22c55e" : "#38bdf8");
  if (!from || !to || !Number.isFinite(from.lat) || !Number.isFinite(from.lon) || !Number.isFinite(to.lat) || !Number.isFinite(to.lon)) {
    return;
  }

  const points = hasPlanePoint
    ? [[from.lat, from.lon], [flight.lat, flight.lon], [to.lat, to.lon]]
    : [[from.lat, from.lon], [to.lat, to.lon]];

  FLIGHTS_STATE.selectedRouteLine = L.polyline(
    points,
    {
      color: routeColor,
      weight: 3,
      opacity: 0.92,
      dashArray: "10 7",
      className: "flight-trail"
    }
  ).addTo(layers.flights);

  const start = L.circleMarker([from.lat, from.lon], {
    radius: 5,
    color: "#22c55e",
    fillColor: "#22c55e",
    fillOpacity: 0.9,
    weight: 2
  }).addTo(layers.flights).bindTooltip(`Origin: ${airportLabel(from)}`, { direction: "top", opacity: 0.95 });

  const end = L.circleMarker([to.lat, to.lon], {
    radius: 5,
    color: "#ef4444",
    fillColor: "#ef4444",
    fillOpacity: 0.9,
    weight: 2
  }).addTo(layers.flights).bindTooltip(`Destination: ${airportLabel(to)}`, { direction: "top", opacity: 0.95 });

  FLIGHTS_STATE.selectedRouteMarkers = [start, end];
  if (hasPlanePoint) {
    const current = L.circleMarker([flight.lat, flight.lon], {
      radius: 4,
      color: "#facc15",
      fillColor: "#facc15",
      fillOpacity: 0.95,
      weight: 2
    }).addTo(layers.flights).bindTooltip(`Current: ${flightPrimaryId(flight)}`, { direction: "top", opacity: 0.95 });
    FLIGHTS_STATE.selectedRouteMarkers.push(current);
  }
}

function inferAirportsForFlight(flight, trail) {
  if (!flight) return { originAirport: null, destinationAirport: null };
  const oldest = Array.isArray(trail) && trail.length ? trail[0] : null;
  const newest = Array.isArray(trail) && trail.length ? trail[trail.length - 1] : null;
  const originAirport = oldest ? nearestAirport(oldest.lat, oldest.lon, 320) : nearestAirport(flight.lat, flight.lon, 220);

  let projected = null;
  if (Number.isFinite(flight.track)) {
    projected = projectLatLon(flight.lat, flight.lon, flight.track, 120);
  }
  let destinationAirport = projected ? nearestAirport(projected.lat, projected.lon, 320) : null;
  if (!destinationAirport && newest) destinationAirport = nearestAirport(newest.lat, newest.lon, 280);
  if (Number.isFinite(flight.alt) && flight.alt < 1600) {
    const nearNow = nearestAirport(flight.lat, flight.lon, 120);
    if (nearNow) destinationAirport = nearNow;
  }
  return { originAirport, destinationAirport };
}

function timeOfDayMins(ts) {
  const d = new Date(ts || Date.now());
  return d.getHours() * 60 + d.getMinutes();
}

function parseTimeInputMins(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function matchesAirportQuery(ap, q) {
  if (!q) return true;
  if (!ap) return false;
  return airportText(ap).toLowerCase().includes(q.toLowerCase());
}

function flightMatchesFilters(f, filters) {
  if (!filters) return true;
  const anyAirport = String(filters.airport || "").trim().toLowerCase();
  const origin = String(filters.origin || "").trim().toLowerCase();
  const dest = String(filters.destination || "").trim().toLowerCase();
  const aircraft = String(filters.aircraft || "").trim().toLowerCase();
  const flightNo = String(filters.flightNumber || "").trim().toLowerCase();
  const fromMins = parseTimeInputMins(filters.fromTime);
  const toMins = parseTimeInputMins(filters.toTime);
  const passengerLargeOnly = filters.passengerLargeOnly !== false;
  const ukNexusOnly = filters.ukNexusOnly !== false;

  if (passengerLargeOnly && !isLikelyPassengerOrLarge(f)) return false;
  if (ukNexusOnly && !hasUkNexus(f)) return false;

  if (anyAirport) {
    const hitAny =
      matchesAirportQuery(f.originAirport, anyAirport) ||
      matchesAirportQuery(f.destinationAirport, anyAirport);
    if (!hitAny) return false;
  }
  if (origin && !matchesAirportQuery(f.originAirport, origin)) return false;
  if (dest && !matchesAirportQuery(f.destinationAirport, dest)) return false;
  if (aircraft && !String(f.icao24 || "").toLowerCase().includes(aircraft)) return false;
  if (flightNo && !String(f.callsign || "").toLowerCase().includes(flightNo)) return false;

  if (fromMins != null || toMins != null) {
    const t = timeOfDayMins(f.lastSeen || Date.now());
    if (fromMins != null && toMins != null) {
      if (fromMins <= toMins) {
        if (t < fromMins || t > toMins) return false;
      } else {
        if (!(t >= fromMins || t <= toMins)) return false;
      }
    } else if (fromMins != null) {
      if (t < fromMins) return false;
    } else if (toMins != null) {
      if (t > toMins) return false;
    }
  }
  return true;
}

function currentFlightFiltersFromUi() {
  return {
    airport: document.getElementById("flight-airport-q")?.value || "",
    origin: document.getElementById("flight-origin-q")?.value || "",
    destination: document.getElementById("flight-destination-q")?.value || "",
    aircraft: document.getElementById("flight-aircraft-q")?.value || "",
    flightNumber: document.getElementById("flight-number-q")?.value || "",
    fromTime: document.getElementById("flight-time-from")?.value || "",
    toTime: document.getElementById("flight-time-to")?.value || "",
    passengerLargeOnly: document.getElementById("flight-passenger-large-only")?.checked !== false,
    ukNexusOnly: true
  };
}

function focusFlight(icao24) {
  const key = String(icao24 || "").trim().toLowerCase();
  if (!key) return;
  const marker = FLIGHTS_STATE.markerByIcao.get(key);
  if (marker) {
    map.panTo(marker.getLatLng(), { animate: true, duration: 0.45 });
    marker.openPopup();
    return;
  }

  const flight = FLIGHTS_STATE.flightsCache.find((f) => String(f.icao24 || "").toLowerCase() === key);
  if (flight) {
    map.panTo([flight.lat, flight.lon], { animate: true, duration: 0.45 });
  }
}

function renderFlightFilterResults() {
  const wrap = document.getElementById("flight-filter-results");
  if (!wrap) return;

  const active = hasActiveFlightFilters();
  if (!FLIGHTS_STATE.active && !active) {
    wrap.innerHTML = `<div class="flight-filter-item">Enable Live Flights to search active aircraft.</div>`;
    return;
  }

  const list = (FLIGHTS_STATE.flightsCache || []).filter((f) => flightMatchesFilters(f, FLIGHTS_STATE.filters));
  if (!list.length) {
    wrap.innerHTML = `<div class="flight-filter-item">No matching flights.</div>`;
    return;
  }

  const top = list.slice(0, 40);
  wrap.innerHTML = top
    .map((f) => {
      const id = flightPrimaryId(f);
      const classInfo = f.classification || classifyFlightType(f);
      const route = `${airportCode(f.originAirport)} -> ${airportCode(f.destinationAirport)}`;
      return (
        `<button class="flight-filter-item flight-filter-hit" type="button" data-icao="${escapeHtml(String(f.icao24 || ""))}">` +
          `<strong>${escapeHtml(id)}</strong> ` +
          `<span>${escapeHtml(route)}</span> ` +
          `<span>${escapeHtml(classInfo.label)}</span> ` +
          `<span>${escapeHtml(formatFeet(f.alt))}</span>` +
        `</button>`
      );
    })
    .join("");

  wrap.querySelectorAll(".flight-filter-hit").forEach((btn) => {
    btn.addEventListener("click", () => focusFlight(btn.dataset.icao || ""));
  });
}

function applyFlightFilters() {
  FLIGHTS_STATE.filters = currentFlightFiltersFromUi();
  if (FLIGHTS_STATE.lastData) {
    renderFlights(FLIGHTS_STATE.lastData);
  } else {
    renderFlightFilterResults();
  }
}

function clearFlightFilters() {
  const ids = [
    "flight-airport-q",
    "flight-origin-q",
    "flight-destination-q",
    "flight-aircraft-q",
    "flight-number-q",
    "flight-time-from",
    "flight-time-to"
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const focusFilter = document.getElementById("flight-passenger-large-only");
  if (focusFilter) focusFilter.checked = true;
  FLIGHTS_STATE.filters = { passengerLargeOnly: true, ukNexusOnly: true };
  if (FLIGHTS_STATE.lastData) {
    renderFlights(FLIGHTS_STATE.lastData);
  } else {
    renderFlightFilterResults();
  }
}

function buildAirportIntelPopup(airport) {
  if (!airport) return "";
  const flights = Array.isArray(FLIGHTS_STATE.flightsCache) ? FLIGHTS_STATE.flightsCache : [];
  const around = flights
    .map((f) => ({ f, d: haversineKm(airport.lat, airport.lon, f.lat, f.lon) }))
    .filter((x) => Number.isFinite(x.d) && x.d <= 140)
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  const inbound = flights.filter((f) => {
    const ap = f.destinationAirport;
    if (!ap) return false;
    return (
      (ap.icao && airport.icao && ap.icao === airport.icao) ||
      (ap.iata && airport.iata && ap.iata === airport.iata)
    );
  }).length;
  const outbound = flights.filter((f) => {
    const ap = f.originAirport;
    if (!ap) return false;
    return (
      (ap.icao && airport.icao && ap.icao === airport.icao) ||
      (ap.iata && airport.iata && ap.iata === airport.iata)
    );
  }).length;

  const rows = around.length
    ? around
        .map((x) => {
          const f = x.f;
          return (
            `<div class="flight-track-item">` +
              `<span>${escapeHtml(flightPrimaryId(f))}</span>` +
              `<span>${escapeHtml(formatFeet(f.alt))} | ${x.d.toFixed(1)} km</span>` +
            `</div>`
          );
        })
        .join("")
    : `<div class="flight-info-text">No nearby airborne traffic in current refresh window.</div>`;

  const logoPath = String(airport.logoPath || "");
  const logoBlock = logoPath
    ? (
        `<div class="airport-logo-popup-wrap">` +
          `<img class="airport-logo-popup" src="${escapeHtml(logoPath)}" alt="${escapeHtml(airport.name || "Airport logo")}" loading="lazy">` +
        `</div>`
      )
    : "";

  return (
    `<div class="airport-intel-popup">` +
      logoBlock +
      `<strong>${escapeHtml(airport.name || "Airport")}</strong>` +
      `<div class="flight-intel-meta">` +
        `<span class="popup-label">ICAO</span> ${escapeHtml(airport.icao || "N/A")} | ` +
        `<span class="popup-label">IATA</span> ${escapeHtml(airport.iata || "N/A")}<br>` +
        `<span class="popup-label">Country</span> ${escapeHtml(airport.country || "Unknown")}<br>` +
        `<span class="popup-label">Inbound</span> ${inbound} &nbsp;&nbsp; <span class="popup-label">Outbound</span> ${outbound}` +
      `</div>` +
      `<div class="flight-tracklist">` +
        `<div class="flight-track-title">Nearby Aircraft</div>` +
        rows +
      `</div>` +
    `</div>`
  );
}

window.buildAirportIntelPopup = buildAirportIntelPopup;
window.focusFlightIcao = focusFlight;

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// ALTITUDE -> COLOUR
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// API FETCH
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

function getFlightFetchBounds() {
  const bb = { ...CONTROL_ROOM_CONFIG.FLIGHTS_STATE.bbox };
  if (typeof map !== "undefined" && map && typeof map.getBounds === "function") {
    try {
      const b = map.getBounds().pad(0.18);
      bb.lamin = Math.max(-85, Number(b.getSouth()) || bb.lamin);
      bb.lamax = Math.min(85, Number(b.getNorth()) || bb.lamax);
      bb.lomin = Math.max(-180, Number(b.getWest()) || bb.lomin);
      bb.lomax = Math.min(180, Number(b.getEast()) || bb.lomax);
    } catch (_) {
      // Keep configured fallback bbox
    }
  }
  return bb;
}

async function fetchFlightRadarFeed() {
  const bb = getFlightFetchBounds();
  const q = new URLSearchParams({
    n: String(bb.lamax),
    s: String(bb.lamin),
    w: String(bb.lomin),
    e: String(bb.lomax),
    ukOnly: FLIGHTS_STATE.filters?.ukNexusOnly ? "1" : "0"
  });
  const resp = await fetch(apiUrl(`/api/flightradar/flights?${q.toString()}`), {
    headers: { Accept: "application/json" }
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`FR24 HTTP ${resp.status}${body ? ` - ${body.slice(0, 120)}` : ""}`);
  }
  return resp.json();
}

async function fetchFlightRadarDetails(flightId) {
  const fid = String(flightId || "").trim();
  if (!fid) return null;
  try {
    const q = new URLSearchParams({ id: fid, trail: "1" });
    const resp = await fetch(apiUrl(`/api/flightradar/flight?${q.toString()}`), {
      headers: { Accept: "application/json" }
    });
    if (!resp.ok) return null;
    const payload = await resp.json();
    return payload?.ok ? payload : null;
  } catch (_) {
    return null;
  }
}

async function fetchFlights() {
  try {
    const fr24 = await fetchFlightRadarFeed();
    if (fr24?.ok && Array.isArray(fr24?.flights)) {
      FLIGHTS_STATE.lastFetch = Date.now();
      FLIGHTS_STATE.lastData = fr24;
      return fr24;
    }
    throw new Error("FR24 payload missing flights array");
  } catch (e) {
    console.warn("FlightRadar fetch failed:", e);
    updateFlightInfo("Flight feed unavailable", FLIGHTS_STATE.flightCount);
    return null;
  }
}

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// RENDER FLIGHTS ON MAP
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

function renderFlights(data) {
  if (FLIGHTS_STATE.active && !map.hasLayer(layers.flights)) {
    layers.flights.addTo(map);
  }
  clearSelectedFlightRoute();
  layers.flights.clearLayers();
  FLIGHTS_STATE.markerByIcao.clear();

  if (!data || !Array.isArray(data.flights)) {
    FLIGHTS_STATE.flightCount = 0;
    FLIGHTS_STATE.flightsCache = [];
    FLIGHTS_STATE.snapshot = { count: 0, topTracks: [] };
    renderFlightFilterResults();
    updateFlightInfo("No aircraft detected", 0);
    return;
  }
  renderFlightsFr24(data);
}

function renderFlightsFr24(payload) {
  const rawFlights = Array.isArray(payload?.flights) ? payload.flights : [];
  if (!rawFlights.length) {
    FLIGHTS_STATE.flightCount = 0;
    FLIGHTS_STATE.flightsCache = [];
    FLIGHTS_STATE.snapshot = { count: 0, topTracks: [] };
    renderFlightFilterResults();
    updateFlightInfo("No aircraft detected", 0);
    return;
  }

  let count = 0;
  let altTotal = 0;
  let altSamples = 0;
  let speedTotal = 0;
  let speedSamples = 0;
  let climbing = 0;
  let descending = 0;
  let maxAlt = -1;
  const topTracks = [];
  const now = Date.now();
  const flightsBuilt = [];

  for (const fr of rawFlights) {
    const lat = Number(fr?.lat);
    const lon = Number(fr?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (fr?.onGround) continue;

    const icao = String(fr?.icao24 || "").trim().toLowerCase();
    const flightId = String(fr?.id || "").trim();
    const callsign = String(fr?.callsign || fr?.number || "").trim();
    const altM = Number.isFinite(Number(fr?.altitude)) ? (Number(fr.altitude) * 0.3048) : null;
    const speedMs = Number.isFinite(Number(fr?.speed)) ? (Number(fr.speed) * 0.514444) : null;
    const vertMs = Number.isFinite(Number(fr?.verticalSpeed)) ? (Number(fr.verticalSpeed) * 0.00508) : null;
    const track = Number.isFinite(Number(fr?.heading)) ? Number(fr.heading) : null;
    const trailKey = icao || flightId || callsign.toLowerCase();

    if (trailKey) {
      const history = FLIGHTS_STATE.trails.get(trailKey) || [];
      history.push({ lat, lon, ts: now });
      const recent = history.filter((p) => now - p.ts <= 3 * 60 * 60 * 1000).slice(-36);
      FLIGHTS_STATE.trails.set(trailKey, recent);
    }
    const trail = trailKey ? (FLIGHTS_STATE.trails.get(trailKey) || []) : [];

    const originAirport = findAirportByRef(fr?.origin || "");
    const destinationAirport = findAirportByRef(fr?.destination || "");
    const flight = {
      source: "fr24",
      fr24Id: flightId,
      icao24: icao,
      callsign,
      number: String(fr?.number || ""),
      origin: String(fr?.origin || "").toUpperCase(),
      destination: String(fr?.destination || "").toUpperCase(),
      airline: String(fr?.airline || fr?.airlineCode || ""),
      aircraft: String(fr?.aircraft || fr?.aircraftType || fr?.type || ""),
      originCountry: "",
      lat,
      lon,
      alt: altM,
      speed: speedMs,
      track,
      vertRate: vertMs,
      squawk: String(fr?.squawk || ""),
      emitterCategory: null,
      onGround: !!fr?.onGround,
      lastSeen: now,
      originAirport: originAirport || null,
      destinationAirport: destinationAirport || null
    };
    flight.classification = classifyFlightType(flight);
    flightsBuilt.push(flight);
    if (!flightMatchesFilters(flight, FLIGHTS_STATE.filters)) continue;

    const icon = createFlightRefIcon(flight);
    const marker = L.marker([lat, lon], { icon });
    marker.bindTooltip(`${escapeHtml(callsign || icao || flightId || "Unknown")} - ${escapeHtml(flight.classification.label)}`, { direction: "top", opacity: 0.9 });
    marker.on("click", async (ev) => {
      if (ev && ev.originalEvent && L?.DomEvent) {
        L.DomEvent.stopPropagation(ev.originalEvent);
      }
      FLIGHTS_STATE.suppressNextMapClick = true;
      drawSelectedFlightRoute(flight);
      let frRoute = null;
      let frDetails = null;
      if (flight.fr24Id) {
        const detail = await fetchFlightRadarDetails(flight.fr24Id);
        frDetails = detail?.details || null;
        const points = Array.isArray(detail?.details?.trail)
          ? detail.details.trail
            .map((p) => [Number(p?.lat), Number(p?.lng)])
            .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
          : [];
        if (points.length >= 2) frRoute = { trailPoints: points };
      }
      const schedule = await fetchFlightScheduleHints(flight);
      const routeCtx = getRouteContextFromSchedule(flight, schedule);
      const mergedRoute = frRoute ? { ...routeCtx, ...frRoute } : routeCtx;
      drawSelectedFlightRoute(flight, mergedRoute);
      openFlightDetailPanel(flight, trail, schedule, mergedRoute, frDetails);
      setTimeout(() => {
        FLIGHTS_STATE.suppressNextMapClick = false;
      }, 180);
    });
    marker.addTo(layers.flights);
    if (trailKey) FLIGHTS_STATE.markerByIcao.set(trailKey, marker);
    if (trail.length >= 2) {
      const latLngs = trail.map((p) => [p.lat, p.lon]);
      L.polyline(latLngs, {
        color: flight.classification.code === "military"
          ? "rgba(239,68,68,0.72)"
          : (flight.classification.code === "domestic" ? "rgba(34,197,94,0.7)" : "rgba(56,189,248,0.68)"),
        weight: 1.8,
        opacity: 0.85,
        className: "flight-trail"
      }).addTo(layers.flights);
    }

    if (Number.isFinite(altM)) {
      altTotal += altM;
      altSamples += 1;
      if (altM > maxAlt) maxAlt = altM;
    }
    if (Number.isFinite(speedMs)) {
      speedTotal += speedMs;
      speedSamples += 1;
    }
    if (Number.isFinite(vertMs) && vertMs > 1.3) climbing += 1;
    if (Number.isFinite(vertMs) && vertMs < -1.3) descending += 1;
    topTracks.push({
      callsign: callsign || icao || flightId || "Unknown",
      alt: altM,
      velocity: speedMs,
      trend: getTrend(vertMs)
    });
    count++;
  }

  FLIGHTS_STATE.flightsCache = flightsBuilt;
  FLIGHTS_STATE.flightCount = count;
  FLIGHTS_STATE.snapshot = {
    count,
    avgAlt: altSamples ? (altTotal / altSamples) : NaN,
    maxAlt: Number.isFinite(maxAlt) && maxAlt >= 0 ? maxAlt : NaN,
    avgSpeed: speedSamples ? (speedTotal / speedSamples) : NaN,
    climbing,
    descending,
    topTracks: topTracks.sort((a, b) => (Number(b.alt) || -1) - (Number(a.alt) || -1)).slice(0, 5)
  };
  renderFlightFilterResults();
  updateFlightInfo(null, count, FLIGHTS_STATE.snapshot);
  const totalAirborne = flightsBuilt.length;
  if (hasActiveFlightFilters()) {
    setStatus(`${count} flights shown (filtered from ${totalAirborne})`);
  } else {
    setStatus(`${count} aircraft tracked`);
  }
}

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// UI
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

function updateFlightInfo(errorMsg, count, snapshot = null) {
  const panel = ensureFlightInfoPanel();
  const statsEl = document.getElementById("flight-stats");
  const timeEl = document.getElementById("flight-info-time");
  if (!panel || !statsEl) return;

  if (!FLIGHTS_STATE.active) {
    statsEl.innerHTML = '<span class="flight-info-text">Enable layer to track aircraft</span>';
    if (timeEl) timeEl.textContent = "";
    return;
  }

  if (errorMsg) {
    statsEl.innerHTML =
      `<div class="flight-info-stats">` +
      `<span class="flight-info-text">${escapeHtml(errorMsg)}</span>` +
      `</div>`;
  } else {
    const snap = snapshot || FLIGHTS_STATE.snapshot || {};
    const topTracks = Array.isArray(snap.topTracks) ? snap.topTracks : [];
    const trackRows = topTracks
      .map((t) =>
        `<div class="flight-track-item">` +
        `<span>${escapeHtml(String(t.callsign || "").toUpperCase())}</span>` +
        `<span>${escapeHtml(formatFeet(t.alt))} ${escapeHtml(t.trend || "LVL")}</span>` +
        `</div>`
      )
      .join("");

    statsEl.innerHTML =
      `<div class="flight-radar-ring" aria-hidden="true"></div>` +
      `<div class="flight-info-stats">` +
      `<span class="flight-stat"><span>Tracked</span><span class="flight-stat-value">${count}</span></span>` +
      `<span class="flight-stat"><span>Avg Alt</span><span class="flight-stat-value">${escapeHtml(formatFeet(snap.avgAlt))}</span></span>` +
      `<span class="flight-stat"><span>Avg Speed</span><span class="flight-stat-value">${escapeHtml(formatKnots(snap.avgSpeed))}</span></span>` +
      `<span class="flight-stat"><span>Max Alt</span><span class="flight-stat-value">${escapeHtml(formatFeet(snap.maxAlt))}</span></span>` +
      `<span class="flight-stat"><span>Climbing</span><span class="flight-stat-value">${Number(snap.climbing || 0)}</span></span>` +
      `<span class="flight-stat"><span>Descending</span><span class="flight-stat-value">${Number(snap.descending || 0)}</span></span>` +
      `</div>` +
      `<div class="flight-tracklist">` +
      `<div class="flight-track-title">High Altitude Tracks</div>` +
      (trackRows || `<div class="flight-info-text">No active tracks</div>`) +
      `</div>`;
  }

  if (timeEl && FLIGHTS_STATE.lastFetch) {
    const t = new Date(FLIGHTS_STATE.lastFetch);
    timeEl.textContent = t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
}

async function manualFlightRefresh() {
  const btn = document.getElementById("flight-refresh-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }

  const data = await fetchFlights();
  if (data) renderFlights(data);

  if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
}

window.manualFlightRefresh = manualFlightRefresh;

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// AUTO-REFRESH LOOP
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

async function flightRefreshLoop() {
  if (!FLIGHTS_STATE.active) return;
  const data = await fetchFlights();
  if (data) renderFlights(data);
}

function startFlightTracking() {
  if (FLIGHTS_STATE.active) return;
  FLIGHTS_STATE.active = true;
  if (!map.hasLayer(layers.flights)) {
    layers.flights.addTo(map);
  }
  const cb = document.querySelector('[data-layer="flights"]');
  if (cb && !cb.checked) cb.checked = true;
  const panel = document.getElementById("flight-info");
  if (panel) panel.style.display = "";

  // Immediate first fetch
  flightRefreshLoop();

  // Start interval
  FLIGHTS_STATE.timer = setInterval(flightRefreshLoop, CONTROL_ROOM_CONFIG.FLIGHTS_STATE.refreshInterval);
  updateFlightInfo(null, 0);
}

function stopFlightTracking() {
  FLIGHTS_STATE.active = false;
  if (FLIGHTS_STATE.timer) {
    clearInterval(FLIGHTS_STATE.timer);
    FLIGHTS_STATE.timer = null;
  }
  layers.flights.clearLayers();
  if (map.hasLayer(layers.flights)) {
    map.removeLayer(layers.flights);
  }
  FLIGHTS_STATE.flightCount = 0;
  FLIGHTS_STATE.flightsCache = [];
  FLIGHTS_STATE.markerByIcao.clear();
  FLIGHTS_STATE.snapshot = null;
  clearFlightSelection();
  renderFlightFilterResults();
  updateFlightInfo(null, 0);
}

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
// INITIALIZATION
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

function initFLIGHTS_STATE() {
  ensureFlightDetailPanel();
  ensureFlightInfoPanel();
  FLIGHTS_STATE.filters = currentFlightFiltersFromUi();

  // Wire up the flights layer toggle
  const cb = document.querySelector('[data-layer="flights"]');
  if (cb) {
    cb.addEventListener("change", () => {
      if (cb.checked) {
        startFlightTracking();
      } else {
        stopFlightTracking();
      }
    });
  }

  const filterBtn = document.getElementById("flight-filter-btn");
  const clearBtn = document.getElementById("flight-filter-clear-btn");
  const refreshBtn = document.getElementById("flight-refresh-btn");
  filterBtn?.addEventListener("click", applyFlightFilters);
  clearBtn?.addEventListener("click", clearFlightFilters);
  refreshBtn?.addEventListener("click", manualFlightRefresh);

  [
    "flight-airport-q",
    "flight-origin-q",
    "flight-destination-q",
    "flight-aircraft-q",
    "flight-number-q",
    "flight-time-from",
    "flight-time-to"
  ].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        applyFlightFilters();
      }
    });
  });

  const focusFilter = document.getElementById("flight-passenger-large-only");
  focusFilter?.addEventListener("change", () => {
    applyFlightFilters();
  });

  if (!FLIGHTS_STATE.mapDeselectHooked && map && typeof map.on === "function") {
    map.on("click", () => {
      if (FLIGHTS_STATE.suppressNextMapClick) {
        FLIGHTS_STATE.suppressNextMapClick = false;
        return;
      }
      clearFlightSelection();
    });
    FLIGHTS_STATE.mapDeselectHooked = true;
  }

  renderFlightFilterResults();
  updateFlightInfo(null, 0);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFLIGHTS_STATE);
} else {
  initFLIGHTS_STATE();
}

