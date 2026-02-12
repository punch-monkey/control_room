// ================== opensky.js ==================
// OpenSky Network - Live Flight Tracking

const OPENSKY = {
  timer: null,
  lastFetch: 0,
  flightCount: 0,
  active: false,        // tracks whether the layer is enabled
  useCorsProxy: false,  // toggled on after first CORS failure
  retryAfter: 0,        // rate-limit backoff timestamp
  trails: new Map(),    // icao24 -> [{lat,lon,ts}]
  snapshot: null,
  flightsCache: [],
  filters: { passengerLargeOnly: true, ukNexusOnly: true },
  markerByIcao: new Map(),
  lastData: null,
  selectedRouteLine: null,
  selectedRouteMarkers: [],
  scheduleCache: new Map(),
  opsCache: new Map(),
  detailPanelEl: null,
  detailDrag: null
};

// State vector field indices
const SV = {
  ICAO24: 0,
  CALLSIGN: 1,
  ORIGIN: 2,
  LON: 5,
  LAT: 6,
  BARO_ALT: 7,
  ON_GROUND: 8,
  VELOCITY: 9,
  TRACK: 10,
  VERT_RATE: 11,
  GEO_ALT: 13,
  SQUAWK: 14,
  CATEGORY: 17
};

const PLANE_ICON_SPRITE = "gfx/plane_icons/MapIcons.png";
const PLANE_SPRITE_GRID = { cols: 3, rows: 3 };
const PLANE_SPRITE_FALLBACK = { col: 1, row: 2 };
const UK_COUNTRY_KEYS = ["UNITED KINGDOM", "UK", "GREAT BRITAIN", "ENGLAND", "SCOTLAND", "WALES", "NORTHERN IRELAND"];
const MILITARY_CALLSIGN_PREFIXES = ["RRR", "RCH", "ASY", "NATO", "QID", "MMF", "IAM", "CFC", "HAF", "BAF", "FAF", "USAF", "RAF"];
const ADSB_LARGE_OR_HEAVY = new Set([3, 4, 5]);

function pickPlaneSprite(altMetres) {
  if (altMetres == null || altMetres <= 0) return { col: 1, row: 0 };
  if (altMetres < 1000) return { col: 0, row: 1 };
  if (altMetres < 3000) return { col: 2, row: 1 };
  if (altMetres < 8000) return { col: 1, row: 2 };
  return { col: 2, row: 2 };
}

