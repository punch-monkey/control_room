// ================== national_rail_live.js ==================
// National Rail station layer + major corridors + live boards.

const NR = {
  stationsLoaded: false,
  stationsLoading: null,
  routeLayer: null,
  stationLayer: null,
  stationByCrs: new Map(),   // CRS -> station
  markerByCrs: new Map(),    // CRS -> marker
  routeRegistry: {},         // routeId -> { id, name, color, enabled, segments[] }
  selectedRouteId: null,
  lineMode: "all",           // all | major | minor
  stationRouteMap: new Map(), // CRS -> Set(routeId)
  stationGraph: null,        // CRS -> [{ to, km }]
  boardCache: new Map(),     // key -> { ts, data }
  lastResults: []
};

const NR_BOARD_CACHE_MS = 30000;
const NR_FALLBACK_STATIONS_URL = "https://raw.githubusercontent.com/davwheat/uk-railway-stations/main/stations.json";
const NR_STATION_ICON_URL = "data/TFL/logos/UK_Rail.png";
const NR_MAJOR_LINES = [
  { id: "wcml", name: "West Coast Main Line", group: "national", color: "#ef4444", crs: ["EUS", "MKC", "RUG", "CRE", "WGN", "PRE", "LAN", "OXN", "CAR", "GLC"] },
  { id: "ecml", name: "East Coast Main Line", group: "national", color: "#0ea5e9", crs: ["KGX", "PBO", "YRK", "DAR", "NCL", "EDB"] },
  { id: "gwml", name: "Great Western Main Line", group: "national", color: "#22c55e", crs: ["PAD", "RDG", "DID", "SWI", "BPW", "NWP", "CDF"] },
  { id: "mml", name: "Midland Main Line", group: "midlands_north", color: "#a855f7", crs: ["STP", "LTN", "LEI", "DBY", "SHF"] },
  { id: "chiltern", name: "Chiltern Main Line", group: "south_east", color: "#f59e0b", crs: ["MYB", "HWC", "BAN", "LMS", "BMO"] },
  { id: "crosscountry", name: "CrossCountry Spine", group: "midlands_north", color: "#f97316", crs: ["BHM", "DBY", "SHF", "LDS", "YRK", "NCL"] },
  { id: "c2c", name: "London - Southend (c2c)", group: "south_east", color: "#14b8a6", crs: ["FST", "BKG", "UPM", "CGE", "SSA"] },
  { id: "anglia", name: "Great Eastern Main Line", group: "south_east", color: "#e11d48", crs: ["LST", "SRA", "CHM", "COL", "MNG", "IPS", "NRW"] },
  { id: "southwestern", name: "South Western Main Line", group: "south_east", color: "#0f766e", crs: ["WAT", "WOK", "BSK", "WIN", "SOU", "BMH"] },
  { id: "brighton", name: "Brighton Main Line", group: "south_east", color: "#dc2626", crs: ["VIC", "ECR", "GTW", "HHE", "BTN"] },
  { id: "thameslink", name: "Thameslink Core", group: "south_east", color: "#2563eb", crs: ["BDM", "STP", "CTK", "ECR", "GTW", "BTN"] },
  { id: "transpennine", name: "TransPennine North", group: "midlands_north", color: "#16a34a", crs: ["LIV", "MAN", "HUD", "LDS", "YRK", "NCL"] },
  { id: "walesnorth", name: "North Wales Coast", group: "wales_west", color: "#7c3aed", crs: ["MAN", "CRE", "CGN", "BHN", "LNO", "HHD"] },
  { id: "walesmarches", name: "Welsh Marches", group: "wales_west", color: "#b45309", crs: ["MAN", "CRE", "SHR", "HFD", "NWP", "CDF"] },
  { id: "swwales", name: "South Wales Main Line", group: "wales_west", color: "#be123c", crs: ["BRI", "BPW", "NWP", "CDF", "SWA"] },
  { id: "westofengland", name: "West of England Line", group: "wales_west", color: "#0891b2", crs: ["WAT", "BSK", "SAL", "YOV", "EXD"] },
  { id: "eastmidlands", name: "East Midlands Spine", group: "midlands_north", color: "#9333ea", crs: ["STP", "LEI", "DBY", "SHF", "LDS"] }
];
const NR_LINE_GROUPS = [
  { id: "national", label: "National Main Lines" },
  { id: "south_east", label: "London & South East" },
  { id: "midlands_north", label: "Midlands & North" },
  { id: "wales_west", label: "Wales & West" }
];

function getNrResultsPanel() {
  return document.getElementById("nr-station-results");
}

function getNrMajorLineGrid() {
  return document.getElementById("nr-major-line-grid");
}

function getNrSelectedLineEl() {
  return document.getElementById("nr-selected-line");
}

function normalizeRouteId(id) {
  return String(id || "").trim().toLowerCase();
}

function ensureNationalRailLayerVisible() {
  const cb = document.querySelector('.layer-cb[data-layer="national_rail"]');
  if (cb && !cb.checked) {
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function buildNrPopupLoading(station, message = "Loading live boards...") {
  return (
    `<div class="nr-card">` +
    `<div class="nr-card-title">${escapeHtml(station.name || "Station")} (${escapeHtml(station.crs || "---")})</div>` +
    `<div class="nr-card-meta">National Rail</div>` +
    `<div class="nr-empty">${escapeHtml(message)}</div>` +
    `</div>`
  );
}

function nrMarkerRadiusForZoom(zoom) {
  const z = Number(zoom || map?.getZoom?.() || 6);
  if (z <= 5) return 2.5;
  if (z <= 6) return 3.2;
  if (z <= 7) return 3.8;
  if (z <= 8) return 4.5;
  if (z <= 10) return 5.2;
  return 6;
}

function nrMarkerIconSizeForZoom(zoom) {
  const z = Number(zoom || map?.getZoom?.() || 6);
  if (z <= 5) return 10;
  if (z <= 6) return 12;
  if (z <= 7) return 14;
  if (z <= 8) return 16;
  if (z <= 10) return 18;
  return 20;
}

function createNrStationIcon(zoom) {
  const size = nrMarkerIconSizeForZoom(zoom);
  const half = Math.round(size / 2);
  return L.divIcon({
    className: "nr-station-logo-wrap",
    html: `<img class="nr-station-logo" src="${NR_STATION_ICON_URL}" alt="NR" width="${size}" height="${size}" />`,
    iconSize: [size, size],
    iconAnchor: [half, half],
    popupAnchor: [0, -Math.max(8, half)]
  });
}

function countVisibleStations() {
  const bounds = map.getBounds();
  let visible = 0;
  for (const station of NR.stationByCrs.values()) {
    if (bounds.contains([station.lat, station.lon])) visible += 1;
  }
  return visible;
}

function updateSelectedMajorLineLabel() {
  const el = getNrSelectedLineEl();
  if (!el) return;
  if (!NR.selectedRouteId) {
    el.textContent = "Selected Major Line: None";
    return;
  }
  const route = NR.routeRegistry[NR.selectedRouteId];
  el.textContent = route ? `Selected Major Line: ${route.name}` : "Selected Major Line: None";
}

function updateNrMarkerStylesAndStatus() {
  const zoom = map.getZoom();
  const icon = createNrStationIcon(zoom);
  for (const marker of NR.markerByCrs.values()) {
    if (typeof marker.setIcon === "function") marker.setIcon(icon);
  }
  if (!map.hasLayer(layers.national_rail)) return;
  const total = NR.markerByCrs.size;
  if (!total) return;
  const visible = countVisibleStations();
  setStatus(`National Rail: ${total} loaded, ${visible} in current view`);
}

function applyMajorLineStyles() {
  const selected = NR.selectedRouteId;
  for (const route of Object.values(NR.routeRegistry)) {
    const routeType = String(route.type || "major");
    const enabled = route.enabled !== false;
    const modeVisible = NR.lineMode === "all" ||
      (NR.lineMode === "major" && routeType === "major") ||
      (NR.lineMode === "minor" && routeType === "minor");
    const shouldShow = enabled && modeVisible;
    for (const seg of route.segments) {
      const onLayer = NR.routeLayer?.hasLayer(seg);
      if (shouldShow && !onLayer) NR.routeLayer.addLayer(seg);
      if (!shouldShow && onLayer) NR.routeLayer.removeLayer(seg);
    }
    if (!shouldShow) continue;
    const isSelected = !!selected && route.id === selected;
    const isDimmed = !!selected && route.id !== selected;
    for (const seg of route.segments) {
      seg.setStyle({
        color: route.color,
        weight: isSelected ? 6.5 : 4.2,
        opacity: isDimmed ? 0.16 : 0.84
      });
      if (seg._path) {
        seg._path.classList.remove("nr-major-line-selected", "nr-major-line-dimmed");
        if (isSelected) seg._path.classList.add("nr-major-line-selected");
        if (isDimmed) seg._path.classList.add("nr-major-line-dimmed");
      }
    }
  }
}

function focusMajorLine(routeId) {
  const id = normalizeRouteId(routeId);
  const route = NR.routeRegistry[id];
  if (!route || !route.segments.length) return;
  const fg = L.featureGroup(route.segments);
  map.fitBounds(fg.getBounds(), { padding: [70, 70], maxZoom: 9 });
}

function selectMajorLine(routeId) {
  const id = normalizeRouteId(routeId);
  const route = NR.routeRegistry[id];
  if (!route || route.enabled === false) return;
  if (String(route.type || "major") !== "major") return;
  NR.selectedRouteId = (NR.selectedRouteId === id) ? null : id;
  applyMajorLineStyles();
  applyStationVisibilityFromRoutes();
  updateSelectedMajorLineLabel();
  renderMajorLineGrid();
}

function setMajorLineEnabled(routeId, enabled) {
  const id = normalizeRouteId(routeId);
  const route = NR.routeRegistry[id];
  if (!route) return;
  route.enabled = !!enabled;
  if (!route.enabled && NR.selectedRouteId === id) NR.selectedRouteId = null;
  applyMajorLineStyles();
  applyStationVisibilityFromRoutes();
  updateSelectedMajorLineLabel();
  renderMajorLineGrid();
}

function setAllMajorLinesEnabled(enabled) {
  for (const route of Object.values(NR.routeRegistry)) {
    if (String(route.type || "major") !== "major") continue;
    route.enabled = !!enabled;
  }
  if (!enabled) NR.selectedRouteId = null;
  applyMajorLineStyles();
  applyStationVisibilityFromRoutes();
  updateSelectedMajorLineLabel();
  renderMajorLineGrid();
}

function setLineMode(mode) {
  const m = String(mode || "").toLowerCase();
  if (!["all", "major", "minor"].includes(m)) return;
  NR.lineMode = m;
  if (m !== "major" && NR.selectedRouteId) {
    const selected = NR.routeRegistry[NR.selectedRouteId];
    if (!selected || String(selected.type || "major") !== "major") {
      NR.selectedRouteId = null;
    }
  }
  applyMajorLineStyles();
  applyStationVisibilityFromRoutes();
  updateSelectedMajorLineLabel();
  renderMajorLineGrid();
}

function routeVisibleForMode(route) {
  const routeType = String(route?.type || "major");
  const enabled = route?.enabled !== false;
  const modeVisible = NR.lineMode === "all" ||
    (NR.lineMode === "major" && routeType === "major") ||
    (NR.lineMode === "minor" && routeType === "minor");
  return enabled && modeVisible;
}

function applyStationVisibilityFromRoutes() {
  if (!NR.stationLayer) return;
  for (const [crs, marker] of NR.markerByCrs.entries()) {
    const routeIds = NR.stationRouteMap.get(crs);
    let visible = false;
    if (routeIds && routeIds.size) {
      for (const routeId of routeIds) {
        const route = NR.routeRegistry[routeId];
        if (route && routeVisibleForMode(route)) {
          visible = true;
          break;
        }
      }
    }
    const onLayer = NR.stationLayer.hasLayer(marker);
    if (visible && !onLayer) NR.stationLayer.addLayer(marker);
    if (!visible && onLayer) NR.stationLayer.removeLayer(marker);
  }
}

function setMajorLineGroupEnabled(groupId, enabled) {
  const gid = String(groupId || "").trim().toLowerCase();
  for (const route of Object.values(NR.routeRegistry)) {
    if (String(route.group || "").toLowerCase() === gid) {
      route.enabled = !!enabled;
      if (!route.enabled && NR.selectedRouteId === route.id) NR.selectedRouteId = null;
    }
  }
  applyMajorLineStyles();
  updateSelectedMajorLineLabel();
  renderMajorLineGrid();
}

function renderMajorLineGrid() {
  const grid = getNrMajorLineGrid();
  if (!grid) return;
  const routes = Object.values(NR.routeRegistry).filter((r) => String(r.type || "major") === "major");
  if (!routes.length) {
    grid.innerHTML = '<div class="nr-empty">Major lines unavailable</div>';
    return;
  }
  grid.innerHTML = "";
  for (const group of NR_LINE_GROUPS) {
    const groupRoutes = routes.filter((r) => String(r.group || "") === group.id);
    if (!groupRoutes.length) continue;

    const section = document.createElement("div");
    section.className = "nr-major-line-section";

    const head = document.createElement("div");
    head.className = "nr-major-line-section-head";
    head.innerHTML = `<span>${escapeHtml(group.label)}</span>`;
    const btns = document.createElement("div");
    btns.className = "nr-major-line-section-btns";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "btn-secondary btn-sm";
    allBtn.textContent = "All";
    allBtn.addEventListener("click", () => setMajorLineGroupEnabled(group.id, true));
    const noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.className = "btn-secondary btn-sm";
    noneBtn.textContent = "None";
    noneBtn.addEventListener("click", () => setMajorLineGroupEnabled(group.id, false));
    btns.appendChild(allBtn);
    btns.appendChild(noneBtn);
    head.appendChild(btns);
    section.appendChild(head);

    for (const route of groupRoutes) {
      const row = document.createElement("div");
      row.className = "nr-major-line-row";

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = route.enabled !== false;
      toggle.title = `Show/hide ${route.name}`;
      toggle.addEventListener("change", () => setMajorLineEnabled(route.id, toggle.checked));

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nr-major-line-btn";
      if (NR.selectedRouteId === route.id) btn.classList.add("active");
      if (route.enabled === false) btn.classList.add("disabled");
      btn.innerHTML =
        `<span class="nr-major-line-dot" style="background:${route.color}"></span>` +
        `<span>${escapeHtml(route.name)}</span>`;
      btn.addEventListener("click", () => {
        selectMajorLine(route.id);
        if (NR.selectedRouteId === route.id) focusMajorLine(route.id);
      });

      row.appendChild(toggle);
      row.appendChild(btn);
      section.appendChild(row);
    }
    grid.appendChild(section);
  }
}

function buildMajorLines() {
  NR.routeRegistry = {};
  NR.selectedRouteId = null;
  NR.stationGraph = buildStationGraph();
  if (!NR.routeLayer) return;
  NR.routeLayer.clearLayers();

  for (const def of NR_MAJOR_LINES) {
    const coords = [];
    const routedCrs = [];
    for (let i = 0; i < def.crs.length; i++) {
      const code = String(def.crs[i] || "").toUpperCase();
      const st = NR.stationByCrs.get(code);
      if (!st) continue;
      if (i === 0) {
        coords.push([st.lat, st.lon]);
        routedCrs.push(code);
        continue;
      }
      const prevCode = String(def.crs[i - 1] || "").toUpperCase();
      const path = findStationPath(prevCode, code);
      if (path && path.length >= 2) {
        // Append routed intermediate stations so lines don't "jump" in straight cuts.
        for (let p = 1; p < path.length; p++) {
          const hop = NR.stationByCrs.get(path[p]);
          if (!hop) continue;
          coords.push([hop.lat, hop.lon]);
          routedCrs.push(path[p]);
        }
      } else {
        coords.push([st.lat, st.lon]);
        routedCrs.push(code);
      }
    }
    if (coords.length < 2) continue;

    const line = L.polyline(coords, {
      color: def.color,
      weight: 4.2,
      opacity: 0.84,
      smoothFactor: 1.2,
      className: "nr-major-line",
      pane: "nrRoutesPane"
    }).addTo(NR.routeLayer);

    line.bindTooltip(def.name, { sticky: true, opacity: 0.9, direction: "top" });
    line.on("click", (ev) => {
      L.DomEvent.stop(ev);
      selectMajorLine(def.id);
    });

    NR.routeRegistry[def.id] = {
      id: def.id,
      name: def.name,
      group: def.group || "national",
      color: def.color,
      type: "major",
      enabled: true,
      segments: [line]
    };

    for (const code of routedCrs) {
      const crs = String(code || "").toUpperCase();
      if (!crs) continue;
      if (!NR.stationRouteMap.has(crs)) NR.stationRouteMap.set(crs, new Set());
      NR.stationRouteMap.get(crs).add(def.id);
    }
  }

  buildMinorNetwork();
  applyMajorLineStyles();
  applyStationVisibilityFromRoutes();
  updateSelectedMajorLineLabel();
  renderMajorLineGrid();
}

function buildStationGraph() {
  const stations = Array.from(NR.stationByCrs.values());
  const graph = new Map();
  for (const s of stations) graph.set(s.crs, []);
  if (!stations.length) return graph;

  const distanceKm = (a, b) => {
    const r = 6371;
    const dLat = (b.lat - a.lat) * (Math.PI / 180);
    const dLon = (b.lon - a.lon) * (Math.PI / 180);
    const lat1 = a.lat * (Math.PI / 180);
    const lat2 = b.lat * (Math.PI / 180);
    const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * r * Math.asin(Math.sqrt(x));
  };

  // Slightly denser graph avoids isolated end-of-line straight jumps (e.g. HHD corridor).
  const nearestCount = 8;
  const maxEdgeKm = 40;

  for (const a of stations) {
    const nearest = [];
    for (const b of stations) {
      if (a.crs === b.crs) continue;
      const d = distanceKm(a, b);
      if (!Number.isFinite(d) || d > maxEdgeKm) continue;
      nearest.push({ to: b.crs, km: d });
    }
    nearest.sort((x, y) => x.km - y.km);
    for (const edge of nearest.slice(0, nearestCount)) {
      graph.get(a.crs).push(edge);
      // Ensure undirected connectivity.
      if (!graph.get(edge.to).some((e) => e.to === a.crs)) {
        graph.get(edge.to).push({ to: a.crs, km: edge.km });
      }
    }
  }
  return graph;
}

function findStationPath(startCrs, endCrs) {
  const start = String(startCrs || "").toUpperCase();
  const end = String(endCrs || "").toUpperCase();
  if (!start || !end || start === end) return [start];
  if (!NR.stationGraph || !NR.stationGraph.has(start) || !NR.stationGraph.has(end)) return null;

  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  const queue = [];
  dist.set(start, 0);
  queue.push({ node: start, d: 0 });

  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const cur = queue.shift();
    if (!cur) break;
    if (visited.has(cur.node)) continue;
    visited.add(cur.node);
    if (cur.node === end) break;

    const edges = NR.stationGraph.get(cur.node) || [];
    for (const edge of edges) {
      const nd = cur.d + Number(edge.km || 0);
      if (!Number.isFinite(nd)) continue;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, cur.node);
        queue.push({ node: edge.to, d: nd });
      }
    }
  }

  if (!dist.has(end)) return null;
  const out = [];
  let cur = end;
  while (cur) {
    out.push(cur);
    if (cur === start) break;
    cur = prev.get(cur);
  }
  out.reverse();
  return out[0] === start ? out : null;
}