function createPlaneSpriteIcon(rotation, altMetres, classification = "international") {
  const sprite = pickPlaneSprite(altMetres) || PLANE_SPRITE_FALLBACK;
  const backgroundX = (sprite.col / (PLANE_SPRITE_GRID.cols - 1)) * 100;
  const backgroundY = (sprite.row / (PLANE_SPRITE_GRID.rows - 1)) * 100;
  const backgroundSize = `${PLANE_SPRITE_GRID.cols * 100}% ${PLANE_SPRITE_GRID.rows * 100}%`;

  return L.divIcon({
    className: `flight-marker flight-${classification}`,
    html:
      `<div class="flight-marker-rotate" style="transform:rotate(${rotation}deg)">` +
      `<div class="flight-marker-icon flight-${classification}" style="background-image:url('${PLANE_ICON_SPRITE}');background-position:${backgroundX}% ${backgroundY}%;background-size:${backgroundSize};"></div>` +
      `</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -14]
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
  // UK nexus means route endpoint linkage, not just current position.
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
  const f = OPENSKY.filters || {};
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

function estimateArrivalEpoch(flight) {
  if (!flight || !flight.destinationAirport) return null;
  if (!Number.isFinite(flight.speed) || flight.speed <= 20) return null;
  const distKm = haversineKm(flight.lat, flight.lon, flight.destinationAirport.lat, flight.destinationAirport.lon);
  if (!Number.isFinite(distKm) || distKm <= 1) return null;
  const speedKmh = flight.speed * 3.6;
  if (!Number.isFinite(speedKmh) || speedKmh < 80) return null;
  const etaHours = distKm / speedKmh;
  if (!Number.isFinite(etaHours) || etaHours > 8) return null;
  return Date.now() + etaHours * 60 * 60 * 1000;
}

function updateOpsSnapshot(flight) {
  const key = String(flight?.icao24 || "").toLowerCase();
  if (!key) return { etaEpoch: null, etaShiftMins: null };
  const prev = OPENSKY.opsCache.get(key) || {};
  const etaEpoch = estimateArrivalEpoch(flight);
  let etaShiftMins = null;
  if (Number.isFinite(prev.etaEpoch) && Number.isFinite(etaEpoch)) {
    etaShiftMins = Math.round((etaEpoch - prev.etaEpoch) / 60000);
  }
  OPENSKY.opsCache.set(key, {
    etaEpoch,
    lastSeen: Date.now()
  });
  return { etaEpoch, etaShiftMins };
}

function getFlightLifecycleLabel(flight, etaShiftMins) {
  if (!flight) return "Unknown";
  if (!flight.destinationAirport) return "Route building";
  if (!Number.isFinite(flight.alt)) return "En route";
  if (flight.alt < 1200) return "Approach / terminal area";
  if (Number.isFinite(etaShiftMins)) {
    if (etaShiftMins >= 4) return `Running late (+${etaShiftMins}m)`;
    if (etaShiftMins <= -4) return `Gaining time (${etaShiftMins}m)`;
  }
  return "En route";
}

async function fetchFlightScheduleHints(flight) {
  const callsign = String(flight?.callsign || "").trim().toUpperCase();
  const icao24 = String(flight?.icao24 || "").trim().toLowerCase();
  if (!callsign && !icao24) return null;
  const key = `${callsign}|${icao24}`;
  const cached = OPENSKY.scheduleCache.get(key);
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
    OPENSKY.scheduleCache.set(key, { ts: Date.now(), data });
    return data;
  } catch (_) {
    return null;
  }
}

function buildPlanePopupHtml(flight, trail, schedule = null, routeCtx = null) {
  const callsign = flightPrimaryId(flight);
  const originAp = routeCtx?.originAirport || flight.originAirport;
  const destAp = routeCtx?.destinationAirport || flight.destinationAirport;
  const originLabel = airportLabel(originAp);
  const destLabel = airportLabel(destAp);
  const ops = updateOpsSnapshot(flight);
  const depPlannedRaw = formatOpsTimeLabel(schedule?.flight?.departure?.scheduled || schedule?.flight?.departure?.estimated || null);
  const depActualRaw = formatOpsTimeLabel(schedule?.flight?.departure?.actual || null);
  const arrPlannedRaw = formatOpsTimeLabel(schedule?.flight?.arrival?.scheduled || schedule?.flight?.arrival?.estimated || ops.etaEpoch || null);
  const arrActualRaw = formatOpsTimeLabel(schedule?.flight?.arrival?.actual || null);
  const depPlanned = depPlannedRaw === "Unknown" ? "Not published" : depPlannedRaw;
  const depActual = depActualRaw === "Unknown" ? "Not published" : depActualRaw;
  const arrPlanned = arrPlannedRaw === "Unknown" ? "ETA unavailable" : arrPlannedRaw;
  const arrActual = arrActualRaw === "Unknown" ? "Not published" : arrActualRaw;
  const statusText = String(schedule?.flight?.status || "").trim() || getFlightLifecycleLabel(flight, ops.etaShiftMins);
  const classInfo = flight?.classification || classifyFlightType(flight);
  const etaShift = Number.isFinite(ops.etaShiftMins)
    ? (ops.etaShiftMins > 0 ? `+${ops.etaShiftMins}m` : `${ops.etaShiftMins}m`)
    : "No change baseline yet";
  const routeTrack = (trail || []).length >= 2 ? "Track confirmed" : "Track still forming";

  return (
    `<div class="flight-intel-popup compact">` +
      `<div class="flight-intel-head">` +
        `<strong>${escapeHtml(callsign)}</strong> <span class="popup-tag">${escapeHtml(classInfo.label)}</span>` +
      `</div>` +
      `<div class="flight-intel-route">${escapeHtml(originLabel)} -> ${escapeHtml(destLabel)}</div>` +
      `<div class="flight-intel-grid">` +
        `<div><span class="popup-label">ETA</span><br>${escapeHtml(arrPlanned)}</div>` +
        `<div><span class="popup-label">Status</span><br>${escapeHtml(statusText)}</div>` +
        `<div><span class="popup-label">ETA Delta</span><br>${escapeHtml(etaShift)}</div>` +
        `<div><span class="popup-label">Track</span><br>${escapeHtml(routeTrack)}</div>` +
      `</div>` +
      `<details class="flight-intel-more">` +
        `<summary>More</summary>` +
        `<div class="flight-intel-meta">` +
          `<span class="popup-label">ICAO24</span> ${escapeHtml(String(flight.icao24 || "").toUpperCase())}<br>` +
          `<span class="popup-label">Departure planned</span> ${escapeHtml(depPlanned)}<br>` +
          `<span class="popup-label">Departure actual</span> ${escapeHtml(depActual)}<br>` +
          `<span class="popup-label">Arrival actual</span> ${escapeHtml(arrActual)}` +
        `</div>` +
      `</details>` +
    `</div>`
  );
}

function ensureFlightDetailPanel() {
  if (OPENSKY.detailPanelEl) return OPENSKY.detailPanelEl;
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
  OPENSKY.detailPanelEl = panel;

  const closeBtn = panel.querySelector("#flight-detail-close");
  closeBtn?.addEventListener("click", () => {
    panel.style.display = "none";
    clearSelectedFlightRoute();
  });

  const header = panel.querySelector(".flight-detail-header");
  header?.addEventListener("mousedown", (e) => {
    OPENSKY.detailDrag = {
      x: e.clientX - panel.offsetLeft,
      y: e.clientY - panel.offsetTop
    };
  });
  document.addEventListener("mousemove", (e) => {
    if (!OPENSKY.detailDrag || panel.style.display === "none") return;
    panel.style.left = `${Math.max(8, e.clientX - OPENSKY.detailDrag.x)}px`;
    panel.style.top = `${Math.max(8, e.clientY - OPENSKY.detailDrag.y)}px`;
    panel.style.right = "auto";
  });
  document.addEventListener("mouseup", () => {
    OPENSKY.detailDrag = null;
  });
  return panel;
}

function openFlightDetailPanel(flight, trail, schedule = null, routeCtx = null) {
  const panel = ensureFlightDetailPanel();
  const title = panel.querySelector("#flight-detail-title");
  const body = panel.querySelector("#flight-detail-body");
  if (title) title.textContent = flightPrimaryId(flight);
  if (body) body.innerHTML = buildPlanePopupHtml(flight, trail, schedule, routeCtx);
  if (!panel.style.left) {
    panel.style.right = "12px";
    panel.style.top = "88px";
  }
  panel.style.display = "";
}

function clearSelectedFlightRoute() {
  if (OPENSKY.selectedRouteLine) {
    try { layers.flights.removeLayer(OPENSKY.selectedRouteLine); } catch (_) {}
    OPENSKY.selectedRouteLine = null;
  }
  if (Array.isArray(OPENSKY.selectedRouteMarkers) && OPENSKY.selectedRouteMarkers.length) {
    for (const m of OPENSKY.selectedRouteMarkers) {
      try { layers.flights.removeLayer(m); } catch (_) {}
    }
  }
  OPENSKY.selectedRouteMarkers = [];
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

  OPENSKY.selectedRouteLine = L.polyline(
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

  OPENSKY.selectedRouteMarkers = [start, end];
  if (hasPlanePoint) {
    const current = L.circleMarker([flight.lat, flight.lon], {
      radius: 4,
      color: "#facc15",
      fillColor: "#facc15",
      fillOpacity: 0.95,
      weight: 2
    }).addTo(layers.flights).bindTooltip(`Current: ${flightPrimaryId(flight)}`, { direction: "top", opacity: 0.95 });
    OPENSKY.selectedRouteMarkers.push(current);
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
  const marker = OPENSKY.markerByIcao.get(key);
  if (marker) {
    map.panTo(marker.getLatLng(), { animate: true, duration: 0.45 });
    marker.openPopup();
    return;
  }

  const flight = OPENSKY.flightsCache.find((f) => String(f.icao24 || "").toLowerCase() === key);
  if (flight) {
    map.panTo([flight.lat, flight.lon], { animate: true, duration: 0.45 });
  }
}

function renderFlightFilterResults() {
  const wrap = document.getElementById("flight-filter-results");
  if (!wrap) return;

  const active = hasActiveFlightFilters();
  if (!OPENSKY.active && !active) {
    wrap.innerHTML = `<div class="flight-filter-item">Enable Live Flights to search active aircraft.</div>`;
    return;
  }

  const list = (OPENSKY.flightsCache || []).filter((f) => flightMatchesFilters(f, OPENSKY.filters));
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
  OPENSKY.filters = currentFlightFiltersFromUi();
  if (OPENSKY.lastData) {
    renderFlights(OPENSKY.lastData);
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
  OPENSKY.filters = { passengerLargeOnly: true, ukNexusOnly: true };
  if (OPENSKY.lastData) {
    renderFlights(OPENSKY.lastData);
  } else {
    renderFlightFilterResults();
  }
}

function buildAirportIntelPopup(airport) {
  if (!airport) return "";
  const flights = Array.isArray(OPENSKY.flightsCache) ? OPENSKY.flightsCache : [];
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ALTITUDE -> COLOUR
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// API FETCH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function buildOpenSkyUrl() {
  const cfg = CONTROL_ROOM_CONFIG.opensky;
  const bb = { ...cfg.bbox };
  if (typeof map !== "undefined" && map && typeof map.getBounds === "function") {
    try {
      const b = map.getBounds().pad(0.45);
      bb.lamin = Math.max(-85, Number(b.getSouth()) || bb.lamin);
      bb.lamax = Math.min(85, Number(b.getNorth()) || bb.lamax);
      bb.lomin = Math.max(-180, Number(b.getWest()) || bb.lomin);
      bb.lomax = Math.min(180, Number(b.getEast()) || bb.lomax);
    } catch (_) {
      // Keep configured fallback bbox
    }
  }
  const url = `${cfg.baseUrl}/states/all?lamin=${bb.lamin}&lamax=${bb.lamax}&lomin=${bb.lomin}&lomax=${bb.lomax}`;
  return url;
}

async function fetchOpenSkyStates(url) {
  // Try local proxy first to avoid browser CORS variance.
  try {
    const u = new URL(url);
    const proxyUrl = apiUrl(`/opensky/states/all?${u.searchParams.toString()}`);
    const proxyResp = await fetch(proxyUrl);
    if (proxyResp.ok) return proxyResp;
    if (proxyResp.status !== 404 && proxyResp.status < 500) return proxyResp;
  } catch (_) {
    // Fallback below
  }
  return fetch(url);
}

async function fetchFlights() {
  // Check rate-limit backoff
  if (OPENSKY.retryAfter > Date.now()) {
    const secs = Math.ceil((OPENSKY.retryAfter - Date.now()) / 1000);
    updateFlightInfo(`Rate limited, retry in ${secs}s`, 0);
    return null;
  }

  const url = buildOpenSkyUrl();

  try {
    let response = null;

    // Prefer local proxy path first.
    try {
      response = await fetchOpenSkyStates(url);
    } catch (proxyErr) {
      console.log("OpenSky proxy/direct failed:", proxyErr?.message || proxyErr);
    }

    // If local proxy/direct still failed, try CORS proxy fallback once.
    if (!response) {
      OPENSKY.useCorsProxy = true;
      const proxyUrl = CONTROL_ROOM_CONFIG.opensky.corsProxy + encodeURIComponent(url);
      response = await fetch(proxyUrl);
    }

    if (response.status === 429) {
      // Rate limited
      const retryHeader = response.headers.get("X-Rate-Limit-Retry-After-Seconds");
      const retrySecs = parseInt(retryHeader || "300", 10);
      OPENSKY.retryAfter = Date.now() + retrySecs * 1000;
      console.warn(`OpenSky rate limited. Retry in ${retrySecs}s`);
      updateFlightInfo(`Rate limited (${Math.ceil(retrySecs / 60)} min)`, OPENSKY.flightCount);
      return null;
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch (_) {
        // ignore
      }
      throw new Error(`HTTP ${response.status}${detail ? ` - ${detail.slice(0, 120)}` : ""}`);
    }

    const data = await response.json();
    OPENSKY.lastFetch = Date.now();
    OPENSKY.lastData = data;
    return data;
  } catch (e) {
    console.warn("OpenSky fetch failed:", e);
    updateFlightInfo("Connection failed", OPENSKY.flightCount);
    return null;
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// RENDER FLIGHTS ON MAP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function renderFlights(data) {
  if (OPENSKY.active && !map.hasLayer(layers.flights)) {
    layers.flights.addTo(map);
  }
  clearSelectedFlightRoute();
  layers.flights.clearLayers();
  OPENSKY.markerByIcao.clear();

  if (!data || !data.states || data.states.length === 0) {
    OPENSKY.flightCount = 0;
    OPENSKY.flightsCache = [];
    OPENSKY.snapshot = { count: 0, topTracks: [] };
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
  const now = Number(data.time) * 1000 || Date.now();
  const flightsBuilt = [];

  for (const sv of data.states) {
    const icao = String(sv[SV.ICAO24] || "").trim().toLowerCase();
    const lat = sv[SV.LAT];
    const lon = sv[SV.LON];
    if (lat == null || lon == null) continue;

    const callsign = (sv[SV.CALLSIGN] || "").trim();
    const origin = sv[SV.ORIGIN] || "Unknown";
    const alt = sv[SV.BARO_ALT];
    const onGround = sv[SV.ON_GROUND];
    const velocity = sv[SV.VELOCITY];
    const track = sv[SV.TRACK];
    const vertRate = sv[SV.VERT_RATE];
    const squawk = sv[SV.SQUAWK];
    const emitterCategory = parseEmitterCategory(sv[SV.CATEGORY] ?? sv[18]);

    // Skip aircraft on ground
    if (onGround) continue;

    const rotation = track != null ? track : 0;

    // Altitude in feet
    if (icao) {
      const history = OPENSKY.trails.get(icao) || [];
      history.push({ lat, lon, ts: now });
      const recent = history.filter((p) => now - p.ts <= 3 * 60 * 60 * 1000).slice(-24);
      OPENSKY.trails.set(icao, recent);
    }

    const trail = icao ? (OPENSKY.trails.get(icao) || []) : [];
    const flight = {
      icao24: icao,
      callsign: callsign || "",
      originCountry: origin || "",
      lat,
      lon,
      alt: Number.isFinite(alt) ? alt : null,
      speed: Number.isFinite(velocity) ? velocity : null,
      track: Number.isFinite(track) ? track : null,
      vertRate: Number.isFinite(vertRate) ? vertRate : null,
      squawk: squawk || "",
      emitterCategory,
      onGround: !!onGround,
      lastSeen: now
    };
    const inferred = inferAirportsForFlight(flight, trail);
    flight.originAirport = inferred.originAirport;
    flight.destinationAirport = inferred.destinationAirport;
    flight.classification = classifyFlightType(flight);
    flightsBuilt.push(flight);

    if (!flightMatchesFilters(flight, OPENSKY.filters)) continue;

    const icon = createPlaneSpriteIcon(rotation, alt, flight.classification.code);
    const marker = L.marker([lat, lon], { icon });
    marker.bindTooltip(`${escapeHtml(callsign || icao || "Unknown")} - ${escapeHtml(flight.classification.label)}`, { direction: "top", opacity: 0.9 });
    marker.on("click", async () => {
      drawSelectedFlightRoute(flight);
      const schedule = await fetchFlightScheduleHints(flight);
      const routeCtx = getRouteContextFromSchedule(flight, schedule);
      drawSelectedFlightRoute(flight, routeCtx);
      openFlightDetailPanel(flight, trail, schedule, routeCtx);
    });
    marker.addTo(layers.flights);
    if (icao) OPENSKY.markerByIcao.set(icao, marker);
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

    if (Number.isFinite(alt)) {
      altTotal += alt;
      altSamples += 1;
      if (alt > maxAlt) maxAlt = alt;
    }
    if (Number.isFinite(velocity)) {
      speedTotal += velocity;
      speedSamples += 1;
    }
    if (Number.isFinite(vertRate) && vertRate > 1.3) climbing += 1;
    if (Number.isFinite(vertRate) && vertRate < -1.3) descending += 1;
    topTracks.push({
      callsign: callsign || icao || "Unknown",
      alt,
      velocity,
      trend: getTrend(vertRate)
    });
    count++;
  }

  OPENSKY.flightsCache = flightsBuilt;

  if (OPENSKY.trails.size > 1800) {
    const cutoff = now - 90 * 60 * 1000;
    for (const [icao, points] of OPENSKY.trails.entries()) {
      const keep = points.filter((p) => p.ts >= cutoff);
      if (keep.length) OPENSKY.trails.set(icao, keep);
      else OPENSKY.trails.delete(icao);
    }
  }

  const avgAlt = altSamples ? altTotal / altSamples : NaN;
  const avgSpeed = speedSamples ? speedTotal / speedSamples : NaN;
  topTracks.sort((a, b) => (Number(b.alt) || -1) - (Number(a.alt) || -1));
  OPENSKY.snapshot = {
    count,
    avgAlt,
    maxAlt: Number.isFinite(maxAlt) && maxAlt >= 0 ? maxAlt : NaN,
    avgSpeed,
    climbing,
    descending,
    topTracks: topTracks.slice(0, 5)
  };

  OPENSKY.flightCount = count;
  renderFlightFilterResults();
  updateFlightInfo(null, count, OPENSKY.snapshot);
  const totalAirborne = flightsBuilt.length;
  if (hasActiveFlightFilters()) {
    setStatus(`${count} flights shown (filtered from ${totalAirborne})`);
  } else {
    setStatus(`${count} aircraft tracked`);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// UI
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function updateFlightInfo(errorMsg, count, snapshot = null) {
  const panel = document.getElementById("flight-info");
  const statsEl = document.getElementById("flight-stats");
  const timeEl = document.getElementById("flight-info-time");
  if (!panel || !statsEl) return;

  if (!OPENSKY.active) {
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
    const snap = snapshot || OPENSKY.snapshot || {};
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

  if (timeEl && OPENSKY.lastFetch) {
    const t = new Date(OPENSKY.lastFetch);
    timeEl.textContent = t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
}

async function manualFlightRefresh() {
  // Reset rate limit if manually triggering
  OPENSKY.retryAfter = 0;

  const btn = document.getElementById("flight-refresh-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }

  const data = await fetchFlights();
  if (data) renderFlights(data);

  if (btn) { btn.disabled = false; btn.textContent = "Refresh"; }
}

window.manualFlightRefresh = manualFlightRefresh;

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUTO-REFRESH LOOP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function flightRefreshLoop() {
  if (!OPENSKY.active) return;
  const data = await fetchFlights();
  if (data) renderFlights(data);
}

function startFlightTracking() {
  if (OPENSKY.active) return;
  OPENSKY.active = true;
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
  OPENSKY.timer = setInterval(flightRefreshLoop, CONTROL_ROOM_CONFIG.opensky.refreshInterval);
  updateFlightInfo(null, 0);
}

function stopFlightTracking() {
  OPENSKY.active = false;
  if (OPENSKY.timer) {
    clearInterval(OPENSKY.timer);
    OPENSKY.timer = null;
  }
  layers.flights.clearLayers();
  if (map.hasLayer(layers.flights)) {
    map.removeLayer(layers.flights);
  }
  OPENSKY.flightCount = 0;
  OPENSKY.flightsCache = [];
  OPENSKY.markerByIcao.clear();
  OPENSKY.snapshot = null;
  clearSelectedFlightRoute();
  renderFlightFilterResults();
  updateFlightInfo(null, 0);
  if (OPENSKY.detailPanelEl) OPENSKY.detailPanelEl.style.display = "none";
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// INITIALIZATION
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function initOpenSky() {
  ensureFlightDetailPanel();
  OPENSKY.filters = currentFlightFiltersFromUi();

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
  filterBtn?.addEventListener("click", applyFlightFilters);
  clearBtn?.addEventListener("click", clearFlightFilters);

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

  renderFlightFilterResults();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initOpenSky);
} else {
  initOpenSky();
}