function buildMinorNetwork() {
  // Create synthetic feeder links so every station participates in the displayed network.
  const stations = Array.from(NR.stationByCrs.values());
  if (!stations.length || !NR.routeLayer) return;

  const byCrs = new Map(stations.map((s) => [s.crs, s]));
  const majorEdge = new Set();
  for (const def of NR_MAJOR_LINES) {
    for (let i = 1; i < def.crs.length; i++) {
      const a = String(def.crs[i - 1] || "").toUpperCase();
      const b = String(def.crs[i] || "").toUpperCase();
      if (!a || !b) continue;
      majorEdge.add([a, b].sort().join("|"));
    }
  }

  const used = new Set();
  const minorSegments = [];
  const km = (a, b) => {
    const r = 6371;
    const dLat = (b.lat - a.lat) * (Math.PI / 180);
    const dLon = (b.lon - a.lon) * (Math.PI / 180);
    const lat1 = a.lat * (Math.PI / 180);
    const lat2 = b.lat * (Math.PI / 180);
    const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * r * Math.asin(Math.sqrt(x));
  };

  for (const a of stations) {
    let nearest = null;
    let best = Infinity;
    for (const b of stations) {
      if (a.crs === b.crs) continue;
      const d = km(a, b);
      if (d < best) {
        best = d;
        nearest = b;
      }
    }
    if (!nearest) continue;
    if (best > 28) continue;
    const edgeKey = [a.crs, nearest.crs].sort().join("|");
    if (used.has(edgeKey) || majorEdge.has(edgeKey)) continue;
    used.add(edgeKey);
    minorSegments.push([a, nearest]);
  }

  if (!minorSegments.length) return;
  const routeId = "minor-network";
  const segments = [];
  for (const [a, b] of minorSegments) {
    const seg = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
      color: "#64748b",
      weight: 2.2,
      opacity: 0.5,
      smoothFactor: 1.1,
      className: "nr-minor-line",
      pane: "nrRoutesPane"
    }).addTo(NR.routeLayer);
    segments.push(seg);

    if (!NR.stationRouteMap.has(a.crs)) NR.stationRouteMap.set(a.crs, new Set());
    if (!NR.stationRouteMap.has(b.crs)) NR.stationRouteMap.set(b.crs, new Set());
    NR.stationRouteMap.get(a.crs).add(routeId);
    NR.stationRouteMap.get(b.crs).add(routeId);
  }

  NR.routeRegistry[routeId] = {
    id: routeId,
    name: "Minor Network",
    group: "minor",
    color: "#64748b",
    type: "minor",
    enabled: true,
    segments
  };
}

function safeServices(board) {
  return Array.isArray(board?.services) ? board.services : [];
}

function nrPlainText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) {
    return value
      .map((v) => nrPlainText(v))
      .filter(Boolean)
      .join(" / ")
      .trim();
  }
  if (typeof value === "object") {
    const primary = nrPlainText(value.locationName || value.name || value.text || value.value || "");
    if (primary) return primary;
    return "";
  }
  return "";
}

function nrStationListText(list, fallback = "Unknown") {
  if (!Array.isArray(list) || !list.length) return fallback;
  const names = list
    .map((item) => nrPlainText(item))
    .filter(Boolean);
  return names.length ? names.join(" / ") : fallback;
}

function nrTimeStatus(expected, scheduled) {
  const exp = String(expected || "").trim();
  const sched = String(scheduled || "").trim();
  const expLower = exp.toLowerCase();
  if (!exp || exp === "--") return { cls: "nr-time-unknown", label: "--" };
  if (expLower.includes("cancel")) return { cls: "nr-time-cancelled", label: exp };
  if (expLower.includes("on time") || expLower === "ontime") return { cls: "nr-time-ontime", label: "On time" };
  const hhmm = /^\d{1,2}:\d{2}$/;
  if (hhmm.test(exp) && hhmm.test(sched)) {
    return { cls: exp === sched ? "nr-time-ontime" : "nr-time-delayed", label: exp };
  }
  return { cls: "nr-time-info", label: exp };
}

function renderBoardCard(title, board, type) {
  const services = safeServices(board);
  let html =
    `<div class="nr-card">` +
    `<div class="nr-card-title">${escapeHtml(title)}</div>` +
    `<div class="nr-card-meta">${escapeHtml(board?.locationName || "")}${board?.crs ? ` (${escapeHtml(board.crs)})` : ""}</div>`;

  if (!services.length) {
    html += `<div class="nr-empty">No ${escapeHtml(type)} data available.</div>`;
  } else {
    html +=
      `<div class="nr-service nr-service-head">` +
      `<span>Sched</span>` +
      `<span>Expected</span>` +
      `<span>Plat</span>` +
      `<span>${type === "arrivals" ? "From" : "To"}</span>` +
      `</div>`;
    for (const svc of services.slice(0, 8)) {
      const scheduled = type === "arrivals" ? (svc.sta || "--") : (svc.std || "--");
      const expected = type === "arrivals"
        ? (svc.eta || svc.ata || scheduled || "--")
        : (svc.etd || svc.atd || scheduled || "--");
      const status = nrTimeStatus(expected, scheduled);
      const platform = svc.platform ? `P${svc.platform}` : "--";
      const endpoint = type === "arrivals"
        ? nrStationListText(svc.origin, "Unknown origin")
        : nrStationListText(svc.destination, "Unknown destination");
      html +=
        `<div class="nr-service">` +
        `<span class="nr-time-sched">${escapeHtml(nrPlainText(scheduled) || "--")}</span>` +
        `<span class="nr-time-exp ${status.cls}">${escapeHtml(status.label)}</span>` +
        `<span class="nr-plat">${escapeHtml(platform)}</span>` +
        `<span class="nr-dest">${escapeHtml(endpoint)}</span>` +
        `</div>`;
    }
  }

  const msg = Array.isArray(board?.nrccMessages) && board.nrccMessages.length
    ? nrPlainText(board.nrccMessages[0] || "").trim()
    : "";
  if (msg) {
    html += `<div class="nr-alert">${escapeHtml(msg)}</div>`;
  }
  html += `</div>`;
  return html;
}

function buildNrPopupFull(station, departures, arrivals) {
  return (
    `<div class="nr-card">` +
    `<div class="nr-card-title">${escapeHtml(station.name || "Station")} (${escapeHtml(station.crs || "---")})</div>` +
    `<div class="nr-card-meta">Lat ${escapeHtml(String(station.lat))}, Lon ${escapeHtml(String(station.lon))}</div>` +
    `</div>` +
    renderBoardCard("Live Departures", departures?.board || {}, "departures") +
    renderBoardCard("Live Arrivals", arrivals?.board || {}, "arrivals")
  );
}

async function fetchNrJson(path) {
  const r = await apiFetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchNrBoard(crs, type, rows = 10) {
  const key = `${type}:${crs}:${rows}`;
  const cached = NR.boardCache.get(key);
  if (cached && Date.now() - cached.ts < NR_BOARD_CACHE_MS) return cached.data;

  const data = await fetchNrJson(`/nre/${type}?crs=${encodeURIComponent(crs)}&rows=${rows}`);
  NR.boardCache.set(key, { ts: Date.now(), data });
  if (NR.boardCache.size > 80) {
    const oldest = NR.boardCache.keys().next().value;
    NR.boardCache.delete(oldest);
  }
  return data;
}

function normalizeStationList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => ({
      crs: String(s?.crs || "").trim().toUpperCase(),
      name: String(s?.name || "").trim(),
      lat: Number(s?.lat),
      lon: Number(s?.lon),
      country: String(s?.country || "").trim().toLowerCase(),
      distanceKm: Number.isFinite(Number(s?.distanceKm)) ? Number(s.distanceKm) : null
    }))
    .filter((s) => s.crs.length === 3 && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

function normalizeFallbackCatalog(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => ({
      crs: String(s?.crsCode || "").trim().toUpperCase(),
      name: String(s?.stationName || "").trim(),
      lat: Number(s?.lat),
      lon: Number(s?.long),
      country: String(s?.constituentCountry || "").trim().toLowerCase(),
      distanceKm: null
    }))
    .filter((s) => s.crs.length === 3 && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

async function loadStationCatalogWithFallback() {
  const primary = await fetchNrJson("/nre/stations?limit=5000");
  let stations = normalizeStationList(primary?.stations || []);
  if (stations.length <= 120) {
    try {
      const r = await fetch(NR_FALLBACK_STATIONS_URL, { headers: { Accept: "application/json" } });
      if (r.ok) {
        const raw = await r.json();
        const fallbackStations = normalizeFallbackCatalog(raw);
        if (fallbackStations.length > stations.length) stations = fallbackStations;
      }
    } catch (_) {
      // keep primary result
    }
  }
  return stations;
}

function getMarkerForCrs(crs) {
  return NR.markerByCrs.get(String(crs || "").toUpperCase()) || null;
}

async function refreshStationPopup(marker, station) {
  if (!marker || !station?.crs) return;
  marker.setPopupContent(buildNrPopupLoading(station));
  try {
    const [departures, arrivals] = await Promise.all([
      fetchNrBoard(station.crs, "departures", 10),
      fetchNrBoard(station.crs, "arrivals", 10)
    ]);
    marker.setPopupContent(buildNrPopupFull(station, departures, arrivals));
  } catch (_) {
    marker.setPopupContent(buildNrPopupLoading(station, "Live boards unavailable"));
  }
}

function upsertStationMarker(station) {
  const crs = station?.crs;
  if (!crs) return null;

  let marker = NR.markerByCrs.get(crs);
  if (!marker) {
    marker = L.marker([station.lat, station.lon], {
      icon: createNrStationIcon(map.getZoom()),
      pane: "nrStationsPane"
    });
    marker.bindTooltip(`${station.name} (${crs})`, { sticky: true, direction: "top", opacity: 0.95 });
    marker.bindPopup(buildNrPopupLoading(station, "Click marker to load live boards"));
    marker.on("popupopen", () => refreshStationPopup(marker, station));
    marker.addTo(NR.stationLayer || layers.national_rail);
    NR.markerByCrs.set(crs, marker);
  } else {
    marker.setLatLng([station.lat, station.lon]);
  }
  NR.stationByCrs.set(crs, station);
  return marker;
}

async function ensureNationalRailLoaded() {
  if (NR.stationsLoaded) return true;
  if (NR.stationsLoading) return NR.stationsLoading;

  NR.stationsLoading = (async () => {
    try {
      const stations = await loadStationCatalogWithFallback();
      if (!stations.length) throw new Error("No station records");

      layers.national_rail.clearLayers();
      NR.routeLayer = L.featureGroup().addTo(layers.national_rail);
      NR.stationLayer = L.featureGroup().addTo(layers.national_rail);
      NR.stationByCrs.clear();
      NR.markerByCrs.clear();
      NR.stationRouteMap.clear();
      for (const station of stations) {
        upsertStationMarker(station);
      }
      buildMajorLines();

      const cb = document.querySelector('.layer-cb[data-layer="national_rail"]');
      if (cb?.checked && !map.hasLayer(layers.national_rail)) {
        layers.national_rail.addTo(map);
      }

      NR.stationsLoaded = true;
      updateNrMarkerStylesAndStatus();
      return true;
    } catch (e) {
      console.warn("National Rail load failed:", e);
      setStatus("National Rail stations unavailable");
      return false;
    } finally {
      NR.stationsLoading = null;
    }
  })();

  return NR.stationsLoading;
}
window.ensureNationalRailLoaded = ensureNationalRailLoaded;
window.setNrLineMode = setLineMode;

function focusStationByCrs(crs, openPopup = true) {
  const marker = getMarkerForCrs(crs);
  const station = NR.stationByCrs.get(String(crs || "").toUpperCase()) || null;
  if (!marker || !station) return false;
  map.flyTo([station.lat, station.lon], Math.max(map.getZoom(), 11), { duration: 0.55 });
  if (openPopup) marker.openPopup();
  return true;
}

function renderStationResults(list, headerText = "") {
  const panel = getNrResultsPanel();
  if (!panel) return;

  const rows = normalizeStationList(list);
  NR.lastResults = rows;
  if (!rows.length) {
    panel.innerHTML = '<div class="nr-empty">No station results</div>';
    return;
  }

  panel.innerHTML = "";
  if (headerText) {
    const head = document.createElement("div");
    head.className = "nr-empty";
    head.textContent = headerText;
    panel.appendChild(head);
  }

  for (const station of rows.slice(0, 20)) {
    const card = document.createElement("div");
    card.className = "nr-station-item";
    const distance = station.distanceKm == null ? "" : ` | ${station.distanceKm.toFixed(1)} km`;
    card.innerHTML =
      `<div class="nr-station-item-name">${escapeHtml(station.name)}</div>` +
      `<div class="nr-station-item-meta">${escapeHtml(station.crs)}${escapeHtml(distance)}</div>`;

    const actions = document.createElement("div");
    actions.className = "nr-station-item-actions";

    const plotBtn = document.createElement("button");
    plotBtn.type = "button";
    plotBtn.className = "btn-secondary btn-sm";
    plotBtn.textContent = "Plot";
    plotBtn.addEventListener("click", () => {
      ensureNationalRailLayerVisible();
      upsertStationMarker(station);
      focusStationByCrs(station.crs, true);
    });

    const boardBtn = document.createElement("button");
    boardBtn.type = "button";
    boardBtn.className = "btn-secondary btn-sm";
    boardBtn.textContent = "Boards";
    boardBtn.addEventListener("click", async () => {
      ensureNationalRailLayerVisible();
      upsertStationMarker(station);
      focusStationByCrs(station.crs, true);
      const marker = getMarkerForCrs(station.crs);
      if (marker) await refreshStationPopup(marker, station);
    });

    actions.appendChild(plotBtn);
    actions.appendChild(boardBtn);
    card.appendChild(actions);
    panel.appendChild(card);
  }
}

async function runStationSearch() {
  const input = document.getElementById("nr-station-query");
  const panel = getNrResultsPanel();
  const q = String(input?.value || "").trim();
  if (!q) {
    if (panel) panel.innerHTML = '<div class="nr-empty">Enter a station name or CRS code</div>';
    return;
  }

  if (panel) panel.innerHTML = '<div class="nr-empty">Searching stations...</div>';
  try {
    ensureNationalRailLayerVisible();
    await ensureNationalRailLoaded();
    const data = await fetchNrJson(`/nre/stations?q=${encodeURIComponent(q)}&limit=25`);
    const stations = normalizeStationList(data?.stations || []);
    renderStationResults(stations, `${stations.length} result${stations.length === 1 ? "" : "s"}`);
    setStatus(`National Rail search: ${stations.length} result${stations.length === 1 ? "" : "s"}`);
  } catch (e) {
    console.warn("National Rail search failed:", e);
    if (panel) panel.innerHTML = '<div class="nr-empty">Search failed</div>';
    setStatus("National Rail search unavailable");
  }
}

function approxDistanceKm(a, b) {
  const r = 6371;
  const dLat = (b.lat - a.lat) * (Math.PI / 180);
  const dLon = (b.lon - a.lon) * (Math.PI / 180);
  const lat1 = a.lat * (Math.PI / 180);
  const lat2 = b.lat * (Math.PI / 180);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * r * Math.asin(Math.sqrt(x));
}

function findNearestStationToMapCenter() {
  const center = map.getCenter();
  const c = { lat: center.lat, lon: center.lng };
  let best = null;
  let bestDist = Infinity;
  for (const station of NR.stationByCrs.values()) {
    const d = approxDistanceKm(c, station);
    if (d < bestDist) {
      best = station;
      bestDist = d;
    }
  }
  return best;
}

async function runStationNearby() {
  const panel = getNrResultsPanel();
  if (panel) panel.innerHTML = '<div class="nr-empty">Finding nearby stations...</div>';

  try {
    ensureNationalRailLayerVisible();
    const ok = await ensureNationalRailLoaded();
    if (!ok) throw new Error("Stations unavailable");

    const nearest = findNearestStationToMapCenter();
    if (!nearest) throw new Error("No nearest station");

    const data = await fetchNrJson(`/nre/stations?crs=${encodeURIComponent(nearest.crs)}&limit=20`);
    const list = normalizeStationList(data?.stations || []);
    if (data?.base) {
      const base = normalizeStationList([data.base])[0];
      if (base && !list.some((s) => s.crs === base.crs)) {
        list.unshift({ ...base, distanceKm: 0 });
      }
    }
    renderStationResults(list, `${list.length} nearby from map center`);
    setStatus(`National Rail nearby: ${list.length} station${list.length === 1 ? "" : "s"}`);
  } catch (e) {
    console.warn("National Rail nearby failed:", e);
    if (panel) panel.innerHTML = '<div class="nr-empty">Nearby lookup failed</div>';
  }
}

function initNationalRailLive() {
  const searchBtn = document.getElementById("nr-station-search-btn");
  const nearbyBtn = document.getElementById("nr-station-nearby-btn");
  const clearBtn = document.getElementById("nr-station-clear-btn");
  const queryInput = document.getElementById("nr-station-query");
  const panel = getNrResultsPanel();
  const lineAllBtn = document.getElementById("nr-line-all-btn");
  const lineNoneBtn = document.getElementById("nr-line-none-btn");
  const modeMajorBtn = document.getElementById("nr-mode-major-btn");
  const modeMinorBtn = document.getElementById("nr-mode-minor-btn");
  const modeAllNetBtn = document.getElementById("nr-mode-all-net-btn");

  searchBtn?.addEventListener("click", runStationSearch);
  nearbyBtn?.addEventListener("click", runStationNearby);
  clearBtn?.addEventListener("click", () => {
    NR.lastResults = [];
    if (panel) panel.innerHTML = '<div class="nr-empty">Cleared</div>';
  });
  queryInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      runStationSearch();
    }
  });
  lineAllBtn?.addEventListener("click", () => setAllMajorLinesEnabled(true));
  lineNoneBtn?.addEventListener("click", () => setAllMajorLinesEnabled(false));
  modeMajorBtn?.addEventListener("click", () => setLineMode("major"));
  modeMinorBtn?.addEventListener("click", () => setLineMode("minor"));
  modeAllNetBtn?.addEventListener("click", () => setLineMode("all"));

  const layerCb = document.querySelector('.layer-cb[data-layer="national_rail"]');
  layerCb?.addEventListener("change", () => {
    if (layerCb.checked) ensureNationalRailLoaded().then(() => updateNrMarkerStylesAndStatus());
  });

  map.on("zoomend", () => {
    if (!NR.markerByCrs.size) return;
    updateNrMarkerStylesAndStatus();
  });
  map.on("moveend", () => {
    if (!NR.markerByCrs.size) return;
    if (map.hasLayer(layers.national_rail)) updateNrMarkerStylesAndStatus();
  });
  map.on("click", () => {
    if (!NR.selectedRouteId) return;
    NR.selectedRouteId = null;
    applyMajorLineStyles();
    applyStationVisibilityFromRoutes();
    updateSelectedMajorLineLabel();
    renderMajorLineGrid();
  });

  if (panel) {
    panel.innerHTML = '<div class="nr-empty">Use search or nearby to query National Rail stations</div>';
  }
  updateSelectedMajorLineLabel();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initNationalRailLive);
} else {
  initNationalRailLive();
}
