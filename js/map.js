// ================== map.js ==================

// â”€â”€ Status / Progress helpers â”€â”€

function setStatus(msg) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = msg;
}
function showProgress() { document.getElementById("data-progress")?.classList.remove("done"); }
function hideProgress() { document.getElementById("data-progress")?.classList.add("done"); }
function setProgress(scanned, total, matchCount) {
  const pct = Math.round((scanned / total) * 100);
  const f = document.getElementById("progress-fill");
  const t = document.getElementById("progress-text");
  const p = document.getElementById("progress-pct");
  if (f) f.style.width = pct + "%";
  if (t) t.textContent = `Searching (${scanned}/${total} files)...`;
  if (p) p.textContent = matchCount != null ? `${matchCount} found` : pct + " %";
}

function showPscProgress() { document.getElementById("psc-progress")?.classList.remove("done"); }
function hidePscProgress() { document.getElementById("psc-progress")?.classList.add("done"); }
function setPscProgress(msg, pct) {
  const f = document.getElementById("psc-progress-fill");
  const t = document.getElementById("psc-progress-text");
  const p = document.getElementById("psc-progress-pct");
  if (f) f.style.width = (pct || 0) + "%";
  if (t) t.textContent = msg;
  if (p) p.textContent = pct != null ? pct + "%" : "";
}

// â”€â”€ Companies House data â”€â”€

let CH_INDEX = [];
let CH_CACHE = {};
let CH_LAST_RESULTS = [];
let CH_TOTAL_ROWS = 0;
let I2_ENTITY_CATALOG = [];
const I2_ENTITY_BY_ID = {};
const I2_ENTITY_BY_NAME = {};
let I2_CATALOG_LOADED = false;
let I2_CATALOG_LOADING_PROMISE = null;

const I2_DEFAULT_BY_CATEGORY = {
  people: "Person",
  buildings: "Location",
  financial: "Financial Account",
  vehicles: "Vehicle",
  aviation: "Aircraft",
  military: "Operation",
  communication: "Communication Entity",
  online_services: "Communication Entity",
  real_estate: "Location",
  weapons: "Firearm",
  social_media: "Communication Entity",
  law_enforcement: "Operation",
  misc: "Location"
};

const I2_ENTITY_TO_CATEGORY = {
  person: "people",
  organisation: "financial",
  location: "buildings",
  vehicle: "vehicles",
  aircraft: "aviation",
  firearm: "military",
  operation: "military",
  vessel: "vehicles",
  "communication entity": "communication",
  "financial account": "financial"
};

async function loadCompaniesHouseIndex() {
  try {
    const r = await fetch("data/companies_house_index.json");
    if (!r.ok) { console.warn("No local company index â€” using API only"); return; }
    CH_INDEX = await r.json();
  } catch (e) { console.warn("Company index load failed:", e); }
}

function loadSubset(file) {
  if (!file || typeof file !== "string") return Promise.resolve([]);
  if (CH_CACHE[file]) return Promise.resolve(CH_CACHE[file]);
  return fetch(file).then(r => r.json()).then(raw => {
    const trimmed = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      trimmed[i] = {
        CompanyName:               s.CompanyName || "",
        CompanyNumber:             s.CompanyNumber || s[" CompanyNumber"] || "",
        "RegAddress.PostCode":     s["RegAddress.PostCode"] || "",
        "RegAddress.PostTown":     s["RegAddress.PostTown"] || "",
        "RegAddress.AddressLine1": s["RegAddress.AddressLine1"] || "",
        CompanyStatus:             s.CompanyStatus || "",
        "SICCode.SicText_1":       s["SICCode.SicText_1"] || ""
      };
    }
    CH_CACHE[file] = trimmed;
    CH_TOTAL_ROWS += trimmed.length;
    return trimmed;
  }).catch(err => { console.warn("Load failed:", file, err); return []; });
}

// â”€â”€ Search â”€â”€

function filterByCriteria(rows, criteria, limit) {
  const nL = criteria.name     ? criteria.name.trim().toLowerCase()     : "";
  const uL = criteria.number   ? criteria.number.trim().toLowerCase()   : "";
  const pL = criteria.postcode ? criteria.postcode.trim().toLowerCase() : "";
  const tL = criteria.town     ? criteria.town.trim().toLowerCase()     : "";
  const out = [];
  for (let i = 0, len = rows.length; i < len; i++) {
    const r = rows[i];
    if (nL && !r.CompanyName.toLowerCase().includes(nL))            continue;
    if (uL && !r.CompanyNumber.toLowerCase().includes(uL))          continue;
    if (pL && !r["RegAddress.PostCode"].toLowerCase().includes(pL)) continue;
    if (tL && !r["RegAddress.PostTown"].toLowerCase().includes(tL)) continue;
    out.push(r);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function searchCached(criteria, limit) {
  const out = [];
  for (const f in CH_CACHE) {
    const hits = filterByCriteria(CH_CACHE[f], criteria, limit ? limit - out.length : 0);
    out.push(...hits);
    if (limit && out.length >= limit) break;
  }
  return limit ? out.slice(0, limit) : out;
}

let _searchAbort = false;

async function searchProgressive(criteria, onBatch) {
  _searchAbort = false;
  let targetFiles = [];
  const numClean = (criteria.number || "").replace(/\D/g, "");
  if (numClean) {
    const num = parseInt(numClean, 10);
    const m = CH_INDEX.find(e => num >= e.start && num <= e.end);
    if (m) targetFiles = [m.file];
  }
  if (!targetFiles.length) targetFiles = CH_INDEX.map(e => e.file);

  const all = [], total = targetFiles.length;
  for (let i = 0; i < targetFiles.length; i += 2) {
    if (_searchAbort) break;
    const batch = targetFiles.slice(i, i + 2);
    try { await Promise.all(batch.map(loadSubset)); } catch { break; }
    for (const f of batch) {
      if (!CH_CACHE[f]) continue;
      const cap = 500 - all.length;
      if (cap <= 0) break;
      all.push(...filterByCriteria(CH_CACHE[f], criteria, cap));
    }
    const scanned = Math.min(i + batch.length, total);
    if (onBatch) onBatch(all, scanned, total);
    if (all.length >= 500) break;
  }
  return all;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// â”€â”€ Postcode lookup â”€â”€

const PC_CACHE = {};
function normalizePostcodeKey(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function extractUkPostcode(raw) {
  const text = String(raw || "").toUpperCase();
  const m = text.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  return m ? m[1] : "";
}
function postcodeVariants(rawPostcode) {
  const raw = String(rawPostcode || "").trim();
  const extracted = extractUkPostcode(raw);
  const base = extracted || raw;
  const key = normalizePostcodeKey(base);
  if (!key) return [];

  const canonical = key.length > 3 ? `${key.slice(0, -3)} ${key.slice(-3)}` : key;
  const variants = [raw, extracted, canonical, key]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  return [...new Set(variants)];
}
function postcodeArea(pc) {
  const m = normalizePostcodeKey(pc).match(/^([A-Z]{1,2})/);
  return m ? m[1] : null;
}
function lookupPostcode(pc) {
  return PC_CACHE[normalizePostcodeKey(pc)] || null;
}
function cachePostcode(pc, coords) {
  const key = normalizePostcodeKey(pc);
  if (!key || !coords) return;
  if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) return;
  PC_CACHE[key] = { lat: Number(coords.lat), lon: Number(coords.lon) };
}

async function geocodeViaPostcodesIo(rawPostcode) {
  const variants = postcodeVariants(rawPostcode);
  if (!variants.length) return null;

  for (const variant of variants) {
    const formatted = encodeURIComponent(variant);
    let resp = null;
    try {
      resp = await fetch(apiUrl(`/postcodes/postcodes/${formatted}`));
    } catch (_) {
      // ignore
    }
    if (!resp || resp.status === 404) {
      try {
        resp = await fetch(`https://api.postcodes.io/postcodes/${formatted}`);
      } catch (_) {
        resp = null;
      }
    }
    if (!resp || !resp.ok) continue;
    const data = await resp.json();
    if (data.status === 200 && data.result) {
      const lat = Number(data.result.latitude);
      const lon = Number(data.result.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
  }

  const wanted = normalizePostcodeKey(rawPostcode);
  for (const variant of variants) {
    const q = encodeURIComponent(variant);
    let resp = null;
    try {
      resp = await fetch(apiUrl(`/postcodes/postcodes?q=${q}`));
    } catch (_) {
      // ignore
    }
    if (!resp || resp.status === 404) {
      try {
        resp = await fetch(`https://api.postcodes.io/postcodes?q=${q}`);
      } catch (_) {
        resp = null;
      }
    }
    if (!resp || !resp.ok) continue;
    const data = await resp.json();
    const list = Array.isArray(data?.result) ? data.result : [];
    if (!list.length) continue;
    const hit = list.find((r) => normalizePostcodeKey(r.postcode) === wanted) || list[0];
    const lat = Number(hit?.latitude);
    const lon = Number(hit?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  return null;
}

async function geocodeViaOsPlaces(rawPostcode) {
  const variants = postcodeVariants(rawPostcode);
  if (!variants.length) return null;

  for (const variant of variants) {
    const formatted = encodeURIComponent(variant);
    let resp = null;
    try {
      resp = await fetch(apiUrl(`/osplaces/postcode?postcode=${formatted}`));
    } catch (_) {
      resp = null;
    }
    if (!resp || !resp.ok) continue;
    const data = await resp.json();
    if (!Array.isArray(data.results) || !data.results.length) continue;

    const first = data.results[0] || {};
    const rec = first.DPA || first.LPI || {};
    const lat = parseFloat(rec.LAT ?? rec.LATITUDE);
    const lon = parseFloat(rec.LNG ?? rec.LONGITUDE);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  return null;
}

// API-only postcode geocoding with cache + multi-provider fallback.
async function geocodePostcode(rawPostcode) {
  const pc = normalizePostcodeKey(rawPostcode);
  if (!pc) return null;
  const cached = lookupPostcode(pc);
  if (cached) return cached;

  try {
    let coords = await geocodeViaPostcodesIo(rawPostcode);
    if (!coords) {
      coords = await geocodeViaOsPlaces(rawPostcode);
    }
    if (coords) {
      cachePostcode(pc, coords);
      return coords;
    }
  } catch (e) {
    console.warn("postcode geocoding failed:", e);
  }
  return null;
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PSC (Persons with Significant Control)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•



// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MAP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const map = L.map("map", { zoomControl: false }).setView(
  CONTROL_ROOM_CONFIG.map.center, CONTROL_ROOM_CONFIG.map.zoom
);

// Dedicated panes keep routes clickable but below station markers.
map.createPane("tflRoutesPane");
map.getPane("tflRoutesPane").style.zIndex = 430;

map.createPane("tflStationsPane");
map.getPane("tflStationsPane").style.zIndex = 470;

map.createPane("nrRoutesPane");
map.getPane("nrRoutesPane").style.zIndex = 420;

map.createPane("nrStationsPane");
map.getPane("nrStationsPane").style.zIndex = 475;

// Scale bar
L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
L.control.zoom({ position: "bottomleft" }).addTo(map);

function makePanelDraggable(panelEl, handleEl) {
  if (!panelEl || !handleEl) return;
  if (panelEl.dataset.dragInit === "1") return;
  panelEl.dataset.dragInit = "1";
  handleEl.classList.add("panel-draggable-handle");

  const DRAG_MARGIN = 8;
  let dragState = null;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function onPointerMove(e) {
    if (!dragState) return;
    const width = panelEl.offsetWidth || dragState.width;
    const height = panelEl.offsetHeight || dragState.height;
    const maxX = Math.max(DRAG_MARGIN, window.innerWidth - width - DRAG_MARGIN);
    const maxY = Math.max(DRAG_MARGIN, window.innerHeight - height - DRAG_MARGIN);
    const nextLeft = clamp(e.clientX - dragState.dx, DRAG_MARGIN, maxX);
    const nextTop = clamp(e.clientY - dragState.dy, DRAG_MARGIN, maxY);
    panelEl.style.left = `${nextLeft}px`;
    panelEl.style.top = `${nextTop}px`;
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
  }

  function onPointerUp() {
    if (!dragState) return;
    dragState = null;
    panelEl.classList.remove("panel-dragging");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  }

  handleEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, input, select, textarea, a, summary")) return;
    const rect = panelEl.getBoundingClientRect();
    dragState = {
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      width: rect.width,
      height: rect.height
    };
    panelEl.classList.add("panel-dragging");
    panelEl.style.left = `${rect.left}px`;
    panelEl.style.top = `${rect.top}px`;
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    e.preventDefault();
  });
}

// â”€â”€ Tile layers â”€â”€

const tileCfg = CONTROL_ROOM_CONFIG.tiles;
const baseLayers = {};
for (const k in tileCfg) {
  const t = tileCfg[k];
  baseLayers[t.name] = L.tileLayer(t.url, {
    attribution: t.attribution,
    minZoom: CONTROL_ROOM_CONFIG.map.minZoom,
    maxZoom: CONTROL_ROOM_CONFIG.map.maxZoom, ...(t.options || {})
  });
}
baseLayers["Dark"].addTo(map);
let activeBase = "Dark";

// â”€â”€ Overlay layers (ALL OFF by default) â”€â”€

const companyCluster = L.markerClusterGroup({
  chunkedLoading: true, 
  maxClusterRadius: 50,
  spiderfyOnMaxZoom: true, 
  showCoverageOnHover: false, 
  disableClusteringAtZoom: 16,
  spiderfyDistanceMultiplier: 2, // Increase distance between markers when spiderfied
  animate: true,
  animateAddingMarkers: true
});

function getEntityForClusterMarker(marker) {
  const entityId = marker?._entityId;
  if (!entityId) return null;
  return getEntityById(entityId) || null;
}

function getEntityClusterDescriptor(cluster) {
  const markers = cluster?.getAllChildMarkers ? cluster.getAllChildMarkers() : [];
  if (!markers.length) return { title: "", subtitle: "" };

  const companyCounts = new Map();
  let fallback = null;

  markers.forEach((m) => {
    const entity = getEntityForClusterMarker(m);
    if (!entity) return;
    if (!fallback) fallback = entity;

    const companyName =
      String(entity.companyName || "").trim() ||
      getI2ValueFromEntityValues(entity.i2EntityData, ["Organisation Name"]);
    const companyNumber =
      String(entity.companyNumber || "").trim() ||
      getI2ValueFromEntityValues(entity.i2EntityData, ["Company/Registration Number", "Company Number", "Registration Number"]);

    if (companyName || companyNumber) {
      const key = `${companyName}|${companyNumber}`;
      const prev = companyCounts.get(key) || { count: 0, name: companyName, number: companyNumber };
      prev.count += 1;
      companyCounts.set(key, prev);
    }
  });

  let top = null;
  companyCounts.forEach((v) => {
    if (!top || v.count > top.count) top = v;
  });
  if (top) {
    return {
      title: String(top.name || "Company"),
      subtitle: top.number ? `#${top.number}` : ""
    };
  }

  if (fallback) {
    const typeTag = fallback.i2EntityData?.entityName || fallback.iconData?.categoryName || fallback.iconData?.name || "Entity";
    return { title: String(fallback.label || "Entity"), subtitle: String(typeTag) };
  }
  return { title: "", subtitle: "" };
}

function createEntityClusterIcon(cluster) {
  const count = cluster.getChildCount();
  const sizeClass = count < 10 ? "small" : count < 50 ? "medium" : "large";
  const descriptor = getEntityClusterDescriptor(cluster);
  const title = escapeHtml(descriptor.title || "");
  const subtitle = escapeHtml(descriptor.subtitle || "");
  const html = `
    <div class="entity-cluster-content">
      <span class="entity-cluster-count">${count}</span>
      ${title ? `<span class="entity-cluster-title">${title}</span>` : ""}
      ${subtitle ? `<span class="entity-cluster-subtitle">${subtitle}</span>` : ""}
    </div>
  `;
  return L.divIcon({
    html,
    className: `marker-cluster marker-cluster-${sizeClass} entity-cluster-icon`,
    iconSize: L.point(56, 56)
  });
}

// â”€â”€ Connection Lines Layer â”€â”€
const connectionsLayer = L.layerGroup();

// â”€â”€ Custom Entities Layer â”€â”€
const entitiesMarkerCluster = L.markerClusterGroup({
  chunkedLoading: true,
  maxClusterRadius: 42,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  disableClusteringAtZoom: 14,
  spiderfyDistanceMultiplier: 1.4,
  animate: true,
  animateAddingMarkers: true,
  iconCreateFunction: createEntityClusterIcon
});
const entitiesOverlayLayer = L.layerGroup();
const entitiesLayer = L.layerGroup([entitiesMarkerCluster, entitiesOverlayLayer]);

const layers = {
  companies:       companyCluster,
  connections:     connectionsLayer,
  entities:        entitiesLayer,
  areas:           L.featureGroup(),
  airports_uk:     L.featureGroup(),
  airports_global: L.featureGroup(),
  seaports:        L.featureGroup(),
  underground:     L.featureGroup(),
  national_rail:   L.featureGroup(),
  roads:           L.featureGroup(),
  os_roads:        L.featureGroup(),
  os_rail:         L.featureGroup(),
  flights:         L.featureGroup(),
  bikes:           L.featureGroup()
};

// Track connections and entity data
window._mapConnections = [];
window._mapEntities = [];
window._placementMode = null;
window._selectedEntityIds = new Set();

let entityBoxSelectMode = false;
let entityBoxSelectStart = null;
let entityBoxSelectRect = null;
let entityBoxSelectDragging = false;

function isEditingInputTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = String(target.tagName).toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function setEntityMarkerSelectedState(entity, selected) {
  if (!entity?.marker?.getElement) return;
  const el = entity.marker.getElement();
  if (!el) return;
  el.classList.toggle("entity-selected-marker", !!selected);
}

function refreshEntitySelectionStyles() {
  window._mapEntities.forEach((entity) => {
    setEntityMarkerSelectedState(entity, window._selectedEntityIds.has(entity.id));
  });
}

function clearEntitySelection() {
  window._selectedEntityIds.clear();
  refreshEntitySelectionStyles();
}

function selectAllEntities() {
  window._selectedEntityIds.clear();
  window._mapEntities.forEach((entity) => window._selectedEntityIds.add(entity.id));
  refreshEntitySelectionStyles();
  setStatus(`Selected ${window._selectedEntityIds.size} entities`);
}

function applyEntitySelectionBounds(bounds, additive = false) {
  if (!bounds) return;
  if (!additive) window._selectedEntityIds.clear();
  window._mapEntities.forEach((entity) => {
    const latLng = L.latLng(entity.latLng[0], entity.latLng[1]);
    if (bounds.contains(latLng)) window._selectedEntityIds.add(entity.id);
  });
  refreshEntitySelectionStyles();
  setStatus(`Selected ${window._selectedEntityIds.size} entities`);
}

function toggleEntityBoxSelectMode(nextState = null) {
  entityBoxSelectMode = (nextState == null) ? !entityBoxSelectMode : !!nextState;
  if (!entityBoxSelectMode) {
    entityBoxSelectStart = null;
    entityBoxSelectDragging = false;
    if (entityBoxSelectRect) {
      map.removeLayer(entityBoxSelectRect);
      entityBoxSelectRect = null;
    }
  }
  const btn = document.getElementById("entity-select-box");
  if (btn) btn.setAttribute("aria-pressed", entityBoxSelectMode ? "true" : "false");
  map.getContainer().style.cursor = entityBoxSelectMode ? "crosshair" : "";
  if (entityBoxSelectMode) setStatus("Box select enabled: drag on map to select entities");
}

function exportEntitiesToExcel() {
  if (!window.XLSX) {
    alert("Excel export library unavailable. Refresh and try again.");
    return;
  }

  const selectedIds = Array.from(window._selectedEntityIds || []);
  const selectedSet = new Set(selectedIds);
  const exportingSelected = selectedIds.length > 0;
  const entities = exportingSelected
    ? window._mapEntities.filter((e) => selectedSet.has(e.id))
    : [...window._mapEntities];

  if (!entities.length) {
    alert("No entities available to export.");
    return;
  }

  const entityRows = entities.map((entity) => {
    const row = {
      EntityID: entity.id,
      Label: entity.label || "",
      SourceType: entity.sourceType || "",
      Category: entity.iconData?.categoryName || "",
      Icon: entity.iconData?.name || "",
      I2Type: entity.i2EntityData?.entityName || "",
      I2EntityID: entity.i2EntityData?.entityId || "",
      Address: entity.address || "",
      Notes: entity.notes || "",
      Lat: Number(entity.latLng?.[0] || 0),
      Lng: Number(entity.latLng?.[1] || 0)
    };
    (entity.i2EntityData?.values || []).forEach((v) => {
      if (!v?.propertyName) return;
      row[`I2:${v.propertyName}`] = String(v.value ?? "");
    });
    return row;
  });

  const exportedIdSet = new Set(entities.map((e) => e.id));
  const connectionRows = (window._mapConnections || [])
    .filter((c) => c?.metadata?.fromId && c?.metadata?.toId)
    .filter((c) => exportedIdSet.has(c.metadata.fromId) && exportedIdSet.has(c.metadata.toId))
    .map((c) => ({
      ConnectionID: c.id,
      Type: c.type || "",
      Label: c.label || "",
      FromEntityID: c.metadata.fromId || "",
      FromLabel: c.metadata.fromLabel || "",
      ToEntityID: c.metadata.toId || "",
      ToLabel: c.metadata.toLabel || "",
      Detail: c.metadata.hoverDetail || ""
    }));

  const wb = window.XLSX.utils.book_new();
  const wsEntities = window.XLSX.utils.json_to_sheet(entityRows);
  window.XLSX.utils.book_append_sheet(wb, wsEntities, "Entities");
  if (connectionRows.length) {
    const wsLinks = window.XLSX.utils.json_to_sheet(connectionRows);
    window.XLSX.utils.book_append_sheet(wb, wsLinks, "Connections");
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const fileName = `${yyyy}${mm}${dd} - Control Room - Entity Export.xlsx`;
  window.XLSX.writeFile(wb, fileName);
  setStatus(`Exported ${entities.length} entities to ${fileName}`);
}

// Companies starts ON (checked in HTML)
companyCluster.addTo(map);
connectionsLayer.addTo(map);
entitiesLayer.addTo(map);

// Add cluster click behavior for better visibility
companyCluster.on('clusterclick', function(e) {
  // Zoom in and spiderfy for better connection visibility
  const cluster = e.layer;
  const childMarkers = cluster.getAllChildMarkers();
  
  // If few enough markers, spiderfy immediately
  if (childMarkers.length <= 10) {
    cluster.spiderfy();
  }
  
  // Zoom to show all markers with padding
  const group = L.featureGroup(childMarkers);
  map.fitBounds(group.getBounds(), { 
    padding: [100, 100],
    maxZoom: 16
  });
  
  // Visual feedback
  setTimeout(() => {
    cluster.spiderfy();
  }, 300);
});

// Entity click handler for connection drawing
map.on('click', function(e) {
  if (entityBoxSelectMode) return;
  if (connectionDrawingMode) {
    // Check if clicked on an entity
    const clickedEntity = window._mapEntities.find(ent => {
      const dist = map.distance(e.latlng, ent.latLng);
      return dist < 50; // 50 meters tolerance
    });
    
    if (clickedEntity) {
      completeConnection(clickedEntity.id);
    } else {
      cancelConnectionDrawing();
    }
  } else if (window._placementMode) {
    // Entity placement mode
    showEntityPlacementDialog(e.latlng);
  } else {
    // Clear connection highlights when clicking on empty map
    clearConnectionHighlights();
    if (window._selectedTflLineId) {
      window._selectedTflLineId = null;
      window.updateTflLineStylesFromStatus(window._lastTflStatuses || []);
      document.dispatchEvent(new CustomEvent("tfl-line-selection-changed", { detail: { lineId: null } }));
    }
  }
});

map.on("mousedown", function(e) {
  if (!entityBoxSelectMode) return;
  entityBoxSelectStart = e.latlng;
  entityBoxSelectDragging = true;
  if (entityBoxSelectRect) {
    map.removeLayer(entityBoxSelectRect);
    entityBoxSelectRect = null;
  }
  entityBoxSelectRect = L.rectangle(L.latLngBounds(entityBoxSelectStart, entityBoxSelectStart), {
    color: "#22c55e",
    weight: 1.5,
    fillColor: "#22c55e",
    fillOpacity: 0.08,
    dashArray: "4 4"
  }).addTo(map);
});

map.on("mousemove", function(e) {
  if (!entityBoxSelectMode || !entityBoxSelectDragging || !entityBoxSelectRect || !entityBoxSelectStart) return;
  entityBoxSelectRect.setBounds(L.latLngBounds(entityBoxSelectStart, e.latlng));
});

map.on("mouseup", function(e) {
  if (!entityBoxSelectMode || !entityBoxSelectDragging || !entityBoxSelectStart) return;
  const bounds = L.latLngBounds(entityBoxSelectStart, e.latlng);
  entityBoxSelectDragging = false;
  entityBoxSelectStart = null;
  if (entityBoxSelectRect) {
    map.removeLayer(entityBoxSelectRect);
    entityBoxSelectRect = null;
  }
  if (bounds.isValid()) {
    applyEntitySelectionBounds(bounds, e.originalEvent?.ctrlKey || e.originalEvent?.metaKey);
  }
  toggleEntityBoxSelectMode(false);
});

function showEntityPlacementDialog(latLng) {
  const category = window._placementMode;
  if (!category) return;
  
  // Store the lat/lng for later use
  window._pendingEntityLatLng = latLng;
  
  // Open the entity placement panel
  const panel = document.getElementById('entity-placement-panel');
  panel.classList.add('open');
  panel.classList.remove('minimized');
  
  // Populate category dropdown
  const categorySelect = document.getElementById('entity-category');
  categorySelect.innerHTML = '<option value="">Select category...</option>';
  for (const [catKey, catData] of Object.entries(ICON_CATEGORIES)) {
    const option = document.createElement('option');
    option.value = catKey;
    option.textContent = catData.name;
    if (catKey === category) {
      option.selected = true;
    }
    categorySelect.appendChild(option);
  }
  
  // Pre-populate icons for the selected category
  updateIconDropdown(category);
  const typeSelect = document.getElementById("entity-i2-type");
  if (typeSelect && !I2_CATALOG_LOADED) {
    typeSelect.innerHTML = '<option value="">Loading i2 entity types...</option>';
  }
  populateI2EntityTypeSelect(category);
  ensureI2EntityCatalogLoaded(category);
  
  // Update coordinates display
  const coordPair = normalizeLatLng(latLng);
  document.getElementById('entity-coords').textContent = `${coordPair[0].toFixed(5)}, ${coordPair[1].toFixed(5)}`;
  
  // Avoid auto-focus to prevent viewport jump when selecting entity types.
}

function toggleEntityPanelMinimized() {
  const panel = document.getElementById("entity-placement-panel");
  const btn = document.getElementById("entity-panel-minimize");
  if (!panel || !btn) return;
  const nextMinimized = !panel.classList.contains("minimized");
  panel.classList.toggle("minimized", nextMinimized);
  btn.textContent = nextMinimized ? "+" : "-";
  btn.title = nextMinimized ? "Restore panel" : "Minimize panel";
}

function normalizeLatLng(latLng) {
  if (Array.isArray(latLng) && latLng.length >= 2) {
    return [Number(latLng[0]), Number(latLng[1])];
  }
  if (latLng && typeof latLng === "object" && Number.isFinite(latLng.lat) && Number.isFinite(latLng.lng)) {
    return [Number(latLng.lat), Number(latLng.lng)];
  }
  return [NaN, NaN];
}

function updateIconDropdown(category) {
  const iconSelect = document.getElementById('entity-icon');
  const picker = document.getElementById("entity-icon-picker");
  if (!iconSelect) return;
  iconSelect.innerHTML = '<option value="">Select icon...</option>';
  if (picker) picker.innerHTML = "";
  
  if (!category || !ICON_CATEGORIES[category]) {
    updateEntityIconPreview("", NaN);
    return;
  }
  
  const icons = ICON_CATEGORIES[category].icons;
  icons.forEach((iconData, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = iconData.name;
    iconSelect.appendChild(option);
  });
  if (icons.length) {
    iconSelect.value = "0";
    renderEntityIconPicker(category, 0);
    updateEntityIconPreview(category, 0);
  } else {
    renderEntityIconPicker("", NaN);
    updateEntityIconPreview("", NaN);
  }
}

function renderEntityIconPicker(category, selectedIndex) {
  const picker = document.getElementById("entity-icon-picker");
  const iconSelect = document.getElementById("entity-icon");
  if (!picker || !iconSelect) return;
  picker.innerHTML = "";
  if (!category || !ICON_CATEGORIES[category]) return;
  const icons = ICON_CATEGORIES[category].icons || [];
  icons.slice(0, 32).forEach((iconData, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "entity-icon-pick" + (Number(selectedIndex) === idx ? " active" : "");
    btn.title = iconData.name || `Icon ${idx + 1}`;
    btn.innerHTML = `<img src="${escapeHtml(iconData.icon || "")}" alt="${escapeHtml(iconData.name || "")}">`;
    btn.addEventListener("click", () => {
      iconSelect.value = String(idx);
      ENTITY_ICON_MANUAL_OVERRIDE = true;
      renderEntityIconPicker(category, idx);
      updateEntityIconPreview(category, idx);
    });
    picker.appendChild(btn);
  });
}

function updateEntityIconPreview(category, iconIndex) {
  const img = document.getElementById("entity-icon-preview-img");
  const label = document.getElementById("entity-icon-preview-label");
  if (!img || !label) return;
  const cat = ICON_CATEGORIES[category];
  const idx = Number(iconIndex);
  const icon = cat && Number.isFinite(idx) ? cat.icons[idx] : null;
  if (!icon || !icon.icon) {
    img.style.display = "none";
    img.onerror = null;
    img.src = "";
    label.textContent = "No icon selected";
    return;
  }
  img.onerror = () => {
    const fallback = cat?.defaultIcon || "";
    if (fallback && img.src !== fallback) {
      img.src = fallback;
      return;
    }
    img.style.display = "none";
  };
  img.src = icon.icon;
  img.style.display = "";
  label.textContent = icon.name || "Selected icon";
  renderEntityIconPicker(category, idx);
}

function closeEntityPanel() {
  const panel = document.getElementById('entity-placement-panel');
  panel.classList.remove('open');
  panel.classList.remove("minimized");
  panel.style.left = "";
  panel.style.top = "";
  panel.style.right = "";
  panel.style.bottom = "";
  const minBtn = document.getElementById("entity-panel-minimize");
  if (minBtn) {
    minBtn.textContent = "-";
    minBtn.title = "Minimize panel";
  }
  
  // Clear form
  document.getElementById('entity-placement-form').reset();
  updateEntityIconPreview("", NaN);
  document.getElementById('entity-coords').textContent = '--';
  const i2Fields = document.getElementById("entity-i2-fields");
  if (i2Fields) {
    i2Fields.innerHTML = '<div class="entity-i2-fields-empty">Select an i2 entity type to capture structured properties.</div>';
  }
  
  // Cancel placement mode
  cancelPlacementMode();
}

function getI2EntityByKey(key) {
  if (!key) return null;
  return I2_ENTITY_BY_ID[String(key).toUpperCase()] || I2_ENTITY_BY_NAME[String(key).toLowerCase()] || null;
}

function defaultI2EntityForCategory(category) {
  const preferred = I2_DEFAULT_BY_CATEGORY[category];
  return preferred ? (getI2EntityByKey(preferred) || null) : null;
}

function defaultCategoryForI2Entity(entityTypeKey) {
  const entity = getI2EntityByKey(entityTypeKey);
  if (!entity) return "";
  const name = String(entity.entity_name || "").toLowerCase();
  if (I2_ENTITY_TO_CATEGORY[name]) return I2_ENTITY_TO_CATEGORY[name];

  if (/(person|subject|individual|officer|witness|suspect|victim|alias)/.test(name)) return "people";
  if (/(operation|military|firearm|weapon|explosive|ordnance|mission|unit|sigint)/.test(name)) return "military";
  if (/(communication|phone|email|mobile|device|call|internet|ip|imsi|imei|number|mac address|ip address)/.test(name)) return "communication";
  if (/(aircraft|flight|aviation|airport|airline|helicopter)/.test(name)) return "aviation";
  if (/(vehicle|car|van|truck|lorry|boat|vessel|ship|train|bus|taxi|motor)/.test(name)) return "vehicles";
  if (/(organisation|organization|company|business|account|bank|finance|transaction)/.test(name)) return "financial";
  if (/(location|address|site|premises|property|building|place|town|city|postcode|port|airport|station)/.test(name)) return "buildings";
  if (/(social|facebook|twitter|instagram|telegram|whatsapp|online|profile)/.test(name)) return "social";
  return "people";
}

function getI2EntityIconSearchText(entity) {
  if (!entity) return "";
  const props = Array.isArray(entity.properties) ? entity.properties : [];
  const propNames = props.map((p) => String(p.property_name || p.property_id || ""));
  return [
    String(entity.entity_name || ""),
    String(entity.entity_id || ""),
    ...propNames
  ].join(" ").toLowerCase();
}

const I2_ENTITY_ICON_RULES = [
  { re: /\b(mac address|ip address|ip lease data|url|wifi access point)\b/, category: "communication", iconId: "smartphone" },
  { re: /\b(imei|imsi|iccid|comms data record|communication other data|communication entity)\b/, category: "communication", iconId: "mobile_phone" },
  { re: /\b(message|sms|text extraction)\b/, category: "communication", iconId: "sms" },
  { re: /\b(email)\b/, category: "communication", iconId: "email" },
  { re: /\b(passport|driving licence|identification document|document|image|exhibit)\b/, category: "people", iconId: "person" },
  { re: /\b(aircraft|flight|airport|travel)\b/, category: "aviation", iconId: "aircraft" },
  { re: /\b(vessel|maritime event|outboard motor|ship|boat)\b/, category: "military", iconId: "mil_naval" },
  { re: /\b(operation|jfc tracker|surveillance log|ocg|action fraud|intel|intelligence)\b/, category: "military", iconId: "mil_intel" },
  { re: /\b(firearm|ammunition|weapon)\b/, category: "military", iconId: "mil_unit" },
  { re: /\b(location|building|address|postcode)\b/, category: "buildings", iconId: "building" },
  { re: /\b(organisation|organization|team|company)\b/, category: "buildings", iconId: "office" },
  { re: /\b(financial account|cash|card|bank)\b/, category: "financial", iconId: "bank" },
  { re: /\b(vehicle|trailer)\b/, category: "vehicles", iconId: "car" },
  { re: /\b(person|alias|contact|subscriber)\b/, category: "people", iconId: "person" }
];

function getIconByCategoryAndId(category, iconId) {
  const cat = ICON_CATEGORIES[category];
  if (!cat) return null;
  const icon = (cat.icons || []).find((i) => i.id === iconId);
  return icon ? { category, icon } : null;
}

function findBestIconForEntityText(categoryKey, searchText) {
  const normalized = String(searchText || "").toLowerCase();
  const categories = categoryKey && ICON_CATEGORIES[categoryKey]
    ? [[categoryKey, ICON_CATEGORIES[categoryKey]]]
    : Object.entries(ICON_CATEGORIES);

  let best = null;
  let bestScore = -1;
  for (const [cid, cat] of categories) {
    for (const icon of cat.icons) {
      let score = 0;
      for (const kw of icon.keywords || []) {
        const token = String(kw || "").toLowerCase();
        if (!token) continue;
        if (normalized.includes(` ${token} `) || normalized.startsWith(`${token} `) || normalized.endsWith(` ${token}`) || normalized === token) {
          score += 8;
        } else if (normalized.includes(token)) {
          score += 4;
        }
      }
      if (categoryKey && cid === categoryKey) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = { category: cid, icon };
      }
    }
  }
  return bestScore > 0 ? best : null;
}

function chooseIconForI2Entity(entity) {
  const searchText = getI2EntityIconSearchText(entity);
  for (const rule of I2_ENTITY_ICON_RULES) {
    if (!rule.re.test(searchText)) continue;
    const forced = getIconByCategoryAndId(rule.category, rule.iconId);
    if (forced) return forced;
  }
  const category = defaultCategoryForI2Entity(entity?.entity_id || entity?.entity_name || "") || "people";
  const catData = ICON_CATEGORIES[category] || ICON_CATEGORIES.people;
  const bestInCategory = findBestIconForEntityText(category, searchText);
  if (bestInCategory?.icon) {
    return { category, icon: bestInCategory.icon };
  }
  const globalBest = findBestIconForEntityText("", searchText);
  if (globalBest?.icon) {
    return globalBest;
  }
  return { category, icon: catData.icons[0] };
}

async function startI2EntityPlacement(entityTypeId) {
  if (!I2_CATALOG_LOADED) {
    await ensureI2EntityCatalogLoaded();
  }
  const entityDef = getI2EntityByKey(entityTypeId);
  if (!entityDef) return;

  const chosen = chooseIconForI2Entity(entityDef);
  const category = chosen.category;
  startPlacementMode(category);
  showEntityPlacementDialog(map.getCenter());

  const categorySelect = document.getElementById("entity-category");
  const typeSelect = document.getElementById("entity-i2-type");
  const iconSelect = document.getElementById("entity-icon");
  const labelInput = document.getElementById("entity-label");
  const placementAddressInput = document.getElementById("entity-placement-address");

  if (categorySelect) {
    categorySelect.value = category;
    updateIconDropdown(category);
  }
  if (typeSelect) {
    typeSelect.value = entityDef.entity_id;
    renderI2FieldsForType(entityDef.entity_id);
  }
  if (iconSelect) {
    const idx = (ICON_CATEGORIES[category]?.icons || []).findIndex((ic) => ic.id === chosen.icon.id);
    if (idx >= 0) {
      iconSelect.value = String(idx);
      updateEntityIconPreview(category, idx);
    }
  }

  ENTITY_ICON_MANUAL_OVERRIDE = false;
  autoSelectIconFromI2Fields(true);
  if (labelInput) labelInput.value = "";
  if (placementAddressInput) placementAddressInput.value = "";
  setStatus(`Placing ${entityDef.entity_name}: set fields and submit to place on map`);
}

const I2_FIELD_PRIORITY = [
  "Full Name",
  "First Name",
  "Middle Name",
  "Surname",
  "Date of Birth",
  "Gender",
  "Organisation Name",
  "Organisation Type",
  "Company/Registration Number",
  "VRM",
  "Registration Mark",
  "Vehicle Type",
  "Vehicle Make",
  "Vehicle Model",
  "Address String",
  "Building Number",
  "Street Name",
  "Town/City",
  "Post Code",
  "Country or Region",
  "Location Type",
  "Intelligence Date",
  "IR or Reference",
  "Additional Information"
];

const I2_LOW_VALUE_FIELDS = new Set([
  "Maiden Name",
  "Warning Marker",
  "Warning Marker 2",
  "Warning Marker 3",
  "Warning Marker 4",
  "Warning Marker Additional Notes",
  "Name"
]);

const I2_PLACEMENT_REQUIRED_FIELDS = {
  person: ["First Name", "Surname", "Full Name"],
  organisation: ["Organisation Name"],
  location: ["Location Type", "Address String", "Post Code", "Town/City"],
  vehicle: ["VRM", "Vehicle Make", "Vehicle Model"],
  aircraft: ["Registration Mark", "Type", "Manufacturer"],
  "financial account": ["Account Number", "IBAN", "Sort Code"]
};

let ENTITY_ICON_MANUAL_OVERRIDE = false;

function i2FieldPriorityScore(prop) {
  const mandatory = String(prop.mandatory || "").toLowerCase() === "true";
  const name = String(prop.property_name || "");
  if (/^(date of birth|dob)$/i.test(name)) {
    return (mandatory ? -1000 : 0) + 2;
  }
  const idx = I2_FIELD_PRIORITY.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  const priority = idx >= 0 ? idx : 999;
  return (mandatory ? -1000 : 0) + priority;
}

function isPlacementRequiredField(entityName, propName, mandatory) {
  const e = String(entityName || "").toLowerCase();
  const p = String(propName || "");
  const requiredList = I2_PLACEMENT_REQUIRED_FIELDS[e] || [];
  if (requiredList.some((x) => String(x).toLowerCase() === p.toLowerCase())) return true;
  // Keep strict requirement only where it's the lone mandatory structural anchor.
  if (mandatory && /^(location type|organisation name|vrm|registration mark)$/i.test(p)) return true;
  return false;
}

function getWarningMarkerMeta(propertyName) {
  const name = String(propertyName || "").trim().toLowerCase();
  if (name === "warning marker") return { level: 1 };
  if (name === "warning marker 2") return { level: 2 };
  if (name === "warning marker 3") return { level: 3 };
  if (name === "warning marker 4") return { level: 4 };
  if (name === "warning marker additional notes") return { notes: true };
  return null;
}

function buildI2FieldInput(prop, index, entityName = "") {
  const fieldId = `entity-i2-prop-${index}`;
  const mandatory = String(prop.mandatory || "").toLowerCase() === "true";
  const placementRequired = isPlacementRequiredField(entityName, prop.property_name, mandatory);
  const logicalType = String(prop.logical_type || "").toUpperCase();
  const possibleValues = Array.isArray(prop.possible_values) ? prop.possible_values.filter(Boolean) : [];
  const warningMeta = getWarningMarkerMeta(prop.property_name);
  const warningAttrs = warningMeta
    ? (warningMeta.level
      ? ` data-warning-level="${warningMeta.level}"`
      : ` data-warning-notes="1"`)
    : "";

  let inputHtml = "";
  if ((logicalType === "SELECTED_FROM" || logicalType === "SUGGESTED_FROM") && possibleValues.length) {
    const options = ['<option value="">Select...</option>']
      .concat(possibleValues.map((v) => `<option value="${escapeHtml(String(v))}">${escapeHtml(String(v))}</option>`))
      .join("");
    inputHtml = `<select id="${fieldId}" data-i2-property-id="${escapeHtml(prop.property_id)}" data-i2-property-name="${escapeHtml(prop.property_name)}" data-i2-logical-type="${escapeHtml(logicalType)}" ${placementRequired ? "required" : ""}>${options}</select>`;
  } else if (logicalType === "MULTIPLE_LINE_STRING") {
    inputHtml = `<textarea id="${fieldId}" rows="2" data-i2-property-id="${escapeHtml(prop.property_id)}" data-i2-property-name="${escapeHtml(prop.property_name)}" data-i2-logical-type="${escapeHtml(logicalType)}" ${placementRequired ? "required" : ""}></textarea>`;
  } else if (logicalType === "DATE") {
    inputHtml = `<input id="${fieldId}" type="date" data-i2-property-id="${escapeHtml(prop.property_id)}" data-i2-property-name="${escapeHtml(prop.property_name)}" data-i2-logical-type="${escapeHtml(logicalType)}" ${placementRequired ? "required" : ""}>`;
  } else if (logicalType === "DATE_AND_TIME") {
    inputHtml = `<input id="${fieldId}" type="datetime-local" data-i2-property-id="${escapeHtml(prop.property_id)}" data-i2-property-name="${escapeHtml(prop.property_name)}" data-i2-logical-type="${escapeHtml(logicalType)}" ${placementRequired ? "required" : ""}>`;
  } else if (logicalType === "INTEGER") {
    inputHtml = `<input id="${fieldId}" type="number" step="1" data-i2-property-id="${escapeHtml(prop.property_id)}" data-i2-property-name="${escapeHtml(prop.property_name)}" data-i2-logical-type="${escapeHtml(logicalType)}" ${placementRequired ? "required" : ""}>`;
  } else if (logicalType === "DECIMAL") {
    inputHtml = `<input id="${fieldId}" type="number" step="any" data-i2-property-id="${escapeHtml(prop.property_id)}" data-i2-property-name="${escapeHtml(prop.property_name)}" data-i2-logical-type="${escapeHtml(logicalType)}" ${placementRequired ? "required" : ""}>`;
  } else {
    inputHtml = `<input id="${fieldId}" type="text" data-i2-property-id="${escapeHtml(prop.property_id)}" data-i2-property-name="${escapeHtml(prop.property_name)}" data-i2-logical-type="${escapeHtml(logicalType)}" ${placementRequired ? "required" : ""}>`;
  }

  return (
    `<div class="entity-i2-field-row"${warningAttrs}>` +
      `<label for="${fieldId}">${escapeHtml(prop.property_name)}${placementRequired ? " *" : ""}</label>` +
      inputHtml +
      `<div class="entity-i2-meta">${escapeHtml(prop.property_id)} | ${escapeHtml(logicalType || "TEXT")}${mandatory && !placementRequired ? " | i2 mandatory" : ""}</div>` +
    `</div>`
  );
}

function renderI2FieldsForType(entityTypeKey) {
  const fieldsContainer = document.getElementById("entity-i2-fields");
  if (!fieldsContainer) return;
  const entity = getI2EntityByKey(entityTypeKey);
  if (!entity) {
    fieldsContainer.innerHTML = '<div class="entity-i2-fields-empty">Select an i2 entity type to capture structured properties.</div>';
    return;
  }

  const entityName = String(entity.entity_name || "");
  const properties = Array.isArray(entity.properties) ? entity.properties : [];
  const hasFullName = properties.some((p) => String(p.property_name || "").toLowerCase() === "full name");

  const core = [];
  const advanced = [];
  for (const prop of properties) {
    const name = String(prop.property_name || "");
    const mandatory = String(prop.mandatory || "").toLowerCase() === "true";
    const redundantName = hasFullName && name.toLowerCase() === "name";
    const personRedundantName = entityName.toLowerCase() === "person" && redundantName;
    const lowValue = I2_LOW_VALUE_FIELDS.has(name) || redundantName;
    const placementRequired = isPlacementRequiredField(entityName, name, mandatory);
    const topPriority = i2FieldPriorityScore(prop) < 12;
    if (!personRedundantName && (placementRequired || topPriority)) {
      core.push(prop);
    } else if (!mandatory && lowValue) {
      advanced.push(prop);
    } else {
      advanced.push(prop);
    }
  }

  core.sort((a, b) => i2FieldPriorityScore(a) - i2FieldPriorityScore(b));
  advanced.sort((a, b) => i2FieldPriorityScore(a) - i2FieldPriorityScore(b));
  const mandatoryCount = properties.filter((p) => String(p.mandatory || "").toLowerCase() === "true").length;

  const header = `<div class="entity-i2-fields-title">${escapeHtml(entity.entity_name)} (${escapeHtml(entity.entity_id)}) - ${mandatoryCount} i2 mandatory field${mandatoryCount === 1 ? "" : "s"} (only essential fields required for placement)</div>`;
  const coreHtml = core.map((prop, idx) => buildI2FieldInput(prop, idx, entityName)).join("");
  const advancedHtml = advanced.length
    ? (
      `<details class="entity-i2-advanced">` +
      `<summary>Additional fields (${advanced.length})</summary>` +
      advanced.map((prop, idx) => buildI2FieldInput(prop, core.length + idx, entityName)).join("") +
      `</details>`
    ) : "";
  fieldsContainer.innerHTML = header + coreHtml + advancedHtml;
  updateWarningMarkerVisibility();
}

function populateI2EntityTypeSelect(selectedCategory = "") {
  const select = document.getElementById("entity-i2-type");
  if (!select) return;
  if (!I2_ENTITY_CATALOG.length) {
    select.innerHTML = '<option value="">i2 catalog unavailable</option>';
    return;
  }

  select.innerHTML = '<option value="">Select i2 entity type...</option>';
  I2_ENTITY_CATALOG.forEach((entity) => {
    const opt = document.createElement("option");
    opt.value = entity.entity_id;
    opt.textContent = `${entity.entity_name} (${entity.entity_id})`;
    select.appendChild(opt);
  });

  const fallback = defaultI2EntityForCategory(selectedCategory) || I2_ENTITY_CATALOG[0];
  if (fallback) {
    select.value = fallback.entity_id;
    renderI2FieldsForType(fallback.entity_id);
  }
}

async function initI2EntityCatalog() {
  if (I2_CATALOG_LOADED) return;
  try {
    const resp = await fetch("data/i2 Specs/parsed/entity_catalog.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const list = await resp.json();
    I2_ENTITY_CATALOG = Array.isArray(list) ? list : [];
    I2_ENTITY_CATALOG.forEach((entity) => {
      if (!entity || !entity.entity_id) return;
      I2_ENTITY_BY_ID[String(entity.entity_id).toUpperCase()] = entity;
      I2_ENTITY_BY_NAME[String(entity.entity_name || "").toLowerCase()] = entity;
    });
  } catch (err) {
    console.warn("Could not load i2 entity catalog for placement form:", err);
    I2_ENTITY_CATALOG = [];
  }
  I2_CATALOG_LOADED = true;
  populateI2EntityTypeSelect();
}

function ensureI2EntityCatalogLoaded(selectedCategory = "") {
  if (I2_CATALOG_LOADED) {
    if (selectedCategory) populateI2EntityTypeSelect(selectedCategory);
    return Promise.resolve(true);
  }
  if (!I2_CATALOG_LOADING_PROMISE) {
    I2_CATALOG_LOADING_PROMISE = initI2EntityCatalog()
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        I2_CATALOG_LOADING_PROMISE = null;
      });
  }
  return I2_CATALOG_LOADING_PROMISE.then((ok) => {
    if (ok && selectedCategory) populateI2EntityTypeSelect(selectedCategory);
    return ok;
  });
}

function collectI2EntityFormData() {
  // Ensure Address String has propagated into structured fields before validation/export.
  syncAddressStringDerivedFields();

  const typeSelect = document.getElementById("entity-i2-type");
  const entityTypeId = typeSelect?.value || "";
  const entityDef = getI2EntityByKey(entityTypeId);
  if (!entityDef) return null;

  const values = {};
  const fields = document.querySelectorAll("#entity-i2-fields [data-i2-property-id]");
  for (const field of fields) {
    const propertyId = field.dataset.i2PropertyId || "";
    const propertyName = field.dataset.i2PropertyName || propertyId;
    const logicalType = field.dataset.i2LogicalType || "";
    const required = field.hasAttribute("required");
    const raw = String(field.value || "").trim();
    if (required && !raw) {
      return { error: `Missing mandatory i2 field: ${propertyName}` };
    }
    if (!raw) continue;
    values[propertyId] = {
      propertyId,
      propertyName,
      logicalType,
      value: raw,
      mandatory: required
    };
  }

  return {
    entityId: entityDef.entity_id,
    entityName: entityDef.entity_name,
    values
  };
}

function inferEntityLabel(inputLabel, i2EntityData, fallbackName) {
  const direct = String(inputLabel || "").trim();
  if (direct) return direct;
  if (!i2EntityData || !i2EntityData.values) return fallbackName;

  const vals = Object.values(i2EntityData.values);
  const byName = (needle) => vals.find((v) => String(v.propertyName || "").toLowerCase() === needle.toLowerCase())?.value || "";

  if (String(i2EntityData.entityName || "").toLowerCase() === "person") {
    const full = byName("Full Name") || byName("Name");
    if (full) return full;
    const first = byName("First Name");
    const sur = byName("Surname");
    const assembled = `${first} ${sur}`.trim();
    if (assembled) return assembled;
  }

  const firstValue = vals[0]?.value;
  return firstValue || fallbackName;
}

function inferEntityAddress(i2EntityData) {
  if (!i2EntityData || !i2EntityData.values) return "";
  const vals = Object.values(i2EntityData.values);
  const byName = (needle) => vals.find((v) => String(v.propertyName || "").toLowerCase() === needle.toLowerCase())?.value || "";
  const direct = byName("Address String");
  if (direct) return direct;

  const parts = [
    byName("Building Number"),
    byName("Street Name"),
    byName("Town/City"),
    byName("Post Code")
  ].filter(Boolean);
  return parts.join(", ");
}

function inferEntityNotes(i2EntityData) {
  if (!i2EntityData || !i2EntityData.values) return "";
  const vals = Object.values(i2EntityData.values);
  const byName = (needle) => vals.find((v) => String(v.propertyName || "").toLowerCase() === needle.toLowerCase())?.value || "";
  return (
    byName("Additional Information") ||
    byName("Description") ||
    byName("Reason for De-Reg") ||
    byName("3x5x2 Notes") ||
    ""
  );
}

function getI2ValueByNames(i2EntityData, names) {
  if (!i2EntityData || !i2EntityData.values) return "";
  const vals = Object.values(i2EntityData.values);
  for (const n of names || []) {
    const hit = vals.find((v) => String(v.propertyName || "").toLowerCase() === String(n || "").toLowerCase());
    if (hit && String(hit.value || "").trim()) return String(hit.value || "").trim();
  }
  return "";
}

function getI2FieldByNames(names) {
  const fields = document.querySelectorAll("#entity-i2-fields [data-i2-property-name]");
  for (const field of fields) {
    const pname = String(field.dataset.i2PropertyName || "").toLowerCase();
    if ((names || []).some((n) => pname === String(n || "").toLowerCase())) {
      return field;
    }
  }
  return null;
}

function setI2FieldIfEmpty(names, value) {
  const val = String(value || "").trim();
  if (!val) return false;
  const field = getI2FieldByNames(names);
  if (!field) return false;
  const current = String(field.value || "").trim();
  const auto = String(field.dataset.autogen || "") === "1";
  if (current && !auto) return false;
  if (current === val && auto) return false;
  field.value = val;
  field.dataset.autogen = "1";
  return true;
}

function parseAddressString(rawAddress) {
  const address = String(rawAddress || "").trim();
  if (!address) return null;

  const out = {
    buildingNumber: "",
    streetName: "",
    town: "",
    county: "",
    postcode: "",
    country: ""
  };

  const cleaned = address.replace(/\s+/g, " ").trim();
  const ukPostcodeMatch = cleaned.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
  if (ukPostcodeMatch) {
    out.postcode = ukPostcodeMatch[1].toUpperCase().replace(/\s+/g, "");
  }

  // Remove postcode from tail before splitting locality tokens.
  const withoutPostcode = out.postcode
    ? cleaned.replace(new RegExp(out.postcode.replace(/\s*/g, "\\s*"), "i"), "").replace(/,\s*$/, "").trim()
    : cleaned;

  const parts = withoutPostcode.split(",").map((p) => p.trim()).filter(Boolean);
  const first = parts[0] || "";

  const firstMatch = first.match(/^(\d+[A-Z]?)\s+(.+)$/i);
  if (firstMatch) {
    out.buildingNumber = firstMatch[1].trim();
    out.streetName = firstMatch[2].trim();
  } else if (first) {
    // Keep full first token as street/address fragment when no obvious number.
    out.streetName = first;
  }

  if (parts.length > 1) out.town = parts[1];
  if (parts.length > 2) out.county = parts[2];
  if (parts.length > 3) out.country = parts[3];

  return out;
}

function composeAddressFromStructuredFields() {
  const building = getEntityFieldValueByName("Building Number");
  const street = getEntityFieldValueByName("Street Name");
  const town = getEntityFieldValueByName("Town/City");
  const county = getEntityFieldValueByName("County or State");
  const postcode = getEntityFieldValueByName("Post Code");
  const country = getEntityFieldValueByName("Country or Region");

  const line1 = [building, street].filter(Boolean).join(" ").trim();
  const parts = [line1, town, county, postcode, country].filter(Boolean);
  return parts.join(", ");
}

function syncStructuredFieldsToAddressString() {
  const addrField = getI2FieldByNames(["Address String", "Address"]);
  if (!addrField) return false;
  const current = String(addrField.value || "").trim();
  const allowOverwrite = !current || String(addrField.dataset.autogen || "") === "1";
  if (!allowOverwrite) return false;

  const composed = composeAddressFromStructuredFields();
  if (!composed) return false;
  addrField.value = composed;
  addrField.dataset.autogen = "1";
  return true;
}

function syncAddressStringDerivedFields() {
  const addrField = getI2FieldByNames(["Address String", "Address"]);
  if (!addrField) return false;
  const currentAddress = String(addrField.value || "").trim();
  if (!currentAddress) {
    return syncStructuredFieldsToAddressString();
  }
  const parsed = parseAddressString(currentAddress);
  if (!parsed) return false;
  // User-provided address string is source; mark non-autogenerated while user edits.
  if (document.activeElement === addrField) {
    addrField.dataset.autogen = "0";
  }

  let updated = false;
  updated = setI2FieldIfEmpty(["Building Number", "House Number"], parsed.buildingNumber) || updated;
  updated = setI2FieldIfEmpty(["Street Name", "Street"], parsed.streetName) || updated;
  updated = setI2FieldIfEmpty(["Town/City", "Town", "City", "Locality"], parsed.town) || updated;
  updated = setI2FieldIfEmpty(["County or State", "County", "State"], parsed.county) || updated;
  updated = setI2FieldIfEmpty(["Post Code", "Postal Code", "Postcode"], parsed.postcode) || updated;
  updated = setI2FieldIfEmpty(["Country or Region", "Country"], parsed.country) || updated;

  return syncStructuredFieldsToAddressString() || updated;
}

function getEntityFieldValueByName(fieldName) {
  const fields = document.querySelectorAll("#entity-i2-fields [data-i2-property-name]");
  for (const field of fields) {
    if (String(field.dataset.i2PropertyName || "").toLowerCase() === String(fieldName || "").toLowerCase()) {
      return String(field.value || "").trim();
    }
  }
  return "";
}

function setCategoryIconById(category, iconId) {
  const iconSelect = document.getElementById("entity-icon");
  if (!iconSelect || !category || !ICON_CATEGORIES[category]) return false;
  const idx = ICON_CATEGORIES[category].icons.findIndex((icon) => icon.id === iconId);
  if (idx < 0) return false;
  iconSelect.value = String(idx);
  updateEntityIconPreview(category, idx);
  return true;
}

function autoSelectIconFromI2Fields(force = false) {
  const category = document.getElementById("entity-category")?.value || "";
  if (!category || !ICON_CATEGORIES[category]) return;
  if (!force && ENTITY_ICON_MANUAL_OVERRIDE) return;

  const locationType = getEntityFieldValueByName("Location Type").toLowerCase();

  if (category === "buildings" && locationType) {
    if (/(town|city|village|region)/.test(locationType)) {
      if (setCategoryIconById(category, "building")) return;
    }
    if (/(home|residence|house|address)/.test(locationType)) {
      if (setCategoryIconById(category, "house")) return;
    }
    if (/(factory|warehouse|industrial)/.test(locationType)) {
      if (setCategoryIconById(category, "factory")) return;
    }
  }

  if (category === "financial" && /(bank)/.test(locationType)) {
    if (setCategoryIconById(category, "bank")) return;
  }

  if (category === "aviation") {
    if (/(airport|terminal|runway|airfield)/.test(locationType)) {
      if (setCategoryIconById(category, "airport")) return;
    }
    const aircraftHints = [
      getEntityFieldValueByName("Registration Mark"),
      getEntityFieldValueByName("Aircraft class"),
      getEntityFieldValueByName("Type"),
      getEntityFieldValueByName("Manufacturer")
    ].join(" ").toLowerCase();
    if (/(aircraft|plane|jet|boeing|airbus|cessna|helicopter|flight)/.test(aircraftHints)) {
      if (setCategoryIconById(category, "aircraft")) return;
    }
  }

  if (category === "people") {
    const gender = getEntityFieldValueByName("Gender").toLowerCase();
    const title = getEntityFieldValueByName("Title").toLowerCase();
    if (/(^|\b)(male|man|boy)(\b|$)/.test(gender) || /(^|\b)(mr|sir)(\b|$)/.test(title)) {
      if (setCategoryIconById(category, "man")) return;
    }
    if (/(^|\b)(female|woman|girl)(\b|$)/.test(gender) || /(^|\b)(ms|mrs|miss|madam)(\b|$)/.test(title)) {
      if (setCategoryIconById(category, "woman")) return;
    }
  }

  const hintText = [
    document.getElementById("entity-label")?.value || "",
    getEntityFieldValueByName("Full Name"),
    getEntityFieldValueByName("Name"),
    getEntityFieldValueByName("Organisation Name"),
    getEntityFieldValueByName("Location Type"),
    getEntityFieldValueByName("Vehicle Type"),
    getEntityFieldValueByName("Manufacturer")
  ].filter(Boolean).join(" ");

  if (hintText) {
    const suggested = suggestIcon(hintText, category);
    if (suggested) {
      const idx = ICON_CATEGORIES[category].icons.findIndex((icon) => icon.name === suggested.name);
      if (idx >= 0) {
        document.getElementById("entity-icon").value = String(idx);
      }
    }
  }
}

function updateWarningMarkerVisibility() {
  const wrap = document.getElementById("entity-i2-fields");
  if (!wrap) return;
  const row1 = wrap.querySelector('[data-warning-level="1"]');
  const row2 = wrap.querySelector('[data-warning-level="2"]');
  const row3 = wrap.querySelector('[data-warning-level="3"]');
  const row4 = wrap.querySelector('[data-warning-level="4"]');
  const notes = wrap.querySelector('[data-warning-notes="1"]');
  const val1 = row1 ? String(row1.querySelector("[data-i2-property-id]")?.value || "").trim() : "";
  const val2 = row2 ? String(row2.querySelector("[data-i2-property-id]")?.value || "").trim() : "";
  const val3 = row3 ? String(row3.querySelector("[data-i2-property-id]")?.value || "").trim() : "";
  const val4 = row4 ? String(row4.querySelector("[data-i2-property-id]")?.value || "").trim() : "";

  const setVisible = (row, show) => {
    if (!row) return;
    row.style.display = show ? "" : "none";
    if (!show) {
      const input = row.querySelector("[data-i2-property-id]");
      if (input) input.value = "";
    }
  };

  setVisible(row2, !!val1);
  setVisible(row3, !!val2);
  setVisible(row4, !!val3);
  setVisible(notes, !!(val1 || val2 || val3 || val4));
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENTITY DEFINITIONS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const ICON_CATEGORIES = {
  people: {
    name: 'People',
    color: '#818cf8',
    defaultIcon: 'gfx/map_icons/people/woman.png',
    icons: [
      { id: 'person', name: 'Person (Generic)', icon: 'gfx/map_icons/people/woman.png', keywords: ['person', 'individual', 'people'] },
      { id: 'man', name: 'Man', icon: 'gfx/map_icons/people/man.png', keywords: ['man', 'male'] },
      { id: 'woman', name: 'Woman', icon: 'gfx/map_icons/people/woman.png', keywords: ['woman', 'female'] },
      { id: 'businessman', name: 'Businessman', icon: 'gfx/map_icons/people/businessman.png', keywords: ['businessman', 'executive', 'suit'] },
      { id: 'businesswoman', name: 'Businesswoman', icon: 'gfx/map_icons/people/businesswoman.png', keywords: ['businesswoman', 'executive'] },
      { id: 'lawyer', name: 'Lawyer', icon: 'gfx/map_icons/people/lawyer.png', keywords: ['lawyer', 'attorney', 'solicitor', 'barrister'] },
      { id: 'police', name: 'Police', icon: 'gfx/map_icons/people/police.png', keywords: ['police', 'cop', 'officer', 'law enforcement'] },
      { id: 'doctor', name: 'Doctor', icon: 'gfx/map_icons/people/doctor.png', keywords: ['doctor', 'physician', 'medical'] },
      { id: 'nurse', name: 'Nurse', icon: 'gfx/map_icons/people/nurse.png', keywords: ['nurse', 'medical'] },
      { id: 'engineer', name: 'Engineer', icon: 'gfx/map_icons/people/engineer.png', keywords: ['engineer', 'technical'] },
      { id: 'spy', name: 'Spy/Investigator', icon: 'gfx/map_icons/people/spy.png', keywords: ['spy', 'investigator', 'detective', 'secret'] }
    ]
  },
  buildings: {
    name: 'Buildings',
    color: '#64748b',
    defaultIcon: 'gfx/map_icons/buildings/building.png',
    icons: [
      { id: 'building', name: 'Building (Generic)', icon: 'gfx/map_icons/buildings/building.png', keywords: ['building', 'property'] },
      { id: 'house', name: 'House', icon: 'gfx/map_icons/buildings/house.png', keywords: ['house', 'home', 'residence'] },
      { id: 'office', name: 'Office Building', icon: 'gfx/map_icons/buildings/building.png', keywords: ['office', 'business'] },
      { id: 'mansion', name: 'Mansion', icon: 'gfx/map_icons/real_estate/mansion.png', keywords: ['mansion', 'estate', 'villa'] },
      { id: 'factory', name: 'Factory', icon: 'gfx/map_icons/real_estate/factory.png', keywords: ['factory', 'industrial', 'plant'] },
      { id: 'bank_building', name: 'Bank Building', icon: 'gfx/map_icons/real_estate/bank.png', keywords: ['bank', 'branch'] },
      { id: 'church', name: 'Church', icon: 'gfx/map_icons/real_estate/church.png', keywords: ['church', 'religious'] }
    ]
  },
  financial: {
    name: 'Financial',
    color: '#059669',
    defaultIcon: 'gfx/map_icons/financial_accounts/hsbc.png',
    icons: [
      { id: 'bank', name: 'Bank (Generic)', icon: 'gfx/map_icons/real_estate/bank.png', keywords: ['bank', 'banking', 'financial'] },
      { id: 'hsbc', name: 'HSBC', icon: 'gfx/map_icons/financial_accounts/hsbc.png', keywords: ['hsbc'] },
      { id: 'citi', name: 'Citibank', icon: 'gfx/map_icons/financial_accounts/citi.png', keywords: ['citi', 'citibank'] },
      { id: 'paypal', name: 'PayPal', icon: 'gfx/map_icons/financial_accounts/paypal.png', keywords: ['paypal'] },
      { id: 'westernunion', name: 'Western Union', icon: 'gfx/map_icons/financial_accounts/western_union.png', keywords: ['western union', 'money transfer'] }
    ]
  },
  vehicles: {
    name: 'Vehicles',
    color: '#f59e0b',
    defaultIcon: 'gfx/map_icons/cars/car.png',
    icons: [
      { id: 'car', name: 'Car', icon: 'gfx/map_icons/cars/car.png', keywords: ['car', 'vehicle', 'auto'] },
      { id: 'police_car', name: 'Police Car', icon: 'gfx/map_icons/cars/police_car.png', keywords: ['police car', 'patrol'] },
      { id: 'ambulance', name: 'Ambulance', icon: 'gfx/map_icons/cars/ambulance.png', keywords: ['ambulance', 'emergency'] },
      { id: 'truck', name: 'Truck', icon: 'gfx/map_icons/cars/truck.png', keywords: ['truck', 'lorry'] },
      { id: 'taxi', name: 'Taxi', icon: 'gfx/map_icons/cars/taxi.png', keywords: ['taxi', 'cab'] },
      { id: 'bus', name: 'Bus', icon: 'gfx/map_icons/cars/bus.png', keywords: ['bus', 'coach'] },
      { id: 'van', name: 'Van', icon: 'gfx/map_icons/cars/minibus.png', keywords: ['van', 'minibus'] }
    ]
  },
  aviation: {
    name: 'Aviation',
    color: '#38bdf8',
    defaultIcon: 'gfx/map_icons/email/paper_plane.png',
    icons: [
      { id: 'aircraft', name: 'Aircraft', icon: 'gfx/map_icons/email/paper_plane.png', keywords: ['aircraft', 'plane', 'flight', 'jet', 'air'] },
      { id: 'airport', name: 'Airport/Terminal', icon: 'gfx/map_icons/buildings/building.png', keywords: ['airport', 'terminal', 'runway'] },
      { id: 'pilot', name: 'Pilot', icon: 'gfx/map_icons/people/pilot.png', keywords: ['pilot', 'captain'] },
      { id: 'captain', name: 'Captain', icon: 'gfx/map_icons/people/captain.png', keywords: ['captain'] },
      { id: 'crew', name: 'Cabin Crew', icon: 'gfx/map_icons/people/stewardess.png', keywords: ['crew', 'steward', 'stewardess'] },
      { id: 'aircraft_large', name: 'Large Aircraft', icon: 'gfx/map_icons/email/paper_plane.png', keywords: ['widebody', 'boeing', 'airbus'] }
    ]
  },
  military: {
    name: 'Military',
    color: '#ef4444',
    defaultIcon: 'gfx/map_icons/people/soldier.png',
    icons: [
      { id: 'mil_unit', name: 'Military Unit', icon: 'gfx/map_icons/people/soldier.png', keywords: ['military', 'unit', 'soldier'] },
      { id: 'mil_intel', name: 'Intel / Surveillance', icon: 'gfx/map_icons/people/spy.png', keywords: ['intelligence', 'surveillance', 'spy'] },
      { id: 'mil_air', name: 'Air Asset', icon: 'gfx/map_icons/people/pilot.png', keywords: ['air', 'pilot', 'aircraft'] },
      { id: 'mil_naval', name: 'Naval Asset', icon: 'gfx/map_icons/people/captain.png', keywords: ['naval', 'sea', 'ship'] },
      { id: 'mil_police', name: 'Armed Police', icon: 'gfx/map_icons/people/police.png', keywords: ['police', 'armed', 'response'] },
      { id: 'mil_operation', name: 'Operation', icon: 'gfx/map_icons/people/secretservice.png', keywords: ['operation', 'mission', 'task force'] }
    ]
  },
  communication: {
    name: 'Communication',
    color: '#8b5cf6',
    defaultIcon: 'gfx/map_icons/communication/chat.png',
    icons: [
      { id: 'chat', name: 'Chat', icon: 'gfx/map_icons/communication/chat.png', keywords: ['chat', 'message', 'conversation'] },
      { id: 'email', name: 'Email', icon: 'gfx/map_icons/communication/email.png', keywords: ['email', 'mail'] },
      { id: 'sms', name: 'SMS', icon: 'gfx/map_icons/communication/sms.png', keywords: ['sms', 'text', 'message'] },
      { id: 'mobile_phone', name: 'Mobile Phone', icon: 'gfx/map_icons/mobile_phone/mobile_phone.png', keywords: ['phone', 'handset', 'mobile'] },
      { id: 'smartphone', name: 'Smartphone', icon: 'gfx/map_icons/mobile_phone/smartphone.png', keywords: ['smartphone', 'device'] },
      { id: 'landline', name: 'Landline', icon: 'gfx/map_icons/mobile_phone/landline.png', keywords: ['landline', 'telephone'] }
    ]
  },
  social: {
    name: 'Social Media',
    color: '#ec4899',
    defaultIcon: 'gfx/map_icons/social_media/facebook.png',
    icons: [
      { id: 'facebook', name: 'Facebook', icon: 'gfx/map_icons/social_media/facebook.png', keywords: ['facebook', 'fb'] },
      { id: 'twitter', name: 'Twitter', icon: 'gfx/map_icons/social_media/twitter.png', keywords: ['twitter', 'x'] },
      { id: 'instagram', name: 'Instagram', icon: 'gfx/map_icons/social_media/instagram.png', keywords: ['instagram', 'ig'] },
      { id: 'linkedin', name: 'LinkedIn', icon: 'gfx/map_icons/social_media/linkedin.png', keywords: ['linkedin'] },
      { id: 'whatsapp', name: 'WhatsApp', icon: 'gfx/map_icons/social_media/whatsapp.png', keywords: ['whatsapp'] }
    ]
  }
};

// Suggest icon based on entity name
function suggestIcon(name, category = null) {
  const lowerName = name.toLowerCase();
  const categoriesToSearch = category ? [ICON_CATEGORIES[category]] : Object.values(ICON_CATEGORIES);
  
  for (const cat of categoriesToSearch) {
    for (const icon of cat.icons) {
      if (icon.keywords.some(kw => lowerName.includes(kw))) {
        return { category: Object.keys(ICON_CATEGORIES).find(k => ICON_CATEGORIES[k] === cat), ...icon };
      }
    }
  }
  
  return null;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CONNECTION MANAGEMENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function normalizeConnectionLabel(label) {
  const raw = String(label || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (/(company\s+secretary|secretary)/i.test(raw)) return "Company Secretary";
  if (/(director|managing director)/i.test(raw)) return "Director";
  if (/(llp member|designated member)/i.test(raw)) return "Designated Member";
  if (/(owner|beneficial owner)/i.test(raw)) return "Owner";
  if (/(ownership|voting|shares|right to appoint|significant influence|control)/i.test(lower)) return "PSC";
  return raw.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function addConnection(fromLatLng, toLatLng, label, type = 'officer', metadata = {}) {
  label = normalizeConnectionLabel(label);
  const connectionId = `conn_${Date.now()}_${Math.random()}`;
  const from = normalizeLatLng(fromLatLng);
  const to = normalizeLatLng(toLatLng);
  if (!Number.isFinite(from[0]) || !Number.isFinite(from[1]) || !Number.isFinite(to[0]) || !Number.isFinite(to[1])) {
    return null;
  }
  
  const color = type === 'officer' ? '#a78bfa' : 
                type === 'psc' ? '#fbbf24' : 
                type === 'manual' ? '#22c55e' : '#64748b';
  
  const polyline = L.polyline([from, to], {
    color: color,
    weight: 3,
    opacity: 0.7,
    dashArray: type === 'manual' ? '8, 4' : '5, 5'
  }).addTo(connectionsLayer);
  
  // Store reference to connected entities for highlighting
  polyline._connectionData = {
    fromLatLng: from,
    toLatLng: to,
    connectionId: connectionId,
    metadata: metadata
  };
  
  // Make connection clickable
  polyline.on('click', function(e) {
    L.DomEvent.stopPropagation(e);
    showConnectionPopup(e.latlng, connectionId, label, metadata);
  });
  
  // Add label at midpoint
  if (label) {
    const midLat = (from[0] + to[0]) / 2;
    const midLng = (from[1] + to[1]) / 2;
    
    const labelIcon = L.divIcon({
      className: 'connection-label',
      html: `<div class="connection-label-text">${escapeHtml(label)}</div>`,
      iconSize: [150, 30],
      iconAnchor: [75, 15]
    });
    
    const labelMarker = L.marker([midLat, midLng], { icon: labelIcon }).addTo(connectionsLayer);
    if (metadata?.hoverDetail) {
      labelMarker.bindTooltip(String(metadata.hoverDetail), {
        sticky: true,
        direction: "top",
        offset: [0, -10],
        opacity: 0.95
      });
    }
    
    window._mapConnections.push({
      id: connectionId,
      type,
      label,
      fromLatLng: from,
      toLatLng: to,
      line: polyline,
      labelMarker: labelMarker,
      metadata: metadata
    });
  } else {
    window._mapConnections.push({
      id: connectionId,
      type,
      fromLatLng: from,
      toLatLng: to,
      line: polyline,
      metadata: metadata
    });
  }
  
  updateDashboardCounts();
  
  return connectionId;
}

// Highlight connections related to a specific lat/lng
let highlightedCircles = [];
function highlightConnections(latLng, radius = 50) {
  // Clear previous highlights
  clearConnectionHighlights();
  
  // Find all connections that involve this location (within radius meters)
  const relatedConnections = window._mapConnections.filter(conn => {
    const distFrom = map.distance(latLng, conn.fromLatLng);
    const distTo = map.distance(latLng, conn.toLatLng);
    return distFrom < radius || distTo < radius;
  });
  
  if (relatedConnections.length === 0) {
    setStatus('No connections found for this entity');
    return;
  }
  
  // Highlight the connections
  relatedConnections.forEach(conn => {
    // Make the line more prominent
    conn.line.setStyle({
      weight: 6,
      opacity: 1,
      className: 'highlighted-connection'
    });
    
    // Draw circles at the other end of each connection
    const otherEnd = map.distance(latLng, conn.fromLatLng) < radius ? conn.toLatLng : conn.fromLatLng;
    
    // Pulsing circle
    const pulseCircle = L.circle(otherEnd, {
      radius: 150,
      color: '#ef4444',
      fillColor: '#ef4444',
      fillOpacity: 0.3,
      weight: 3,
      className: 'pulse-circle'
    }).addTo(map);
    
    highlightedCircles.push(pulseCircle);
    
    // Connecting line highlight
    const highlightLine = L.polyline([latLng, otherEnd], {
      color: '#3b82f6',
      weight: 5,
      opacity: 0.8,
      dashArray: ''
    }).addTo(map);
    
    highlightedCircles.push(highlightLine);
  });
  
  setStatus(`Showing ${relatedConnections.length} connection${relatedConnections.length === 1 ? '' : 's'}`);
  
  // Auto-clear after 5 seconds
  setTimeout(() => {
    clearConnectionHighlights();
  }, 5000);
}

function clearConnectionHighlights() {
  // Remove highlight circles and lines
  highlightedCircles.forEach(circle => {
    map.removeLayer(circle);
  });
  highlightedCircles = [];
  
  // Reset connection line styles
  window._mapConnections.forEach(conn => {
    const color = conn.type === 'officer' ? '#a78bfa' : 
                  conn.type === 'psc' ? '#fbbf24' : 
                  conn.type === 'manual' ? '#22c55e' : '#64748b';
    
    conn.line.setStyle({
      color: color,
      weight: 3,
      opacity: 0.7,
      dashArray: conn.type === 'manual' ? '8, 4' : '5, 5'
    });
  });
}

function clearConnections() {
  window._mapConnections.forEach(conn => {
    connectionsLayer.removeLayer(conn.line);
    if (conn.labelMarker) connectionsLayer.removeLayer(conn.labelMarker);
  });
  window._mapConnections = [];
  updateDashboardCounts();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENTITY PLACEMENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function startPlacementMode(category) {
  window._placementMode = category;
  const catData = ICON_CATEGORIES[category];
  setStatus(`Click on map to place ${catData.name}...`);
  map.getContainer().style.cursor = 'crosshair';
}

function cancelPlacementMode() {
  window._placementMode = null;
  setStatus('Placement cancelled');
  map.getContainer().style.cursor = '';
}

function formatI2EntitySummary(i2EntityData) {
  if (!i2EntityData || !i2EntityData.entityName) return "";
  const values = i2EntityData.values ? Object.values(i2EntityData.values) : [];
  const preferredOrder = ["Full Name", "Name", "First Name", "Surname", "Date of Birth", "DOB", "Registration Mark", "VRM", "Organisation Name"];
  const selected = [];
  for (const pref of preferredOrder) {
    const found = values.find((v) => String(v.propertyName || "").toLowerCase() === pref.toLowerCase());
    if (found && !selected.includes(found)) selected.push(found);
    if (selected.length >= 4) break;
  }
  for (const v of values) {
    if (selected.length >= 4) break;
    if (!selected.includes(v)) selected.push(v);
  }
  const preview = selected.map((v) => `${escapeHtml(v.propertyName)}: ${escapeHtml(v.value)}`).join("<br>");
  return (
    `<br><span class="popup-label">i2 Type</span> <span class="popup-tag">${escapeHtml(i2EntityData.entityName)} (${escapeHtml(i2EntityData.entityId)})</span>` +
    (preview ? `<br>${preview}` : "")
  );
}

function isVehicleLikeI2Data(i2EntityData = null, iconData = null) {
  const iconCategory = String(iconData?.categoryName || iconData?.name || "").toLowerCase();
  if (iconCategory.includes("vehicle")) return true;
  const values = Array.isArray(i2EntityData?.values) ? i2EntityData.values : [];
  const propNames = values.map((v) => String(v?.propertyName || "").toLowerCase());
  return propNames.some((p) =>
    p === "registration mark" ||
    p === "vrm" ||
    p === "vehicle make" ||
    p === "vehicle model" ||
    p === "vehicle colour" ||
    p === "vehicle color"
  );
}

function normalizeVehicleI2EntityData(i2EntityData = null, iconData = null) {
  if (!i2EntityData || typeof i2EntityData !== "object") return i2EntityData;
  if (!isVehicleLikeI2Data(i2EntityData, iconData)) return i2EntityData;
  return {
    ...i2EntityData,
    entityId: "ET3",
    entityName: "Vehicle"
  };
}

function getI2ValueFromEntityValues(i2EntityData, names = []) {
  if (!i2EntityData || !Array.isArray(i2EntityData.values) || !Array.isArray(names)) return "";
  const lowered = names.map((n) => String(n || "").toLowerCase());
  const found = i2EntityData.values.find((v) => lowered.includes(String(v.propertyName || "").toLowerCase()));
  return found && found.value != null ? String(found.value) : "";
}

function formatPartialDobValue(dob) {
  if (!dob) return "";
  if (typeof dob === "string") {
    const raw = dob.trim();
    if (!raw) return "";
    const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
    const my = raw.match(/^(\d{1,2})[\/\-](\d{4})$/);
    if (my) return `XX/${String(my[1]).padStart(2, "0")}/${my[2]}`;
    if (/^\d{4}$/.test(raw)) return `XX/XX/${raw}`;
    return raw;
  }
  if (typeof dob === "object") {
    const year = dob.year ? String(dob.year) : "";
    const month = dob.month ? String(dob.month).padStart(2, "0") : "";
    const day = dob.day ? String(dob.day).padStart(2, "0") : "XX";
    if (!year && !month) return "";
    if (year && month) return `${day}/${month}/${year}`;
    if (year) return `XX/XX/${year}`;
  }
  return "";
}

const COUNTRY_ALIAS_TO_ISO2 = {
  "united kingdom": "GB", "uk": "GB", "great britain": "GB", "britain": "GB", "british": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB",
  "united states": "US", "united states of america": "US", "usa": "US", "american": "US",
  "ireland": "IE", "irish": "IE",
  "france": "FR", "french": "FR", "germany": "DE", "german": "DE", "spain": "ES", "spanish": "ES", "italy": "IT", "italian": "IT",
  "netherlands": "NL", "dutch": "NL", "belgium": "BE", "belgian": "BE", "switzerland": "CH", "swiss": "CH", "austria": "AT", "austrian": "AT",
  "portugal": "PT", "portuguese": "PT", "poland": "PL", "polish": "PL", "romania": "RO", "romanian": "RO", "ukraine": "UA", "ukrainian": "UA",
  "russia": "RU", "russian": "RU", "turkey": "TR", "turkish": "TR", "greece": "GR", "greek": "GR",
  "india": "IN", "indian": "IN", "pakistan": "PK", "pakistani": "PK", "bangladesh": "BD", "bangladeshi": "BD", "china": "CN", "chinese": "CN", "japan": "JP", "japanese": "JP",
  "south korea": "KR", "korean": "KR", "singapore": "SG", "singaporean": "SG", "hong kong": "HK",
  "uae": "AE", "united arab emirates": "AE", "saudi arabia": "SA", "qatar": "QA", "kuwait": "KW", "oman": "OM",
  "nigeria": "NG", "nigerian": "NG", "ghana": "GH", "ghanaian": "GH", "kenya": "KE", "kenyan": "KE", "south africa": "ZA", "south african": "ZA",
  "canada": "CA", "canadian": "CA", "australia": "AU", "australian": "AU", "new zealand": "NZ", "new zealander": "NZ",
  "brazil": "BR", "brazilian": "BR", "mexico": "MX", "mexican": "MX", "argentina": "AR", "argentine": "AR"
};

function countryToIso2(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const direct = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(direct)) return direct;
  const key = raw.toLowerCase().replace(/\s+/g, " ");
  return COUNTRY_ALIAS_TO_ISO2[key] || "";
}

function countryFlagEmoji(value) {
  const code = countryToIso2(value);
  if (!code) return "";
  const cps = [...code].map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...cps);
}

function formatCountryWithFlag(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const flag = countryFlagEmoji(text);
  return flag ? `${flag} ${text}` : text;
}
window.formatCountryWithFlag = formatCountryWithFlag;

function buildEntityHoverTooltipHtml(entity) {
  if (!entity) return "";
  const normalizedI2 = normalizeVehicleI2EntityData(entity.i2EntityData, entity.iconData);
  const values = normalizedI2?.values || [];
  const typeTag = normalizedI2?.entityName || entity.iconData?.categoryName || entity.iconData?.name || "Entity";

  let row1 = escapeHtml(entity.label || "Entity");
  let row2 = escapeHtml(typeTag);
  let row3 = "";

  if (entity.sourceType === "company") {
    const companyNo =
      getI2ValueFromEntityValues(entity.i2EntityData, ["Company/Registration Number", "Company Number", "Registration Number"]) ||
      String(entity.companyNumber || "");
    row2 = companyNo ? `Company #${escapeHtml(companyNo)}` : "Organisation";
  } else if (entity.sourceType === "officer" || String(typeTag).toLowerCase() === "person") {
    const dob =
      getI2ValueFromEntityValues(entity.i2EntityData, ["Date of Birth", "DOB"]) ||
      formatPartialDobValue(entity.dob || "");
    const nationality = getI2ValueFromEntityValues(entity.i2EntityData, ["Nationality"]);
    if (dob) row2 = `DOB ${escapeHtml(dob)}`;
    if (nationality) row3 = `Nationality ${escapeHtml(nationality)}`;
  }

  return `<div class="entity-hover-card"><strong>${row1}</strong><br>${row2}${row3 ? `<br>${row3}` : ""}</div>`;
}

function bindEntityHoverTooltip(marker, entity) {
  if (!marker || !entity) return;
  marker.bindTooltip(buildEntityHoverTooltipHtml(entity), {
    direction: "bottom",
    offset: [0, 16],
    sticky: true,
    opacity: 0.95,
    className: "entity-hover-tooltip"
  });
}

function buildEntityPopup(entityId, entity) {
  if (entity?.i2EntityData) {
    entity.i2EntityData = normalizeVehicleI2EntityData(entity.i2EntityData, entity.iconData);
  }
  if (entity?.sourceType === "officer") {
    const dob =
      getI2ValueFromEntityValues(entity.i2EntityData, ["Date of Birth", "DOB"]) ||
      formatPartialDobValue(entity.dob || "");
    const nationality = getI2ValueFromEntityValues(entity.i2EntityData, ["Nationality"]) || String(entity.nationality || "");
    const countryOfResidence =
      getI2ValueFromEntityValues(entity.i2EntityData, ["Country of Residence"]) ||
      String(entity.countryOfResidence || "");
    const nationalityDisplay = formatCountryWithFlag(nationality);
    const countryOfResidenceDisplay = formatCountryWithFlag(countryOfResidence);
    const role =
      getI2ValueFromEntityValues(entity.i2EntityData, ["Role", "Officer Role"]) ||
      String(entity.officerRole || "");
    const detailRows = [];
    if (entity.address) detailRows.push(`<span class="popup-label">Address</span> ${escapeHtml(entity.address)}`);
    if (entity.notes) detailRows.push(`<span class="popup-label">Notes</span> ${escapeHtml(entity.notes)}`);
    if (role) detailRows.push(`<span class="popup-label">Role</span> ${escapeHtml(role)}`);
    detailRows.push(`<span class="popup-label">Lat/Lng</span> ${entity.latLng[0].toFixed(5)}, ${entity.latLng[1].toFixed(5)}`);
    return `
      <strong>${escapeHtml(entity.label)}</strong>
      <span class="popup-label">Type</span> <span class="popup-tag" style="background:${entity.iconData.categoryColor || entity.iconData.color};">${escapeHtml(entity.iconData.categoryName || entity.iconData.name)}</span><br>
      ${dob ? `<span class="popup-label">DOB</span> ${escapeHtml(dob)}<br>` : ""}
      ${nationalityDisplay ? `<span class="popup-label">Nationality</span> <span class="popup-flag-chip">${escapeHtml(nationalityDisplay)}</span><br>` : ""}
      ${countryOfResidenceDisplay ? `<span class="popup-label">Country of Residence</span> <span class="popup-flag-chip">${escapeHtml(countryOfResidenceDisplay)}</span><br>` : ""}
      <details class="popup-more-details">
        <summary>See more</summary>
        ${detailRows.join("<br>")}
      </details>
      ${formatI2EntitySummary(entity.i2EntityData)}
      <div class="popup-btn-row">
        <button class="popup-psc-btn" onclick="editEntity('${entityId}')">Edit</button>
        <button class="popup-psc-btn" onclick="drawConnectionFrom('${entityId}')">Connect</button>
        ${entity.officerId ? `<button class="popup-psc-btn" onclick="expandOfficerCompanies('${entityId}')">Expand Companies</button>` : ""}
        <button class="popup-psc-btn" onclick="removeEntity('${entityId}')">Remove</button>
      </div>
    `;
  }
  const vehicleMediaHtml = isVehicleEntityForPopup(entity) ? buildVehiclePopupMediaHtml(entity) : "";
  return `
    <strong>${escapeHtml(entity.label)}</strong>
    ${vehicleMediaHtml}
    <span class="popup-label">Type</span> <span class="popup-tag" style="background:${entity.iconData.categoryColor || entity.iconData.color};">${escapeHtml(entity.iconData.categoryName || entity.iconData.name)}</span><br>
    ${entity.address ? `<span class="popup-label">Address</span> ${escapeHtml(entity.address)}<br>` : ''}
    ${entity.notes ? `<span class="popup-label">Notes</span> ${escapeHtml(entity.notes)}<br>` : ''}
    <span class="popup-label">Lat/Lng</span> ${entity.latLng[0].toFixed(5)}, ${entity.latLng[1].toFixed(5)}
    ${formatI2EntitySummary(entity.i2EntityData)}
    <div class="popup-btn-row">
      <button class="popup-psc-btn" onclick="editEntity('${entityId}')">Edit</button>
      <button class="popup-psc-btn" onclick="drawConnectionFrom('${entityId}')">Connect</button>
      <button class="popup-psc-btn" onclick="removeEntity('${entityId}')">Remove</button>
    </div>
  `;
}

function buildCompanyI2EntityData(companyData = {}) {
  const orgEntity = getI2EntityByKey("ET4") || getI2EntityByKey("Organisation");
  const values = [];
  if (companyData.name) values.push({ propertyName: "Organisation Name", value: String(companyData.name) });
  if (companyData.number) values.push({ propertyName: "Company/Registration Number", value: String(companyData.number) });
  if (companyData.address) values.push({ propertyName: "Address String", value: String(companyData.address) });
  if (companyData.postcode) values.push({ propertyName: "Post Code", value: String(companyData.postcode) });
  if (companyData.status) values.push({ propertyName: "Status", value: String(companyData.status) });

  return {
    entityId: orgEntity?.entity_id || "ET4",
    entityName: orgEntity?.entity_name || "Organisation",
    values
  };
}

function getCompanyEntityIconData() {
  const buildings = ICON_CATEGORIES.buildings || {};
  const officeIcon = (buildings.icons || []).find((ic) => ic.id === "office");
  return {
    id: "organisation",
    name: "Organisation",
    icon: officeIcon?.icon || buildings.defaultIcon || ICON_CATEGORIES.financial?.defaultIcon || ICON_CATEGORIES.people?.defaultIcon,
    categoryColor: buildings.color || "#64748b",
    categoryName: "Organisation"
  };
}

function createOrganisationMarker(latLng) {
  const iconData = getCompanyEntityIconData();
  const markerIcon = L.icon({
    iconUrl: iconData.icon,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14]
  });
  return L.marker(latLng, { icon: markerIcon });
}

function getOfficerEntityIconData() {
  const people = ICON_CATEGORIES.people || {};
  const personIcon = (people.icons || []).find((ic) => ic.id === "person") || (people.icons || [])[0];
  return {
    id: personIcon?.id || "person",
    name: personIcon?.name || "Person",
    icon: personIcon?.icon || people.defaultIcon || ICON_CATEGORIES.people?.defaultIcon,
    categoryColor: people.color || "#8b5cf6",
    categoryName: people.name || "People"
  };
}

function buildOfficerI2EntityData(personData = {}) {
  const personEntity = getI2EntityByKey("ET5") || getI2EntityByKey("Person");
  const values = [];
  if (personData.name) values.push({ propertyName: "Full Name", value: String(personData.name) });
  if (personData.dob) values.push({ propertyName: "Date of Birth", value: formatPartialDobValue(personData.dob) });
  if (personData.nationality) values.push({ propertyName: "Nationality", value: String(personData.nationality) });
  if (personData.countryOfResidence) values.push({ propertyName: "Country of Residence", value: String(personData.countryOfResidence) });
  if (personData.relationship) values.push({ propertyName: "Role", value: String(personData.relationship) });
  if (personData.address) values.push({ propertyName: "Address String", value: String(personData.address) });
  if (personData.postcode) values.push({ propertyName: "Post Code", value: String(personData.postcode) });
  return {
    entityId: personEntity?.entity_id || "ET5",
    entityName: personEntity?.entity_name || "Person",
    values
  };
}

function normalizeOfficerNameKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDobKey(value) {
  return formatPartialDobValue(value || "").trim().toUpperCase();
}

function buildOfficerEntityKeys(personData = {}) {
  const nameKey = normalizeOfficerNameKey(personData.name);
  const postcodeKey = String(personData.postcode || "").trim().toUpperCase();
  const officerIdKey = String(personData.officerId || "").trim();
  const dobKey = normalizeDobKey(personData.dob);
  return {
    nameKey,
    postcodeKey,
    officerIdKey,
    namePostcodeKey: nameKey && postcodeKey ? `${nameKey}|${postcodeKey}` : "",
    nameDobKey: nameKey && dobKey ? `${nameKey}|${dobKey}` : ""
  };
}

function mergeOfficerEntityData(existing, personData = {}) {
  if (!existing) return;
  if (!existing.officerId && personData.officerId) existing.officerId = personData.officerId;
  if (!existing.countryOfResidence && personData.countryOfResidence) existing.countryOfResidence = personData.countryOfResidence;
  if (!existing.nationality && personData.nationality) existing.nationality = personData.nationality;
  if (!existing.dob && personData.dob) existing.dob = personData.dob;
  if (!existing.officerRole && personData.relationship) existing.officerRole = personData.relationship;
  if (!existing.companyName && personData.companyName) existing.companyName = String(personData.companyName);
  if (!existing.companyNumber && personData.companyNumber) existing.companyNumber = String(personData.companyNumber);
  if (!existing.notes && personData.notes) existing.notes = String(personData.notes);
  if (!existing.address && personData.address) existing.address = String(personData.address);
  existing.i2EntityData = buildOfficerI2EntityData({
    name: existing.label || personData.name || "",
    dob: existing.dob || personData.dob || "",
    nationality: existing.nationality || personData.nationality || "",
    countryOfResidence: existing.countryOfResidence || personData.countryOfResidence || "",
    relationship: existing.officerRole || personData.relationship || "",
    address: existing.address || personData.address || "",
    postcode: personData.postcode || ""
  });
}

function findExistingOfficerEntityId(personData = {}) {
  const keys = buildOfficerEntityKeys(personData);
  if (!window._officerEntityIndex) window._officerEntityIndex = {};
  if (!window._officerEntityByOfficerId) window._officerEntityByOfficerId = {};
  if (!window._officerEntityByNameDob) window._officerEntityByNameDob = {};

  let entityId = "";
  if (keys.officerIdKey) entityId = window._officerEntityByOfficerId[keys.officerIdKey] || "";
  if (!entityId && keys.nameDobKey) entityId = window._officerEntityByNameDob[keys.nameDobKey] || "";
  if (!entityId && keys.namePostcodeKey) entityId = window._officerEntityIndex[keys.namePostcodeKey] || "";

  if (!entityId) return null;
  const existing = getEntityById(entityId);
  return existing ? entityId : null;
}

function upsertOfficerEntityIndexes(entityId, personData = {}) {
  if (!entityId) return;
  const keys = buildOfficerEntityKeys(personData);
  if (!window._officerEntityIndex) window._officerEntityIndex = {};
  if (!window._officerEntityByOfficerId) window._officerEntityByOfficerId = {};
  if (!window._officerEntityByNameDob) window._officerEntityByNameDob = {};
  if (keys.namePostcodeKey) window._officerEntityIndex[keys.namePostcodeKey] = entityId;
  if (keys.officerIdKey) window._officerEntityByOfficerId[keys.officerIdKey] = entityId;
  if (keys.nameDobKey) window._officerEntityByNameDob[keys.nameDobKey] = entityId;
}

function registerOfficerMarkerAsEntity(marker, personData = {}) {
  if (!marker) return null;
  const keys = buildOfficerEntityKeys(personData);
  if (!keys.nameKey) return null;
  const existingId = findExistingOfficerEntityId(personData);
  if (existingId) {
    const existing = getEntityById(existingId);
    if (existing) {
      mergeOfficerEntityData(existing, personData);
      upsertOfficerEntityIndexes(existingId, {
        name: existing.label || personData.name,
        postcode: personData.postcode,
        officerId: existing.officerId || personData.officerId,
        dob: existing.dob || personData.dob
      });
      existing.marker.setPopupContent(buildEntityPopup(existingId, existing));
      bindEntityHoverTooltip(existing.marker, existing);
      marker.bindPopup(buildEntityPopup(existingId, existing));
      marker._entityId = existingId;
      bindEntityHoverTooltip(marker, existing);
      return existingId;
    }
  }

  const coords = normalizeLatLng(personData.latLng || marker.getLatLng());
  if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
  const entityId = `officer_entity_${Date.now()}_${Math.random()}`;
  const entity = {
    id: entityId,
    iconData: getOfficerEntityIconData(),
    label: String(personData.name || "Person"),
    address: String(personData.address || "").trim(),
    notes: personData.notes ? String(personData.notes) : "",
    latLng: coords,
    marker,
    i2EntityData: buildOfficerI2EntityData(personData),
    sourceType: "officer",
    dob: personData.dob || "",
    nationality: personData.nationality || "",
    countryOfResidence: personData.countryOfResidence || "",
    officerId: personData.officerId || "",
    officerRole: personData.relationship || "",
    companyName: personData.companyName ? String(personData.companyName) : "",
    companyNumber: personData.companyNumber ? String(personData.companyNumber) : ""
  };
  marker._entityId = entityId;
  bindEntityHoverTooltip(marker, entity);
  window._mapEntities.push(entity);
  upsertOfficerEntityIndexes(entityId, personData);
  updateDashboardCounts();
  return entityId;
}

function bindCompanyEntityMarkerClick(marker) {
  if (!marker || marker._companyEntityClickBound) return;
  marker.on("click", function(e) {
    L.DomEvent.stopPropagation(e);
    const entityId = marker._entityId;
    if (connectionDrawingMode && entityId && connectionDrawingMode.fromId !== entityId) {
      completeConnection(entityId);
      return;
    }
    highlightConnections(marker.getLatLng());
  });
  marker._companyEntityClickBound = true;
}

function registerCompanyMarkerAsEntity(marker, companyData = {}) {
  if (!marker) return null;
  const numberKey = String(companyData.number || "").trim().toUpperCase();
  if (!numberKey) return null;

  if (!window._companyEntityIndex) window._companyEntityIndex = {};

  const existingId = window._companyEntityIndex[numberKey];
  if (existingId) {
    const existing = getEntityById(existingId);
    if (existing) {
      marker._entityId = existingId;
      bindCompanyEntityMarkerClick(marker);
      bindEntityHoverTooltip(marker, existing);
      return existingId;
    }
  }

  const coords = normalizeLatLng(companyData.latLng || marker.getLatLng());
  if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;

  const entityId = `company_entity_${numberKey}_${Date.now()}_${Math.random()}`;
  const entity = {
    id: entityId,
    iconData: getCompanyEntityIconData(),
    label: String(companyData.name || numberKey),
    address: String(companyData.address || "").trim(),
    notes: companyData.status ? `Status: ${companyData.status}` : "",
    latLng: coords,
    marker,
    i2EntityData: buildCompanyI2EntityData(companyData),
    sourceType: "company"
  };

  marker._entityId = entityId;
  bindCompanyEntityMarkerClick(marker);
  bindEntityHoverTooltip(marker, entity);
  window._mapEntities.push(entity);
  window._companyEntityIndex[numberKey] = entityId;
  updateDashboardCounts();
  return entityId;
}

function connectCompanyEntity(companyNumber) {
  const key = String(companyNumber || "").trim().toUpperCase();
  const entityId = window._companyEntityIndex ? window._companyEntityIndex[key] : null;
  if (!entityId) {
    setStatus(`Company ${key} is not yet registered as an Organisation entity`);
    return;
  }
  drawConnectionFrom(entityId);
}

function getCompanyEntityByNumber(companyNumber) {
  const key = String(companyNumber || "").trim().toUpperCase();
  if (!key || !window._companyEntityIndex) return null;
  const entityId = window._companyEntityIndex[key];
  return entityId ? getEntityById(entityId) : null;
}

function getNextPscFanIndex(companyEntityId) {
  if (!companyEntityId || !Array.isArray(window._mapConnections)) return 0;
  return window._mapConnections.filter((c) =>
    c?.metadata?.source === "psc_auto" && c?.metadata?.toId === companyEntityId
  ).length;
}

function offsetLatLngFromAnchor(anchor, fanIndex = 0, radiusDeg = 0.00115) {
  const base = normalizeLatLng(anchor);
  if (!Number.isFinite(base[0]) || !Number.isFinite(base[1])) return base;
  const idx = Number.isFinite(Number(fanIndex)) ? Number(fanIndex) : 0;
  const angleDeg = ((idx + 1) * 45) % 360;
  const ring = Math.floor(idx / 8);
  const distance = radiusDeg * (1 + ring * 0.5);
  const rad = angleDeg * (Math.PI / 180);
  return [base[0] + Math.sin(rad) * distance, base[1] + Math.cos(rad) * distance];
}

function removeCompanyEntitiesFromStore() {
  if (!window._companyEntityIndex) return;
  const removedIds = new Set(Object.values(window._companyEntityIndex));
  if (!removedIds.size) return;

  const toRemoveConnections = window._mapConnections
    .filter((c) => removedIds.has(c?.metadata?.fromId) || removedIds.has(c?.metadata?.toId))
    .map((c) => c.id);
  toRemoveConnections.forEach((id) => removeConnection(id));

  window._mapEntities = window._mapEntities.filter((e) => !removedIds.has(e.id));
  window._companyEntityIndex = {};
  updateDashboardCounts();
}

function refreshConnectionGeometry(connection) {
  if (!connection || !connection.line || !connection.metadata) return;
  const fromId = connection.metadata.fromId;
  const toId = connection.metadata.toId;
  if (!fromId || !toId) return;
  const fromEntity = getEntityById(fromId);
  const toEntity = getEntityById(toId);
  if (!fromEntity || !toEntity) return;
  connection.line.setLatLngs([fromEntity.latLng, toEntity.latLng]);
  if (connection.labelMarker) {
    const midLat = (fromEntity.latLng[0] + toEntity.latLng[0]) / 2;
    const midLng = (fromEntity.latLng[1] + toEntity.latLng[1]) / 2;
    connection.labelMarker.setLatLng([midLat, midLng]);
  }
}

function refreshConnectionsForEntity(entityId) {
  if (!entityId || !Array.isArray(window._mapConnections)) return;
  window._mapConnections.forEach((conn) => {
    if (!conn?.metadata) return;
    if (conn.metadata.fromId === entityId || conn.metadata.toId === entityId) {
      refreshConnectionGeometry(conn);
    }
  });
}

function hasPscAutoConnection(fromId, toId) {
  if (!fromId || !toId || !Array.isArray(window._mapConnections)) return false;
  return window._mapConnections.some((c) => {
    const md = c?.metadata || {};
    return md.source === "psc_auto" && md.fromId === fromId && md.toId === toId;
  });
}

function isAircraftEntityIcon(iconData = null, i2EntityData = null) {
  const id = String(iconData?.id || "").toLowerCase();
  const category = String(iconData?.categoryName || "").toLowerCase();
  const name = String(iconData?.name || "").toLowerCase();
  const i2Name = String(i2EntityData?.entityName || "").toLowerCase();
  if (id === "aircraft" || id === "aircraft_large") return true;
  if (i2Name === "aircraft") return true;
  return category.includes("aviation") && (name.includes("aircraft") || name.includes("plane") || name.includes("flight"));
}

function createAircraftEntityDivIcon() {
  const svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.6 0 1 .4 1 1v7.1l7.4 3.3c.5.2.8.7.7 1.2l-.3 1.4c-.1.6-.7 1-1.3.8l-6.5-1.7v3.9l2 1.5c.3.2.5.6.5 1v.8c0 .6-.5 1-1.1.9L12 22l-2.9.9c-.6.1-1.1-.3-1.1-.9v-.8c0-.4.2-.8.5-1l2-1.5v-3.9l-6.5 1.7c-.6.2-1.2-.2-1.3-.8l-.3-1.4c-.1-.5.2-1 .7-1.2L10.9 10.1V3c0-.6.4-1 1-1z"/></svg>';
  const html =
    `<div class="flight-icon flight-transit" style="--flight-icon-size:20px">` +
      `<span class="flight-inner" style="transform:rotate(0deg)">` +
        `${svg}` +
      `</span>` +
    `</div>`;
  return L.divIcon({
    className: "flight-marker entity-aircraft-marker",
    html,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -14]
  });
}

function createEntityMarkerIcon(iconData = {}, i2EntityData = null) {
  if (isAircraftEntityIcon(iconData, i2EntityData)) return createAircraftEntityDivIcon();
  return L.icon({
    iconUrl: iconData.icon,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16]
  });
}

function placeEntity(latLng, iconData, label = '', address = '', notes = '', i2EntityData = null) {
  const entityId = `entity_${Date.now()}_${Math.random()}`;
  const coords = normalizeLatLng(latLng);
  if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
    setStatus("Invalid coordinates for entity placement");
    return null;
  }
  
  const icon = createEntityMarkerIcon(iconData, i2EntityData);
  
  const marker = L.marker(coords, { icon: icon, draggable: true });
  
  const entity = {
    id: entityId,
    iconData: iconData,
    label: label || iconData.name,
    address: address || '',
    notes: notes || '',
    latLng: coords,
    marker: marker,
    i2EntityData: normalizeVehicleI2EntityData(i2EntityData, iconData) || null
  };

  marker.bindPopup(buildEntityPopup(entityId, entity)).addTo(entitiesMarkerCluster);
  bindEntityHoverTooltip(marker, entity);
  marker.on("dragend", () => {
    const next = marker.getLatLng();
    entity.latLng = [Number(next.lat), Number(next.lng)];
    marker.setPopupContent(buildEntityPopup(entityId, entity));
    refreshConnectionsForEntity(entityId);
    setStatus(`Moved: ${entity.label}`);
  });

  // In connect mode, clicking another entity should complete the link immediately.
  marker.on('click', function(e) {
    L.DomEvent.stopPropagation(e);
    if (connectionDrawingMode && connectionDrawingMode.fromId !== entityId) {
      completeConnection(entityId);
      return;
    }
    highlightConnections(marker.getLatLng());
  });
  
  marker.openPopup();

  window._mapEntities.push(entity);
  
  updateDashboardCounts();
  
  return entityId;
}

function removeEntity(entityId) {
  const idx = window._mapEntities.findIndex(e => e.id === entityId);
  if (idx >= 0) {
    const entity = window._mapEntities[idx];
    window._selectedEntityIds.delete(entityId);
    entitiesMarkerCluster.removeLayer(entity.marker);
    window._mapEntities.splice(idx, 1);
    if (window._companyEntityIndex) {
      Object.keys(window._companyEntityIndex).forEach((k) => {
        if (window._companyEntityIndex[k] === entityId) delete window._companyEntityIndex[k];
      });
    }
    if (window._officerEntityIndex) {
      Object.keys(window._officerEntityIndex).forEach((k) => {
        if (window._officerEntityIndex[k] === entityId) delete window._officerEntityIndex[k];
      });
    }
    if (window._officerEntityByOfficerId) {
      Object.keys(window._officerEntityByOfficerId).forEach((k) => {
        if (window._officerEntityByOfficerId[k] === entityId) delete window._officerEntityByOfficerId[k];
      });
    }
    if (window._officerEntityByNameDob) {
      Object.keys(window._officerEntityByNameDob).forEach((k) => {
        if (window._officerEntityByNameDob[k] === entityId) delete window._officerEntityByNameDob[k];
      });
    }
    setStatus('Entity removed');
    updateDashboardCounts();
  }
}

function editEntity(entityId) {
  const entity = window._mapEntities.find(e => e.id === entityId);
  if (!entity) return;
  
  // Show edit dialog
  const newLabel = prompt('Label:', entity.label);
  if (newLabel === null) return;
  
  const newAddress = prompt('Address (for geolocation):', entity.address);
  if (newAddress === null) return;
  
  const newNotes = prompt('Notes:', entity.notes);
  if (newNotes === null) return;
  
  // Update entity
  entity.label = newLabel.trim() || entity.label;
  entity.address = newAddress.trim();
  entity.notes = newNotes.trim();
  
  entity.marker.setPopupContent(buildEntityPopup(entityId, entity));
  bindEntityHoverTooltip(entity.marker, entity);
  setStatus('Entity updated');
}

function editEntityLabel(entityId) {
  editEntity(entityId);
}

function clearAllEntities() {
  clearEntitySelection();
  window._mapEntities.forEach(entity => {
    entitiesMarkerCluster.removeLayer(entity.marker);
  });
  window._mapEntities = [];
  setStatus('All custom entities removed');
  updateDashboardCounts();
}

const CAR_MAKE_LOGO_INDEX_DEFAULT = {};
let CAR_MAKE_LOGO_INDEX = { ...CAR_MAKE_LOGO_INDEX_DEFAULT };

function normalizeCarMakeKey(raw) {
  const text = String(raw || "");
  const latinized = typeof text.normalize === "function"
    ? text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    : text;
  return latinized.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalizeWikimediaFileUrl(urlRaw) {
  const url = String(urlRaw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) return "";
  return url
    .replace(/^http:\/\//i, "https://")
    .replace(/^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//i, "https://commons.wikimedia.org/wiki/Special:FilePath/");
}

function buildCarMakeLogoIndexFromVehicleEntities(rawEntities) {
  if (!rawEntities || typeof rawEntities !== "object") return {};
  const index = {};
  Object.entries(rawEntities).forEach(([entityId, entity]) => {
    if (!entity || typeof entity !== "object") return;
    const logoUrl = canonicalizeWikimediaFileUrl(entity.logo_url);
    if (!logoUrl) return;

    const labelKey = normalizeCarMakeKey(entity.label || "");
    if (labelKey) index[labelKey] = logoUrl;

    const idKey = normalizeCarMakeKey(entityId);
    if (idKey) index[idKey] = logoUrl;
  });

  const aliases = {
    landrover: ["land_rover", "land_rover_limited"],
    mercedes: ["mercedes_benz", "mercedes_benz_group"],
    mercedesbenz: ["mercedes_benz", "mercedes_benz_group"],
    mg: ["mg_motor", "mg_motor_uk", "saic_motor"],
    rollsroyce: ["rolls_royce_motor_cars", "rolls_royce_limited"],
    vauxhall: ["vauxhall_motors", "opel"],
    alfa: ["alfa_romeo"],
    alfaromeo: ["alfa_romeo"]
  };
  Object.entries(aliases).forEach(([target, refs]) => {
    if (index[target]) return;
    for (const ref of refs) {
      const k = normalizeCarMakeKey(ref);
      if (index[k]) {
        index[target] = index[k];
        break;
      }
    }
  });
  return index;
}

function setCarMakeLogoIndex(rawIndex) {
  if (!rawIndex || typeof rawIndex !== "object") {
    CAR_MAKE_LOGO_INDEX = { ...CAR_MAKE_LOGO_INDEX_DEFAULT };
    return;
  }
  CAR_MAKE_LOGO_INDEX = rawIndex;
}

let DVLA_VEHICLE_ICON_LOOKUP = null;
let VEHICLE_GT_IMAGE_INDEX = [];
const dvlaVehicleIconLookupPromise = fetch("data/dvla_vehicle_icon_lookup.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((payload) => {
    if (!payload || typeof payload !== "object") return null;
    if (!payload.by_make || typeof payload.by_make !== "object") return null;
    DVLA_VEHICLE_ICON_LOOKUP = payload;
    return payload;
  })
  .catch(() => null);

const vehicleEntitiesLogoPromise = fetch("data/vehicle_entities.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((entities) => {
    if (!entities) return null;
    const built = buildCarMakeLogoIndexFromVehicleEntities(entities);
    return Object.keys(built).length ? built : null;
  })
  .catch(() => null);

const vehicleGtImagePromise = fetch("data/vehicle_icons_granturismo.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((payload) => {
    if (!payload || typeof payload !== "object") return null;
    VEHICLE_GT_IMAGE_INDEX = Object.entries(payload).map(([key, node]) => {
      const label = String(node?.label || "");
      const imageUrl = String(node?.image_url || "");
      const combined = `${key} ${label}`;
      const searchable = String(combined)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { key, label, imageUrl, searchable };
    }).filter((entry) => entry.imageUrl);
    return VEHICLE_GT_IMAGE_INDEX;
  })
  .catch(() => null);

function getVehicleMakeLogoPath(makeRaw) {
  const key = normalizeCarMakeKey(makeRaw);
  if (!key) return "";
  return String(CAR_MAKE_LOGO_INDEX[key] || "");
}

function normalizeVehicleSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getVehicleCarPlaceholderIcon() {
  const vehicles = ICON_CATEGORIES.vehicles || {};
  const carIcon = (vehicles.icons || []).find((ic) => ic.id === "car") || (vehicles.icons || [])[0];
  return String(carIcon?.icon || vehicles.defaultIcon || "gfx/map_icons/cars/car.png");
}

function getVehicleModelTokens(modelRaw = "") {
  const model = normalizeVehicleSearchText(modelRaw);
  if (!model) return [];
  const blacklist = new Set(["the", "and", "for", "with", "line", "series", "class", "sport", "edition", "model", "base"]);
  return model.split(" ").filter((t) => t && t.length >= 2 && !blacklist.has(t));
}

function getVehicleMakeAliases(makeRaw = "") {
  const make = normalizeVehicleSearchText(makeRaw);
  if (!make) return [];
  const aliases = new Set([make]);
  if (make.includes("mercedes")) aliases.add("benz");
  if (make.includes("benz")) aliases.add("mercedes");
  if (make === "vw") aliases.add("volkswagen");
  if (make === "volkswagen") aliases.add("vw");
  if (make.includes("alfa")) aliases.add("alfa romeo");
  if (make.includes("land rover")) aliases.add("range rover");
  return [...aliases];
}

function findGranTurismoVehicleImage(vehicle = {}) {
  if (!Array.isArray(VEHICLE_GT_IMAGE_INDEX) || !VEHICLE_GT_IMAGE_INDEX.length) return null;
  const make = normalizeVehicleSearchText(vehicle?.make || "");
  const model = normalizeVehicleSearchText(vehicle?.model || "");
  const year = parseVehicleYear(vehicle);
  if (!make && !model) return null;
  const modelTokens = getVehicleModelTokens(model);
  const makeAliases = getVehicleMakeAliases(make);

  let best = null;
  let bestScore = -1;
  for (const item of VEHICLE_GT_IMAGE_INDEX) {
    const hay = item.searchable;
    let score = 0;
    let makeHit = false;
    if (makeAliases.length) {
      for (const alias of makeAliases) {
        if (alias && hay.includes(alias)) {
          makeHit = true;
          break;
        }
      }
      if (makeHit) score += 32;
    }
    if (model && hay.includes(model)) score += 40;
    let tokenHit = 0;
    if (modelTokens.length) {
      for (const token of modelTokens) if (hay.includes(token)) tokenHit += 1;
      score += Math.round((tokenHit / modelTokens.length) * 35);
    }
    if (year && hay.includes(String(year))) score += 14;
    if (score > bestScore) {
      bestScore = score;
      best = { ...item, makeHit, tokenHit };
    }
  }
  if (!best) return null;
  if (best.makeHit && bestScore >= 24) return { ...best, score: bestScore };
  if (best.tokenHit >= 2 && bestScore >= 34) return { ...best, score: bestScore };
  return bestScore >= 46 ? { ...best, score: bestScore } : null;
}

function getDvlaVehicleShowcaseData(vehicle = {}) {
  const gtMatch = findGranTurismoVehicleImage(vehicle);
  const makeLogo = getVehicleMakeLogoPath(vehicle.make || "");
  const mapIcon = getDvlaVehicleIconPath(vehicle) || getVehicleCarPlaceholderIcon();
  return {
    matched: !!gtMatch,
    source: gtMatch ? "gran_turismo" : "placeholder",
    label: gtMatch?.label || `${String(vehicle.make || "Vehicle")} ${String(vehicle.model || "").trim()}`.trim(),
    imageUrl: gtMatch?.imageUrl || "",
    logoPath: makeLogo || "",
    placeholderIcon: mapIcon,
    mapIcon
  };
}

function parseVehicleYear(vehicle = {}) {
  const y = Number(vehicle?.yearOfManufacture || 0);
  if (Number.isFinite(y) && y >= 1900 && y <= 2100) return Math.trunc(y);
  const mfr = String(vehicle?.monthOfFirstRegistration || "");
  const m = mfr.match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : 0;
}

function getDvlaVehicleIconPath(vehicle = {}) {
  const lookup = DVLA_VEHICLE_ICON_LOOKUP;
  if (!lookup || typeof lookup !== "object") return "";
  const byMake = lookup.by_make || {};
  const makeKey = normalizeCarMakeKey(vehicle?.make || "");
  if (!makeKey) return "";
  const makeNode = byMake[makeKey];
  if (!makeNode || typeof makeNode !== "object") return "";

  const years = makeNode.years || {};
  const vehicleYear = parseVehicleYear(vehicle);
  if (vehicleYear && years[String(vehicleYear)]?.icon) {
    return String(years[String(vehicleYear)].icon || "");
  }

  if (vehicleYear) {
    let bestYear = 0;
    let bestDist = 999;
    let bestScore = 0;
    Object.entries(years).forEach(([yearText, node]) => {
      const y = Number(yearText);
      if (!Number.isFinite(y)) return;
      const dist = Math.abs(y - vehicleYear);
      const score = Number(node?.score || 0);
      if (dist > 6) return;
      if (dist < bestDist || (dist === bestDist && score > bestScore)) {
        bestDist = dist;
        bestYear = y;
        bestScore = score;
      }
    });
    if (bestYear && years[String(bestYear)]?.icon) {
      return String(years[String(bestYear)].icon || "");
    }
  }

  return String(makeNode.default_icon || "");
}

window.getVehicleMakeLogoPath = getVehicleMakeLogoPath;
window.getDvlaVehicleIconPath = getDvlaVehicleIconPath;
window.getDvlaVehicleShowcaseData = getDvlaVehicleShowcaseData;
vehicleEntitiesLogoPromise.then((fromEntities) => {
  if (fromEntities && typeof fromEntities === "object" && Object.keys(fromEntities).length) {
    setCarMakeLogoIndex(fromEntities);
    return;
  }
  setCarMakeLogoIndex(CAR_MAKE_LOGO_INDEX_DEFAULT);
});
dvlaVehicleIconLookupPromise.then(() => {
  // no-op; ensures asynchronous load starts early
});
vehicleGtImagePromise.then(() => {
  // no-op; ensures asynchronous load starts early
});

function getVehicleEntityIconData(makeRaw = "", vehicle = null) {
  const vehicles = ICON_CATEGORIES.vehicles || {};
  const carIcon = (vehicles.icons || []).find((ic) => ic.id === "car") || (vehicles.icons || [])[0];
  const mappedVehicleIcon = vehicle ? getDvlaVehicleIconPath(vehicle) : "";
  const logoPath = getVehicleMakeLogoPath(makeRaw);
  return {
    id: carIcon?.id || "car",
    name: String(makeRaw || carIcon?.name || "Vehicle"),
    icon: mappedVehicleIcon || logoPath || carIcon?.icon || vehicles.defaultIcon || ICON_CATEGORIES.vehicles?.defaultIcon,
    categoryColor: vehicles.color || "#f59e0b",
    categoryName: vehicles.name || "Vehicles"
  };
}

function buildVehicleI2EntityData(vehicle = {}) {
  const values = [];
  const showcase = getDvlaVehicleShowcaseData(vehicle);
  if (vehicle.registrationNumber) values.push({ propertyName: "Registration Mark", value: String(vehicle.registrationNumber) });
  if (vehicle.make) values.push({ propertyName: "Vehicle Make", value: String(vehicle.make) });
  if (vehicle.model) values.push({ propertyName: "Vehicle Model", value: String(vehicle.model) });
  if (vehicle.colour) values.push({ propertyName: "Vehicle Colour", value: String(vehicle.colour) });
  if (vehicle.yearOfManufacture) values.push({ propertyName: "Year", value: String(vehicle.yearOfManufacture) });
  if (vehicle.fuelType) values.push({ propertyName: "Fuel Type", value: String(vehicle.fuelType) });
  if (vehicle.taxStatus) values.push({ propertyName: "Tax Status", value: String(vehicle.taxStatus) });
  if (vehicle.motStatus) values.push({ propertyName: "MOT Status", value: String(vehicle.motStatus) });
  if (showcase.imageUrl) values.push({ propertyName: "Vehicle Image URL", value: String(showcase.imageUrl) });
  if (showcase.source) values.push({ propertyName: "Vehicle Image Source", value: String(showcase.source) });
  if (showcase.mapIcon) values.push({ propertyName: "Vehicle Map Icon URL", value: String(showcase.mapIcon) });
  if (showcase.logoPath) values.push({ propertyName: "Vehicle Make Logo URL", value: String(showcase.logoPath) });
  return {
    entityId: "ET3",
    entityName: "Vehicle",
    values
  };
}

function addDvlaVehicleEntity(vehicle = {}, latLng = null) {
  const vrm = String(vehicle.registrationNumber || "").trim().toUpperCase();
  if (!vrm) return null;
  const center = latLng || [map.getCenter().lat, map.getCenter().lng];
  const label = [vrm, vehicle.make, vehicle.model].filter(Boolean).join(" | ");
  const notes = [
    vehicle.yearOfManufacture ? `Year ${vehicle.yearOfManufacture}` : "",
    vehicle.colour ? `Colour ${vehicle.colour}` : "",
    vehicle.fuelType ? `Fuel ${vehicle.fuelType}` : "",
    vehicle.taxStatus ? `Tax ${vehicle.taxStatus}` : "",
    vehicle.motStatus ? `MOT ${vehicle.motStatus}` : ""
  ].filter(Boolean).join(" | ");
  const entityId = placeEntity(
    center,
    getVehicleEntityIconData(vehicle.make, vehicle),
    label || vrm,
    "",
    notes,
    buildVehicleI2EntityData(vehicle)
  );
  if (entityId) setStatus(`Added vehicle entity: ${vrm}`);
  return entityId;
}

function isVehicleEntityForPopup(entity = {}) {
  const i2Name = String(entity?.i2EntityData?.entityName || "").toLowerCase();
  if (i2Name.includes("vehicle")) return true;
  const values = Array.isArray(entity?.i2EntityData?.values) ? entity.i2EntityData.values : [];
  return values.some((v) => String(v?.propertyName || "").toLowerCase() === "registration mark");
}

function buildVehiclePopupMediaHtml(entity = {}) {
  const values = Array.isArray(entity?.i2EntityData?.values) ? entity.i2EntityData.values : [];
  const valueOf = (name) => {
    const hit = values.find((v) => String(v?.propertyName || "").toLowerCase() === String(name).toLowerCase());
    return String(hit?.value || "");
  };
  const isLikelyMapIconUrl = (url) => {
    const u = String(url || "").trim().toLowerCase();
    if (!u) return false;
    return u.includes("/map_icons/") || u.startsWith("gfx/map_icons/");
  };
  const isHttpImage = (url) => /^https?:\/\//i.test(String(url || "").trim());
  const vehicle = {
    make: valueOf("Vehicle Make"),
    model: valueOf("Vehicle Model"),
    yearOfManufacture: valueOf("Year")
  };
  const showcase = getDvlaVehicleShowcaseData(vehicle);
  const storedSource = valueOf("Vehicle Image Source").toLowerCase();
  const storedImageUrl = valueOf("Vehicle Image URL");
  const source = storedSource || showcase.source;
  const imageUrl = storedSource === "gran_turismo"
    ? storedImageUrl
    : (isHttpImage(storedImageUrl) && !isLikelyMapIconUrl(storedImageUrl) ? storedImageUrl : showcase.imageUrl);
  const mapIconUrl = valueOf("Vehicle Map Icon URL") || showcase.mapIcon || showcase.placeholderIcon;
  const logoUrl = valueOf("Vehicle Make Logo URL") || showcase.logoPath;
  const showTopImage = !!imageUrl && source === "gran_turismo" && isHttpImage(imageUrl) && !isLikelyMapIconUrl(imageUrl);
  const title = showTopImage ? (showcase.label || "Matched vehicle image") : "Vehicle map icon";
  const topImageHtml = showTopImage
    ? `<img class="vehicle-popup-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" loading="lazy">`
    : "";
  const mapIconHtml = mapIconUrl
    ? `<img class="vehicle-popup-map-icon" src="${escapeHtml(mapIconUrl)}" alt="Vehicle map icon" loading="lazy">`
    : "";
  const logoHtml = logoUrl
    ? `<img class="vehicle-popup-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(vehicle.make || "Vehicle make")} logo" loading="lazy">`
    : "";
  return (
    `<div class="vehicle-popup-media">` +
      topImageHtml +
      `<div class="vehicle-popup-media-meta">` +
        `<div class="vehicle-popup-media-left">${mapIconHtml}${logoHtml}</div>` +
        `<span class="vehicle-popup-media-tag">${showTopImage ? "GT MATCH" : "MAP ICON"}</span>` +
      `</div>` +
    `</div>`
  );
}

// Update dashboard counters
function updateDashboardCounts() {
  const entityCount = document.getElementById('entity_count');
  const connectionCount = document.getElementById('connection_count');
  if (entityCount) entityCount.textContent = window._mapEntities.length;
  if (connectionCount) connectionCount.textContent = window._mapConnections.length;
}

// Make functions globally accessible
window.removeEntity = removeEntity;
window.editEntity = editEntity;
window.editEntityLabel = editEntityLabel;
window.clearAllEntities = clearAllEntities;
window.drawConnectionFrom = drawConnectionFrom;
window.showConnectionPopup = showConnectionPopup;
window.removeConnection = removeConnection;
window.editConnection = editConnection;
window.highlightConnections = highlightConnections;
window.clearConnectionHighlights = clearConnectionHighlights;
window.startI2EntityPlacement = startI2EntityPlacement;
window.registerCompanyMarkerAsEntity = registerCompanyMarkerAsEntity;
window.connectCompanyEntity = connectCompanyEntity;
window.createOrganisationMarker = createOrganisationMarker;
window.addPersonToMap = addPersonToMap;
window.expandOfficerCompanies = expandOfficerCompanies;
window.getCompanyEntityByNumber = getCompanyEntityByNumber;
window.addDvlaVehicleEntity = addDvlaVehicleEntity;

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MANUAL CONNECTION DRAWING
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

let connectionDrawingMode = null;

function drawConnectionFrom(entityId) {
  const entity = window._mapEntities.find(e => e.id === entityId);
  if (!entity) return;
  
  connectionDrawingMode = {
    fromId: entityId,
    fromEntity: entity,
    fromLatLng: entity.latLng
  };
  
  setStatus(`Click another entity to connect to ${entity.label}...`);
  map.getContainer().style.cursor = 'crosshair';
}

function cancelConnectionDrawing(statusMessage = 'Connection cancelled') {
  connectionDrawingMode = null;
  if (statusMessage) setStatus(statusMessage);
  map.getContainer().style.cursor = '';
}

function completeConnection(toEntityId) {
  if (!connectionDrawingMode) return;
  
  const toEntity = window._mapEntities.find(e => e.id === toEntityId);
  if (!toEntity || toEntity.id === connectionDrawingMode.fromId) {
    cancelConnectionDrawing();
    return;
  }
  
  const label = prompt(`Connection label (e.g., "business partner", "known associate"):`,'');
  if (label === null) {
    cancelConnectionDrawing();
    return;
  }
  
  addConnection(
    connectionDrawingMode.fromLatLng,
    toEntity.latLng,
    label,
    'manual',
    {
      fromId: connectionDrawingMode.fromId,
      toId: toEntityId,
      fromLabel: connectionDrawingMode.fromEntity.label,
      toLabel: toEntity.label
    }
  );
  
  setStatus(`Connected: ${connectionDrawingMode.fromEntity.label} -> ${toEntity.label}`);
  cancelConnectionDrawing(null);
}

function showConnectionPopup(latlng, connectionId, label, metadata) {
  const conn = window._mapConnections.find(c => c.id === connectionId);
  if (!conn) return;
  
  const popup = L.popup()
    .setLatLng(latlng)
    .setContent(`
      <strong>Connection</strong>
      <span class="popup-label">Label</span> ${escapeHtml(label || 'No label')}<br>
      ${metadata.fromLabel ? `<span class="popup-label">From</span> ${escapeHtml(metadata.fromLabel)}<br>` : ''}
      ${metadata.toLabel ? `<span class="popup-label">To</span> ${escapeHtml(metadata.toLabel)}<br>` : ''}
      ${metadata.hoverDetail ? `<span class="popup-label">Detail</span> ${escapeHtml(metadata.hoverDetail)}` : ''}
      <div class="popup-btn-row">
        <button class="popup-psc-btn" onclick="editConnection('${connectionId}')">Edit Label</button>
        <button class="popup-psc-btn" onclick="removeConnection('${connectionId}')">Remove</button>
      </div>
    `)
    .openOn(map);
}

function removeConnection(connectionId) {
  const idx = window._mapConnections.findIndex(c => c.id === connectionId);
  if (idx >= 0) {
    const conn = window._mapConnections[idx];
    connectionsLayer.removeLayer(conn.line);
    if (conn.labelMarker) connectionsLayer.removeLayer(conn.labelMarker);
    window._mapConnections.splice(idx, 1);
    setStatus('Connection removed');
    updateDashboardCounts();
    map.closePopup();
  }
}

function editConnection(connectionId) {
  const conn = window._mapConnections.find(c => c.id === connectionId);
  if (!conn) return;
  
  const newLabel = prompt('Connection label:', conn.label || '');
  if (newLabel === null) return;
  
  conn.label = normalizeConnectionLabel(newLabel.trim());
  
  // Update label marker
  if (conn.labelMarker) {
    connectionsLayer.removeLayer(conn.labelMarker);
  }
  
  if (conn.label) {
    const coords = conn.line.getLatLngs();
    const midLat = (coords[0].lat + coords[1].lat) / 2;
    const midLng = (coords[0].lng + coords[1].lng) / 2;
    
    const labelIcon = L.divIcon({
      className: 'connection-label',
      html: `<div class="connection-label-text">${escapeHtml(conn.label)}</div>`,
      iconSize: [150, 30],
      iconAnchor: [75, 15]
    });
    
    conn.labelMarker = L.marker([midLat, midLng], { icon: labelIcon }).addTo(connectionsLayer);
    if (conn?.metadata?.hoverDetail) {
      conn.labelMarker.bindTooltip(String(conn.metadata.hoverDetail), {
        sticky: true,
        direction: "top",
        offset: [0, -10],
        opacity: 0.95
      });
    }
  }
  
  setStatus('Connection updated');
  map.closePopup();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENTITY SELECTOR UI
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function initializeEntitySelector() {
  const container = document.getElementById('entity_selector');
  if (!container) return;
  
  container.innerHTML = '';

  if (I2_ENTITY_CATALOG.length) {
    const sorted = [...I2_ENTITY_CATALOG].sort((a, b) =>
      String(a.entity_name || "").localeCompare(String(b.entity_name || ""))
    );

    for (const entity of sorted) {
      const item = document.createElement("div");
      item.className = "entity-category";
      const chosen = chooseIconForI2Entity(entity);
      const iconPath = chosen.icon?.icon || (ICON_CATEGORIES.people?.icons?.[0]?.icon || "");
      const fallbackIcon = ICON_CATEGORIES[chosen.category]?.defaultIcon || ICON_CATEGORIES.people?.defaultIcon || iconPath;
      item.innerHTML = `
        <button type="button" class="entity-btn" data-i2-entity-id="${escapeHtml(entity.entity_id)}">
          <img src="${iconPath}" class="entity-icon" alt="${escapeHtml(entity.entity_name || entity.entity_id)}" onerror="this.onerror=null;this.src='${fallbackIcon}'">
          <span class="entity-name">${escapeHtml(entity.entity_name || entity.entity_id)}</span>
        </button>
      `;

      const btn = item.querySelector(".entity-btn");
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        document.querySelectorAll(".entity-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        startI2EntityPlacement(entity.entity_id);
      });
      container.appendChild(item);
    }
  } else {
    // Fallback when i2 catalog is unavailable.
    for (const [catId, category] of Object.entries(ICON_CATEGORIES)) {
      const categoryBtn = document.createElement('div');
      categoryBtn.className = 'entity-category';
      const firstIcon = category.icons[0];
      categoryBtn.innerHTML = `
        <button type="button" class="entity-btn" data-category="${catId}">
          <img src="${firstIcon.icon}" class="entity-icon" alt="${category.name}">
          <span class="entity-name">${category.name}</span>
        </button>
      `;
      const btn = categoryBtn.querySelector('.entity-btn');
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        startPlacementMode(catId);
        showEntityPlacementDialog(map.getCenter());
        document.querySelectorAll('.entity-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      container.appendChild(categoryBtn);
    }
  }
  
  // Add manual connection button
  const connBtn = document.createElement('button');
  connBtn.className = 'btn-secondary';
  connBtn.innerHTML = 'Draw Connection';
  connBtn.addEventListener('click', () => {
    const entityList = window._mapEntities.map((e, i) => `${i + 1}. ${e.label}`).join('\n');
    if (entityList) {
      alert(`Click the "Connect" button on any entity to start drawing connections.\n\nEntities on map:\n${entityList}`);
    } else {
      alert('No entities on map. Place entities first, then use the Connect button on each entity.');
    }
  });
  container.appendChild(connBtn);
  
  // Add cancel and clear buttons
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel Placement';
  cancelBtn.addEventListener('click', () => {
    cancelPlacementMode();
    cancelConnectionDrawing();
    document.querySelectorAll('.entity-btn').forEach(b => b.classList.remove('active'));
  });
  container.appendChild(cancelBtn);
  
  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn-secondary';
  clearBtn.textContent = 'Clear All';
  clearBtn.addEventListener('click', () => {
    if (confirm('Remove all custom entities and connections from map?')) {
      clearAllEntities();
      clearConnections();
    }
  });
  container.appendChild(clearBtn);
}

// Import tracking for bulk uploads
window._importedEntityIds = new Set();
window._importedConnectionIds = new Set();
window._importedOverlayLayers = [];

function normalizeFieldName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function detectImportColumns(headers) {
  const out = {
    name: null,
    dob: null,
    address: null,
    postcode: null,
    lat: null,
    lon: null,
    entityType: null,
    target: null,
    relation: null,
    notes: null
  };

  for (const raw of headers) {
    const h = normalizeFieldName(raw);
    if (!h) continue;

    if (!out.name && /^(name|full_name|person|subject|entity|primary_entity)$/.test(h)) out.name = raw;
    if (!out.dob && /^(dob|date_of_birth|birth_date|born)$/.test(h)) out.dob = raw;
    if (!out.address && /^(address|address_line_1|street|location|residence|home_address)$/.test(h)) out.address = raw;
    if (!out.postcode && /^(postcode|postal_code|zip|zip_code)$/.test(h)) out.postcode = raw;
    if (!out.lat && /^(lat|latitude|y)$/.test(h)) out.lat = raw;
    if (!out.lon && /^(lon|lng|longitude|x)$/.test(h)) out.lon = raw;
    if (!out.entityType && /^(entity_type|type|i2_type|category)$/.test(h)) out.entityType = raw;
    if (!out.target && /^(linked_to|linked_entity|associate|target|to|connection_to|related_to|link_to|company|organisation|organization|linked_company)$/.test(h)) out.target = raw;
    // Support both "Relationship" and shorthand "Link Type"/"Role" style columns.
    if (!out.relation && /^(relation|relationship|link|link_type|edge|association|role)$/.test(h)) out.relation = raw;
    if (!out.notes && /^(notes|comment|description|intel|intelligence)$/.test(h)) out.notes = raw;
  }
  return out;
}

function parseDobFromText(text) {
  const str = String(text || "");
  const m = str.match(/\b(?:dob|d\.o\.b\.?|born)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/i);
  if (!m) return null;
  return m[1].replace(/-/g, "/");
}

function extractNameFromMixedText(text) {
  const str = String(text || "").trim();
  if (!str) return "";
  const clean = str
    .replace(/\b(?:dob|d\.o\.b\.?|born)\b.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return clean || str;
}

function inferEntityKind(row, cols) {
  const typeText = String(row[cols.entityType] || "").toLowerCase();
  if (typeText.includes("person") || typeText.includes("subject")) return "person";
  if (typeText.includes("organisation") || typeText.includes("organization") || typeText.includes("company")) return "organisation";
  if (typeText.includes("address") || typeText.includes("location")) return "location";
  if (typeText.includes("phone") || typeText.includes("msisdn") || typeText.includes("imei") || typeText.includes("imsi") || typeText.includes("email")) return "communication";

  const hasDob = !!(row[cols.dob] || parseDobFromText(row[cols.name]));
  const hasAddress = !!(row[cols.address] || row[cols.postcode]);
  if (hasDob) return "person";
  if (hasAddress) return "location";
  return "generic";
}

function pickIconForImport(kind, label) {
  let categoryKey = "people";
  if (kind === "location") categoryKey = "buildings";
  if (kind === "organisation") categoryKey = "financial";
  if (kind === "communication") categoryKey = "communication";
  if (kind === "generic") {
    const suggestedAny = suggestIcon(label || "");
    if (suggestedAny?.category && ICON_CATEGORIES[suggestedAny.category]) {
      categoryKey = suggestedAny.category;
    } else {
      categoryKey = "people";
    }
  }
  const cat = ICON_CATEGORIES[categoryKey];
  const suggested = suggestIcon(label || "", categoryKey);
  const picked = suggested || cat.icons[0];
  return {
    ...picked,
    categoryColor: cat.color,
    categoryName: cat.name
  };
}

async function readSpreadsheetRows(file) {
  const buf = await file.arrayBuffer();
  if (!window.XLSX) throw new Error("XLSX parser library not loaded");

  const wb = XLSX.read(buf, { type: "array", cellDates: true, raw: false });
  if (!wb.SheetNames.length) return [];
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

function detectDelimiter(text) {
  const sample = String(text || "").split(/\r?\n/).slice(0, 2).join("\n");
  const counts = [
    { d: "\t", c: (sample.match(/\t/g) || []).length },
    { d: ",", c: (sample.match(/,/g) || []).length },
    { d: ";", c: (sample.match(/;/g) || []).length },
    { d: "|", c: (sample.match(/\|/g) || []).length }
  ].sort((a, b) => b.c - a.c);
  return counts[0]?.c > 0 ? counts[0].d : ",";
}

function parseDelimitedRows(text, delimiter = ",") {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((v) => String(v || "").trim());
  };
  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ""; });
    rows.push(row);
  }
  return rows;
}

async function readDelimitedRows(file) {
  const txt = await file.text();
  return parseDelimitedRows(txt, detectDelimiter(txt));
}

function propertiesPreviewHtml(props = {}) {
  const entries = Object.entries(props).filter(([, v]) => v != null && String(v).trim() !== "").slice(0, 6);
  if (!entries.length) return '<span class="popup-label">Imported overlay feature</span>';
  return entries.map(([k, v]) => `<span class="popup-label">${escapeHtml(k)}</span> ${escapeHtml(String(v))}`).join("<br>");
}

async function importGeoJsonFile(file) {
  const summaryEl = document.getElementById("entity-import-summary");
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error("Invalid JSON/GeoJSON file");
  }
  if (!parsed || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new Error("Expected GeoJSON FeatureCollection");
  }
  const layer = L.geoJSON(parsed, {
    style: () => ({ color: "#38bdf8", weight: 2, opacity: 0.8, fillOpacity: 0.08 }),
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 5, color: "#22d3ee", fillColor: "#22d3ee", fillOpacity: 0.9, weight: 1.5 }),
    onEachFeature: (f, l) => {
      l.bindPopup(propertiesPreviewHtml(f.properties || {}));
    }
  }).addTo(entitiesOverlayLayer);
  window._importedOverlayLayers.push(layer);
  try {
    const b = layer.getBounds?.();
    if (b && b.isValid && b.isValid()) map.fitBounds(b, { padding: [24, 24], maxZoom: 13 });
  } catch (_) {}
  if (summaryEl) summaryEl.textContent = `Imported GeoJSON overlay: ${parsed.features.length} features from ${file.name}.`;
  setStatus(`Imported overlay ${file.name}`);
}

async function importJsonRowsFile(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error("Invalid JSON file");
  }
  if (parsed?.type === "FeatureCollection") {
    await importGeoJsonFile(file);
    return;
  }
  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rows) ? parsed.rows : null);
  if (!rows) throw new Error("JSON must be an array of row objects or GeoJSON FeatureCollection");
  await importEntitiesFromRows(rows);
}

function getEntityById(entityId) {
  return window._mapEntities.find((e) => e.id === entityId) || null;
}

function getNetworkPlacementLatLng(index) {
  const center = map.getCenter();
  const angle = index * 0.62;
  const radius = 0.03 + (index % 7) * 0.01;
  const lat = center.lat + Math.sin(angle) * radius;
  const lng = center.lng + Math.cos(angle) * radius;
  return [lat, lng];
}

async function importEntitiesFromRows(rows) {
  const summaryEl = document.getElementById("entity-import-summary");
  if (!Array.isArray(rows) || rows.length === 0) {
    if (summaryEl) summaryEl.textContent = "No rows found in file.";
    return;
  }

  const headers = Object.keys(rows[0] || {});
  const cols = detectImportColumns(headers);

  const nameToEntityId = new Map();
  let plotted = 0;
  let skipped = 0;
  let linked = 0;
  let networkPlaced = 0;
  let geoPlaced = 0;
  let networkIndex = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sourceName = row[cols.name] || row.Name || row.name || "";
    const dobDetected = row[cols.dob] || parseDobFromText(sourceName);
    const label = extractNameFromMixedText(sourceName) || `Entity ${i + 1}`;
    const address = String(row[cols.address] || "").trim();
    const postcode = String(row[cols.postcode] || "").trim();
    const noteRaw = String(row[cols.notes] || "").trim();
    const entityKind = inferEntityKind(row, cols);
    let usedNetworkPlacement = false;

    let lat = parseFloat(String(row[cols.lat] || "").trim());
    let lon = parseFloat(String(row[cols.lon] || "").trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      lat = NaN;
      lon = NaN;
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      if (postcode) {
        const geo = await geocodePostcode(postcode);
        if (geo) {
          lat = geo.lat;
          lon = geo.lon;
        }
      }
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const synthetic = getNetworkPlacementLatLng(networkIndex++);
      lat = synthetic[0];
      lon = synthetic[1];
      networkPlaced++;
      usedNetworkPlacement = true;
    } else {
      geoPlaced++;
    }

    const notes = [
      dobDetected ? `DOB: ${dobDetected}` : "",
      noteRaw,
      postcode ? `Postcode: ${postcode}` : "",
      usedNetworkPlacement ? "Placed by network layout (no geocode fields)" : ""
    ].filter(Boolean).join(" | ");

    const iconData = pickIconForImport(entityKind, label);
    const entityId = placeEntity([lat, lon], iconData, label, address || postcode, notes);
    window._importedEntityIds.add(entityId);
    nameToEntityId.set(label.toLowerCase(), entityId);
    plotted++;
  }

  // Second pass for inferred relationship links
  for (const row of rows) {
    const srcLabel = extractNameFromMixedText(row[cols.name] || row.Name || row.name || "").toLowerCase();
    const tgtLabel = String(row[cols.target] || "").trim().toLowerCase();
    if (!srcLabel || !tgtLabel) continue;

    const srcId = nameToEntityId.get(srcLabel);
    const tgtId = nameToEntityId.get(tgtLabel);
    if (!srcId || !tgtId || srcId === tgtId) continue;

    const srcEntity = getEntityById(srcId);
    const tgtEntity = getEntityById(tgtId);
    if (!srcEntity || !tgtEntity) continue;

    const relation = String(row[cols.relation] || row.relationship || row.Relationship || "Associate").trim();
    const connectionId = addConnection(
      srcEntity.latLng,
      tgtEntity.latLng,
      relation,
      "manual",
      {
        fromId: srcId,
        toId: tgtId,
        fromLabel: srcEntity.label,
        toLabel: tgtEntity.label,
        imported: true
      }
    );
    window._importedConnectionIds.add(connectionId);
    linked++;
  }

  if (summaryEl) {
    const mappedCols = Object.entries(cols).filter(([, v]) => !!v).map(([k, v]) => `${k}:${v}`).join(", ");
    summaryEl.textContent =
      `Imported ${plotted} entities (${geoPlaced} geospatial, ${networkPlaced} network-layout), skipped ${skipped}, inferred ${linked} links. ` +
      `Detected columns: ${mappedCols || "none"}.`;
  }
  setStatus(`Imported ${plotted} entities from spreadsheet`);
}

function clearImportedEntities() {
  for (const connId of Array.from(window._importedConnectionIds)) {
    removeConnection(connId);
  }
  window._importedConnectionIds.clear();

  for (const entityId of Array.from(window._importedEntityIds)) {
    removeEntity(entityId);
  }
  window._importedEntityIds.clear();
  for (const layer of window._importedOverlayLayers || []) {
    try { entitiesOverlayLayer.removeLayer(layer); } catch (_) {}
  }
  window._importedOverlayLayers = [];

  const summaryEl = document.getElementById("entity-import-summary");
  if (summaryEl) summaryEl.textContent = "Imported entities/overlays cleared.";
  setStatus("Imported entities removed");
}

// â”€â”€ Load overlay data â”€â”€

// Police force boundaries
const OVERLAY_LOAD_STATE = {
  areasLoaded: false,
  areasLoading: null,
  airportsLoaded: false,
  airportsLoading: null,
  seaportsLoaded: false,
  seaportsLoading: null,
  undergroundLoaded: false,
  undergroundLoading: null
};

function resolvePoliceForceName(props = {}) {
  if (!props || typeof props !== "object") return "Unknown Police Force";
  const directKeys = ["PFA22NM", "PFA23NM", "PFA21NM", "PFA20NM", "force_name", "FORCE_NAME", "name", "NAME"];
  for (const key of directKeys) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const nmKey = Object.keys(props).find((k) => /(^|_)PFA\d{2}NM$/i.test(String(k)));
  if (nmKey && typeof props[nmKey] === "string" && props[nmKey].trim()) return props[nmKey].trim();
  return "Unknown Police Force";
}

function resolvePoliceForceCode(props = {}) {
  if (!props || typeof props !== "object") return "";
  const directKeys = ["PFA22CD", "PFA23CD", "PFA21CD", "PFA20CD", "force_code", "FORCE_CODE", "code", "CODE"];
  for (const key of directKeys) {
    const v = props[key];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim()) return String(v).trim();
  }
  const cdKey = Object.keys(props).find((k) => /(^|_)PFA\d{2}CD$/i.test(String(k)));
  if (cdKey && props[cdKey] != null && String(props[cdKey]).trim()) return String(props[cdKey]).trim();
  return "";
}

async function ensurePoliceAreasLoaded() {
  if (OVERLAY_LOAD_STATE.areasLoaded) return true;
  if (OVERLAY_LOAD_STATE.areasLoading) return OVERLAY_LOAD_STATE.areasLoading;
  OVERLAY_LOAD_STATE.areasLoading = fetch("data/police_force_areas_wgs84.geojson")
    .then((r) => r.json())
    .then((data) => {
      L.geoJSON(data, {
        style: { color: "#818cf8", weight: 2, fillColor: "#818cf8", fillOpacity: 0.06, dashArray: "6 4" },
        onEachFeature: (f, l) => {
          const n = resolvePoliceForceName(f.properties || {});
          const code = resolvePoliceForceCode(f.properties || {});
          l.bindPopup(
            `<strong>${escapeHtml(n)}</strong><br>` +
            `<span class="popup-label">Police Force Area</span>` +
            (code ? `<br><span class="popup-label">Force Code</span> ${escapeHtml(code)}` : "")
          );
        }
      }).addTo(layers.areas);
      OVERLAY_LOAD_STATE.areasLoaded = true;
      return true;
    })
    .catch((e) => {
      console.warn("Police areas:", e);
      setStatus("Police force area data unavailable");
      return false;
    })
    .finally(() => {
      OVERLAY_LOAD_STATE.areasLoading = null;
    });
  return OVERLAY_LOAD_STATE.areasLoading;
}

// Airports
const UK_COUNTRIES = ["ENGLAND","SCOTLAND","WALES","NORTHERN IRELAND","IRELAND","UK"];
const AIRPORT_LOGO_MAP_DEFAULT = { iata: {}, icao: {}, name_hints: [] };
let AIRPORT_LOGO_MAP = { ...AIRPORT_LOGO_MAP_DEFAULT };
const AIRPORT_LOGO_HINT_CACHE = [];
const AIRPORT_LOGO_ICON_CACHE = {};
const airportLogoMapPromise = fetch("data/airport_logo_map.json")
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);

function setAirportLogoMap(rawMap) {
  const nextMap = rawMap && typeof rawMap === "object" ? rawMap : AIRPORT_LOGO_MAP_DEFAULT;
  AIRPORT_LOGO_MAP = {
    iata: nextMap.iata && typeof nextMap.iata === "object" ? nextMap.iata : {},
    icao: nextMap.icao && typeof nextMap.icao === "object" ? nextMap.icao : {},
    name_hints: Array.isArray(nextMap.name_hints) ? nextMap.name_hints : []
  };
  AIRPORT_LOGO_HINT_CACHE.length = 0;
  AIRPORT_LOGO_MAP.name_hints.forEach((hint) => {
    const pattern = String(hint?.pattern || "").trim();
    const logo = String(hint?.logo || "").trim();
    if (!pattern || !logo) return;
    try {
      AIRPORT_LOGO_HINT_CACHE.push({ re: new RegExp(pattern), logo });
    } catch (_) {
      // invalid pattern, skip
    }
  });
}

function getAirportLogoPathFromProps(props = {}) {
  const icao = String(props?.icao || "").toUpperCase();
  const iata = String(props?.iata || "").toUpperCase();
  const name = String(props?.name || "").toUpperCase();

  if (iata && AIRPORT_LOGO_MAP.iata[iata]) return AIRPORT_LOGO_MAP.iata[iata];
  if (icao && AIRPORT_LOGO_MAP.icao[icao]) return AIRPORT_LOGO_MAP.icao[icao];

  for (const hint of AIRPORT_LOGO_HINT_CACHE) {
    if (hint.re.test(name)) return hint.logo;
  }
  return "";
}

function getAirportLogoIcon(logoPath, isUK) {
  const key = `${logoPath}|${isUK ? "uk" : "global"}`;
  if (AIRPORT_LOGO_ICON_CACHE[key]) return AIRPORT_LOGO_ICON_CACHE[key];
  const size = isUK ? 32 : 24;
  const icon = L.icon({
    iconUrl: logoPath,
    iconSize: [size, size],
    iconAnchor: [Math.round(size / 2), Math.round(size / 2)],
    popupAnchor: [0, -Math.round(size / 2)],
    className: "airport-logo-icon"
  });
  AIRPORT_LOGO_ICON_CACHE[key] = icon;
  return icon;
}

window.AIRPORT_INDEX = {
  all: [],
  uk: [],
  byIcao: {},
  byIata: {}
};

function normalizeAirportSearchText(v) {
  return String(v || "").toLowerCase().trim();
}

function airportPopupHtml(airport) {
  const logoPath = String(airport?.logoPath || "");
  const logoBlock = logoPath
    ? (
        `<div class="airport-logo-popup-wrap">` +
          `<img class="airport-logo-popup" src="${escapeHtml(logoPath)}" alt="${escapeHtml(airport?.name || "Airport logo")}" loading="lazy">` +
        `</div>`
      )
    : "";
  return (
    `<div class="airport-intel-popup">` +
      logoBlock +
      `<strong>${escapeHtml(airport?.name || "Airport")}</strong><br>` +
      `<span class="popup-label">ICAO</span> ${escapeHtml(airport?.icao || "N/A")} | <span class="popup-label">IATA</span> ${escapeHtml(airport?.iata || "N/A")}<br>` +
      `<span class="popup-label">Country</span> ${escapeHtml(airport?.country || "Unknown")}<br>` +
      `<span class="popup-label">Intel</span> Loading nearby flights...` +
    `</div>`
  );
}

function scoreAirportMatch(airport, query) {
  if (!query) return 0;
  const q = normalizeAirportSearchText(query);
  const iata = normalizeAirportSearchText(airport?.iata);
  const icao = normalizeAirportSearchText(airport?.icao);
  const name = normalizeAirportSearchText(airport?.name);
  const city = normalizeAirportSearchText(airport?.city);
  const country = normalizeAirportSearchText(airport?.country);

  if (iata && iata === q) return 100;
  if (icao && icao === q) return 98;
  if (name && name === q) return 95;
  if (city && city === q) return 90;

  let score = 0;
  if (iata && iata.startsWith(q)) score = Math.max(score, 85);
  if (icao && icao.startsWith(q)) score = Math.max(score, 82);
  if (name && name.includes(q)) score = Math.max(score, 78);
  if (city && city.includes(q)) score = Math.max(score, 72);
  if (country && country.includes(q)) score = Math.max(score, 60);
  return score;
}

function searchAirports(query, limit = 10) {
  const q = normalizeAirportSearchText(query);
  if (!q) return [];
  const pool = Array.isArray(window.AIRPORT_INDEX?.all) ? window.AIRPORT_INDEX.all : [];
  return pool
    .map((airport) => ({ airport, score: scoreAirportMatch(airport, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((x) => x.airport);
}

function ensureAirportLayerVisible(airport) {
  if (!airport) return;
  const layerId = airport.isUK ? "airports_uk" : "airports_global";
  const cb = document.querySelector(`.layer-cb[data-layer="${layerId}"]`);
  if (cb && !cb.checked) cb.checked = true;
  const layer = layers[layerId];
  if (layer && !map.hasLayer(layer)) layer.addTo(map);
}

function focusAirportOnMap(airport) {
  if (!airport || !Number.isFinite(airport.lat) || !Number.isFinite(airport.lon)) return;
  ensureAirportLayerVisible(airport);
  map.flyTo([airport.lat, airport.lon], Math.max(map.getZoom(), 9), { duration: 0.6 });
  if (airport.markerRef && typeof airport.markerRef.openPopup === "function") {
    setTimeout(() => {
      try { airport.markerRef.openPopup(); } catch (_) {}
    }, 220);
  }
}

function renderAirportSearchResults(items) {
  const wrap = document.getElementById("airport-search-results");
  if (!wrap) return;
  if (!Array.isArray(items) || items.length === 0) {
    wrap.innerHTML = `<div class="nr-empty">No airports matched this query.</div>`;
    return;
  }
  wrap.innerHTML = items.map((airport, idx) => {
    const label = `${airport.name || "Airport"} (${airport.iata && airport.iata !== "N/A" ? airport.iata : (airport.icao || "N/A")})`;
    const meta = [airport.city, airport.country].filter(Boolean).join(", ");
    return (
      `<button class="airport-result-item" type="button" data-airport-result="${idx}">` +
        `<span class="airport-result-name">${escapeHtml(label)}</span>` +
        `<span class="airport-result-meta">${escapeHtml(meta || "No location metadata")}</span>` +
      `</button>`
    );
  }).join("");

  const nodes = wrap.querySelectorAll("[data-airport-result]");
  nodes.forEach((node) => {
    node.addEventListener("click", () => {
      const i = Number(node.getAttribute("data-airport-result"));
      if (!Number.isFinite(i) || !items[i]) return;
      focusAirportOnMap(items[i]);
    });
  });
}

async function ensureAirportsLoaded() {
  if (OVERLAY_LOAD_STATE.airportsLoaded) return true;
  if (OVERLAY_LOAD_STATE.airportsLoading) return OVERLAY_LOAD_STATE.airportsLoading;
  window.AIRPORT_INDEX.all = [];
  window.AIRPORT_INDEX.uk = [];
  window.AIRPORT_INDEX.byIcao = {};
  window.AIRPORT_INDEX.byIata = {};
  OVERLAY_LOAD_STATE.airportsLoading = Promise.all([
    fetch("data/airports.geojson").then((r) => r.json()),
    airportLogoMapPromise
  ]).then(([data, logoMap]) => {
    if (logoMap) setAirportLogoMap(logoMap);
    L.geoJSON(data, {
      pointToLayer: (f, ll) => {
        const isUK = UK_COUNTRIES.includes((f.properties?.country || "").toUpperCase());
        const logoPath = isUK ? getAirportLogoPathFromProps(f.properties || {}) : "";
        if (logoPath) {
          return L.marker(ll, { icon: getAirportLogoIcon(logoPath, isUK) });
        }
        return L.circleMarker(ll, {
          radius: isUK ? 5 : 3,
          color: isUK ? "#38bdf8" : "#0284c7",
          fillColor: isUK ? "#38bdf8" : "#0284c7",
          fillOpacity: isUK ? 0.9 : 0.5,
          weight: isUK ? 2 : 1
        });
      },
      onEachFeature: (f, l) => {
        const c = (f.properties?.country || "").toUpperCase();
        const isUK = UK_COUNTRIES.includes(c);
        const logoPath = isUK ? getAirportLogoPathFromProps(f.properties || {}) : "";
        const airport = {
          icao: String(f.properties?.icao || "").toUpperCase(),
          iata: String(f.properties?.iata || "").toUpperCase(),
          name: String(f.properties?.name || "Unnamed"),
          city: String(f.properties?.city || ""),
          country: c,
          lat: Number(f.geometry?.coordinates?.[1]),
          lon: Number(f.geometry?.coordinates?.[0]),
          isUK,
          logoPath: logoPath || "",
          markerRef: l
        };
        window.AIRPORT_INDEX.all.push(airport);
        if (isUK) window.AIRPORT_INDEX.uk.push(airport);
        if (airport.icao) window.AIRPORT_INDEX.byIcao[airport.icao] = airport;
        if (airport.iata && airport.iata !== "N/A") window.AIRPORT_INDEX.byIata[airport.iata] = airport;

        l._airportMeta = airport;
        l.bindPopup(airportPopupHtml(airport));
        l.on("popupopen", () => {
          if (typeof window.buildAirportIntelPopup === "function") {
            try {
              const html = window.buildAirportIntelPopup(l._airportMeta);
              if (html) l.setPopupContent(html);
            } catch (_) {
              // keep fallback popup
            }
          }
        });
        (isUK ? layers.airports_uk : layers.airports_global).addLayer(l);
      }
    });
    OVERLAY_LOAD_STATE.airportsLoaded = true;
    return true;
  }).catch((e) => {
    console.warn("Airports:", e);
    return false;
  }).finally(() => {
    OVERLAY_LOAD_STATE.airportsLoading = null;
  });
  return OVERLAY_LOAD_STATE.airportsLoading;
}

// Seaports
async function ensureSeaportsLoaded() {
  if (OVERLAY_LOAD_STATE.seaportsLoaded) return true;
  if (OVERLAY_LOAD_STATE.seaportsLoading) return OVERLAY_LOAD_STATE.seaportsLoading;
  OVERLAY_LOAD_STATE.seaportsLoading = fetch("data/sea_ports_simple.geojson")
    .then((r) => r.json())
    .then((data) => {
      L.geoJSON(data, {
        pointToLayer: (_, ll) => L.circleMarker(ll, {
          radius: 5, color: "#2dd4bf", fillColor: "#2dd4bf", fillOpacity: 0.85, weight: 1.5
        }),
        onEachFeature: (f, l) =>
          l.bindPopup(`<strong>${f.properties?.name || "Seaport"}</strong><br><span class="popup-label">Seaport</span>`)
      }).addTo(layers.seaports);
      OVERLAY_LOAD_STATE.seaportsLoaded = true;
      return true;
    })
    .catch((e) => {
      console.warn("Seaports:", e);
      return false;
    })
    .finally(() => {
      OVERLAY_LOAD_STATE.seaportsLoading = null;
    });
  return OVERLAY_LOAD_STATE.seaportsLoading;
}

const OS_DERIVED_STATE = {
  roadsLoaded: false,
  railLoaded: false,
  roadsFailed: false,
  railFailed: false,
  warned: false,
  roadsData: null,
  roadsMergedRoutes: null,
  railData: null,
  railMergedRoutes: null,
  railStationData: null,
  roadsLayer: null,
  railLayer: null,
  roadsStatic: false,
  railStatic: false,
  railRenderSig: "",
  roadsStaticRenderSig: "",
  railStaticRenderSig: "",
  roadsSelectedLineKey: "",
  roadsRenderedSegments: [],
  railSelectedLineKey: "",
  railRenderedSegments: []
};

function markOsDerivedLayerUnavailable(layerKey, reason = "") {
  const cb = document.querySelector(`.layer-cb[data-layer="${layerKey}"]`);
  if (cb) {
    cb.checked = false;
    cb.disabled = true;
    const row = cb.closest(".layer-row");
    if (row) {
      row.classList.add("layer-row-disabled");
      const nameEl = row.querySelector(".layer-name");
      if (nameEl && !String(nameEl.textContent || "").includes("(unavailable)")) {
        nameEl.textContent = `${nameEl.textContent} (unavailable)`;
      }
      row.title = reason || "Layer data unavailable";
    }
  }
}

function notifyOsDerivedUnavailableOnce(message) {
  if (OS_DERIVED_STATE.warned) return;
  OS_DERIVED_STATE.warned = true;
  setStatus(message || "OS-derived overlays unavailable in this build.");
}

function markLayerAsStaticMode(layerKey, label = "static") {
  const cb = document.querySelector(`.layer-cb[data-layer="${layerKey}"]`);
  const row = cb?.closest(".layer-row");
  if (!row) return;
  const nameEl = row.querySelector(".layer-name");
  if (!nameEl) return;
  const txt = String(nameEl.textContent || "");
  if (!txt.includes("(static)")) {
    nameEl.textContent = `${txt} (${label})`;
  }
  if (layerKey === "os_rail") {
    row.title = "Layer loaded from static UK rail network geometry";
    return;
  }
  row.title = `Layer loaded using ${label} pre-baked coordinates`;
}

const OS_ROAD_BASE_COLOURS = {
  motorway: "#f97316",
  trunk: "#f59e0b",
  primary: "#eab308",
  secondary: "#d97706",
  tertiary: "#fb923c"
};
const OS_ROAD_LINE_PALETTE = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#0ea5e9",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899"
];
const OS_RAIL_LINE_PALETTE = [
  "#2563eb",
  "#ef4444",
  "#16a34a",
  "#ca8a04",
  "#9333ea",
  "#0d9488",
  "#db2777",
  "#ea580c",
  "#0284c7",
  "#4f46e5"
];

function hashStringToInt(input) {
  const s = String(input || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function tweakHexColor(hex, delta = 0) {
  const clean = String(hex || "").replace("#", "");
  if (clean.length !== 6) return hex || "#94a3b8";
  const n = parseInt(clean, 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const d = Math.max(-50, Math.min(50, delta));
  r = Math.max(0, Math.min(255, r + d));
  g = Math.max(0, Math.min(255, g + d));
  b = Math.max(0, Math.min(255, b + d));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function osRoadColorForFeature(properties = {}) {
  const highway = String(properties.highway || "").toLowerCase();
  const name = String(properties.name || "").trim().toLowerCase();
  if (name) {
    const hashed = OS_ROAD_LINE_PALETTE[hashStringToInt(`${highway}|${name}`) % OS_ROAD_LINE_PALETTE.length];
    if (highway === "motorway") return tweakHexColor(hashed, 10);
    if (highway === "trunk") return tweakHexColor(hashed, 6);
    if (highway === "primary") return tweakHexColor(hashed, 2);
    return tweakHexColor(hashed, -2);
  }
  const base = OS_ROAD_BASE_COLOURS[highway] || "#fb923c";
  return tweakHexColor(base, 8);
}

function osRailColorForFeature(properties = {}) {
  const kind = String(properties.railway || "").toLowerCase();
  if (kind === "subway" || kind === "light_rail" || kind === "tram") return "#22d3ee";
  if (kind === "narrow_gauge") return "#818cf8";
  if (kind === "rail") return "#38bdf8";
  if (kind === "disused" || kind === "abandoned") return "#64748b";
  if (kind === "construction") return "#f59e0b";
  return "#60a5fa";
}

async function fetchGeoJsonFromCandidates(paths) {
  for (const p of paths) {
    try {
      const r = await fetch(p);
      if (!r.ok) continue;
      const data = await r.json();
      if (data && data.type === "FeatureCollection") return { data, path: p };
    } catch (_) {
      // try next path
    }
  }
  return null;
}

async function fetchJsonFromCandidates(paths) {
  for (const p of paths) {
    try {
      const r = await fetch(p);
      if (!r.ok) continue;
      const data = await r.json();
      if (data && typeof data === "object") return { data, path: p };
    } catch (_) {
      // try next path
    }
  }
  return null;
}

function getExpandedBounds(pad = 0.18) {
  try {
    return map.getBounds().pad(pad);
  } catch (_) {
    return null;
  }
}

function featureInBounds(feature, bounds) {
  if (!feature || !bounds) return false;
  const g = feature.geometry || {};
  const t = g.type;
  const c = g.coordinates;
  if (!c) return false;
  const hit = (lng, lat) => bounds.contains([lat, lng]);
  if (t === "LineString") {
    for (const p of c) {
      if (Array.isArray(p) && p.length >= 2 && hit(p[0], p[1])) return true;
    }
    return false;
  }
  if (t === "MultiLineString") {
    for (const line of c) {
      for (const p of line || []) {
        if (Array.isArray(p) && p.length >= 2 && hit(p[0], p[1])) return true;
      }
    }
    return false;
  }
  if (t === "Point") return hit(c[0], c[1]);
  if (t === "MultiPoint") return (c || []).some((p) => Array.isArray(p) && p.length >= 2 && hit(p[0], p[1]));
  return false;
}

function railVisibleAtZoom(properties = {}, zoom = 0) {
  const kind = String(properties.railway || "").toLowerCase();
  if (zoom <= 7) return kind === "rail" || kind === "subway" || kind === "light_rail" || kind === "tram";
  if (zoom <= 9) return kind === "rail" || kind === "subway" || kind === "light_rail";
  return true;
}

function getOsRenderSignature() {
  const b = map.getBounds();
  const z = map.getZoom();
  return `${z}|${b.getSouth().toFixed(2)}|${b.getWest().toFixed(2)}|${b.getNorth().toFixed(2)}|${b.getEast().toFixed(2)}`;
}

function getStaticRenderSignature() {
  const b = map.getBounds();
  const z = map.getZoom();
  return `${z}|${b.getSouth().toFixed(2)}|${b.getWest().toFixed(2)}|${b.getNorth().toFixed(2)}|${b.getEast().toFixed(2)}`;
}

function staticRouteInBounds(coords = [], bounds = null) {
  if (!bounds || !Array.isArray(coords)) return false;
  for (const p of coords) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lat = Number(p[0]);
    const lon = Number(p[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && bounds.contains([lat, lon])) return true;
  }
  return false;
}

function staticRoadVisibleAtZoom(type = "", zoom = 0) {
  const t = String(type || "").toLowerCase();
  if (zoom <= 7) return t === "motorway" || t === "trunk" || t === "primary" || t === "secondary";
  if (zoom <= 9) return t === "motorway" || t === "trunk" || t === "primary" || t === "secondary" || t === "tertiary";
  return true;
}

function normalizeRoadRouteName(name = "") {
  return String(name || "").trim().toLowerCase();
}

function staticRoadMajorThresholdKm(zoom = 0) {
  if (zoom <= 7) return 22;
  if (zoom <= 9) return 12;
  return 4;
}

function staticRoadPriorityScore(route = {}, totalKm = 0) {
  const t = String(route?.type || "").toLowerCase();
  const name = normalizeRoadRouteName(route?.name);
  const coords = Array.isArray(route?.coords) ? route.coords : [];
  const segKm = routeLengthKm(coords);
  const effectiveKm = Math.max(Number(totalKm || 0), segKm);

  let score = 0;
  // Road class baseline.
  if (t === "motorway") score += 30;
  else if (t === "trunk") score += 22;
  else if (t === "primary") score += 14;
  else if (t === "secondary") score += 8;
  else if (t === "tertiary") score += 3;

  // Strategic route references in name.
  if (/\bm\d{1,3}\b/.test(name)) score += 18;          // M1, M62, etc.
  if (/\ba\d{1,3}(\(m\))?\b/.test(name)) score += 10;  // A1, A14, A1(M)
  if (/\(m\)/.test(name)) score += 6;                  // A-road motorway sections

  // Corridor-style names.
  if (/ring road|orbital|bypass/.test(name)) score += 6;
  if (/north|south|east|west/.test(name)) score += 2;

  // Scale influence.
  score += Math.min(12, Math.round(effectiveKm * 0.16));
  if (effectiveKm >= 80) score += 4;
  if (effectiveKm >= 120) score += 4;
  return score;
}

function isMajorStaticRoadRoute(route = {}, totalKm = 0, zoom = 0) {
  const t = String(route?.type || "").toLowerCase();
  if (!(t === "motorway" || t === "trunk" || t === "primary" || t === "secondary" || t === "tertiary")) return false;
  const coords = Array.isArray(route?.coords) ? route.coords : [];
  const segKm = routeLengthKm(coords);
  const threshold = staticRoadMajorThresholdKm(zoom);
  const score = staticRoadPriorityScore(route, totalKm);
  const scoreThreshold = zoom <= 7 ? 22 : (zoom <= 9 ? 16 : 10);
  if (score >= scoreThreshold) return true;
  if (Number(totalKm || 0) >= threshold) return true;
  return segKm >= Math.max(0.8, threshold * 0.2);
}

function staticRailVisibleAtZoom(type = "", zoom = 0) {
  const t = String(type || "").toLowerCase();
  if (zoom <= 7) return t === "rail" || t === "light_rail" || t === "subway" || t === "tram";
  if (zoom <= 9) return t === "rail" || t === "light_rail" || t === "subway" || t === "tram" || t === "narrow_gauge";
  return true;
}

function staticRailMajorThresholdKm(zoom = 0) {
  if (zoom <= 7) return 14;
  if (zoom <= 9) return 7;
  return 2;
}

function normalizeRailRouteName(name = "") {
  return String(name || "").trim().toLowerCase();
}

function staticRailPriorityScore(route = {}, totalKm = 0) {
  const t = String(route?.type || "").toLowerCase();
  if (!(t === "rail" || t === "light_rail" || t === "subway" || t === "tram")) return 0;
  const name = normalizeRailRouteName(route?.name);
  const coords = Array.isArray(route?.coords) ? route.coords : [];
  const segKm = routeLengthKm(coords);
  const effectiveKm = Math.max(Number(totalKm || 0), segKm);

  let score = 0;
  // Length matters, but should not dominate named trunk corridors.
  score += Math.min(14, Math.round(effectiveKm * 0.22));
  if (effectiveKm >= 40) score += 4;
  if (effectiveKm >= 70) score += 3;

  if (/main line/.test(name)) score += 22;
  if (/high speed|hs1|hs2/.test(name)) score += 20;
  if (/cross country|cross-country/.test(name)) score += 14;
  if (/coast|coastway/.test(name)) score += 12;
  if (/east coast|west coast|midland|great western|great eastern|south western|south west/.test(name)) score += 12;
  if (/thameslink|elizabeth line|north london line|chiltern|brighton|chatham|highland|settle-carlisle/.test(name)) score += 9;
  if (/branch|loop|tram|metro/.test(name)) score -= 4;

  if (t === "rail") score += 5;
  if (t === "light_rail" || t === "subway" || t === "tram") score += 2;
  return score;
}

function railDisplayRouteLimitForZoom(zoom = 0) {
  if (zoom <= 7) return 180;
  if (zoom <= 9) return 320;
  if (zoom <= 11) return 520;
  return 760;
}

function simplifyCoordsByStepKm(coords = [], minStepKm = 0.2) {
  if (!Array.isArray(coords) || coords.length < 3) return Array.isArray(coords) ? coords.slice() : [];
  const out = [];
  let last = null;
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i];
    if (!Array.isArray(p) || p.length < 2) continue;
    if (!last) {
      out.push(p);
      last = p;
      continue;
    }
    if (i === coords.length - 1) {
      out.push(p);
      last = p;
      continue;
    }
    const d = distanceKm(last, p);
    if (Number.isFinite(d) && d >= minStepKm) {
      out.push(p);
      last = p;
    }
  }
  if (out.length < 2 && coords.length >= 2) return [coords[0], coords[coords.length - 1]];
  return out;
}

function simplifyRailRouteForDisplay(coords = [], zoom = 0) {
  if (zoom <= 7) return simplifyCoordsByStepKm(coords, 0.55);
  if (zoom <= 9) return simplifyCoordsByStepKm(coords, 0.28);
  if (zoom <= 11) return simplifyCoordsByStepKm(coords, 0.14);
  return simplifyCoordsByStepKm(coords, 0.08);
}

function buildRailSpineDisplayRoutes(routes = [], zoom = 0) {
  const base = (routes || [])
    .map((r) => ({
      ...r,
      type: String(r?.type || "rail").toLowerCase(),
      name: `__spine_${String(r?.type || "rail").toLowerCase()}`
    }))
    .filter((r) => Array.isArray(r?.coords) && r.coords.length >= 2);
  if (!base.length) return [];

  const stitched = [...base];
  const connectors = buildEndpointConnectors(base, zoom <= 8 ? 0.75 : 0.5);
  for (const c of connectors) {
    stitched.push({
      ...c,
      type: String(c?.type || "rail").toLowerCase(),
      name: `__spine_${String(c?.type || "rail").toLowerCase()}`
    });
  }

  const merged = mergeStaticRailRoutes(stitched)
    .filter((r) => routeLengthKm(Array.isArray(r?.coords) ? r.coords : []) >= (zoom <= 8 ? 1.2 : 0.8))
    .map((r) => ({
      ...r,
      displayName: (String(r?.type || "rail") === "rail") ? "National Rail Spine" : `${String(r?.type || "rail")} spine`
    }));

  return merged;
}

function isMajorStaticRailRoute(route = {}, totalKm = 0, zoom = 0) {
  const t = String(route?.type || "").toLowerCase();
  if (!(t === "rail" || t === "light_rail" || t === "subway" || t === "tram")) return false;
  const coords = Array.isArray(route?.coords) ? route.coords : [];
  const segKm = routeLengthKm(coords);
  const threshold = staticRailMajorThresholdKm(zoom);
  const score = staticRailPriorityScore(route, totalKm);
  const scoreThreshold = zoom <= 7 ? 18 : (zoom <= 9 ? 12 : 8);
  if (score >= scoreThreshold) return true;
  if (Number(totalKm || 0) >= threshold) return true;
  // Keep shorter fragments that are likely part of major lines.
  return segKm >= Math.max(0.6, threshold * 0.22);
}

function distanceKm(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return Infinity;
  const lat1 = Number(a[0]);
  const lon1 = Number(a[1]);
  const lat2 = Number(b[0]);
  const lon2 = Number(b[1]);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const x = dLon * Math.cos(((lat1 + lat2) * 0.5) * rad);
  const y = dLat;
  return Math.sqrt(x * x + y * y) * 6371;
}

function buildEndpointConnectors(routes = [], maxGapKm = 1.4) {
  const connectors = [];
  const endpoints = [];
  const cellSizeDeg = Math.max(0.0025, maxGapKm / 111);
  const cells = new Map();
  const pairSeen = new Set();

  const cellKey = (lat, lon) => `${Math.floor(lat / cellSizeDeg)}|${Math.floor(lon / cellSizeDeg)}`;
  const pushCell = (idx, endpoint) => {
    const key = cellKey(endpoint[0], endpoint[1]);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(idx);
  };

  for (let i = 0; i < routes.length; i++) {
    const coords = Array.isArray(routes[i]?.coords) ? routes[i].coords : [];
    if (coords.length < 2) continue;
    const a = coords[0];
    const b = coords[coords.length - 1];
    endpoints.push({ routeIdx: i, endpoint: a, side: "s" });
    pushCell(endpoints.length - 1, a);
    endpoints.push({ routeIdx: i, endpoint: b, side: "e" });
    pushCell(endpoints.length - 1, b);
  }

  const neighbourCellKeys = (lat, lon) => {
    const r = Math.floor(lat / cellSizeDeg);
    const c = Math.floor(lon / cellSizeDeg);
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) out.push(`${r + dr}|${c + dc}`);
    }
    return out;
  };

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    const [lat, lon] = ep.endpoint;
    let best = null;
    for (const ck of neighbourCellKeys(lat, lon)) {
      const idxs = cells.get(ck) || [];
      for (const j of idxs) {
        if (j === i) continue;
        const other = endpoints[j];
        if (!other || other.routeIdx === ep.routeIdx) continue;
        const d = distanceKm(ep.endpoint, other.endpoint);
        if (!Number.isFinite(d) || d > maxGapKm) continue;
        if (!best || d < best.d) best = { d, other };
      }
    }
    if (!best) continue;
    const r1 = routes[ep.routeIdx];
    const r2 = routes[best.other.routeIdx];
    const typeMatch = String(r1?.type || "").toLowerCase() === String(r2?.type || "").toLowerCase();
    const n1 = String(r1?.name || "").trim().toLowerCase();
    const n2 = String(r2?.name || "").trim().toLowerCase();
    const nameMatch = !!n1 && !!n2 && n1 === n2;
    if (!typeMatch && !nameMatch) continue;

    const pairKey = [buildCoordKey(ep.endpoint, 5), buildCoordKey(best.other.endpoint, 5)].sort().join("|");
    if (pairSeen.has(pairKey)) continue;
    pairSeen.add(pairKey);
    connectors.push({
      coords: [ep.endpoint, best.other.endpoint],
      type: r1?.type || r2?.type || "",
      name: r1?.name || r2?.name || ""
    });
  }
  return connectors;
}

function normalizeRailLineKey(type = "", name = "") {
  const t = String(type || "").trim().toLowerCase();
  const n = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${t}|${n}`;
}

function buildRailGapConnectors(routes = [], maxGapKm = 0.12) {
  const out = [];
  const byLine = new Map();
  for (const r of routes || []) {
    const key = normalizeRailLineKey(r?.type, r?.name);
    if (!key || key.endsWith("|")) continue;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(r);
  }
  for (const group of byLine.values()) {
    if (!Array.isArray(group) || group.length < 2) continue;
    out.push(...buildEndpointConnectors(group, maxGapKm));
  }

  // Additional stitching across same rail type when line naming changes between
  // adjacent segments (common in nationwide OSM-derived extracts).
  const byType = new Map();
  for (const r of routes || []) {
    const t = String(r?.type || "").toLowerCase();
    if (!(t === "rail" || t === "light_rail" || t === "subway" || t === "tram")) continue;
    const score = staticRailPriorityScore(r, routeLengthKm(Array.isArray(r?.coords) ? r.coords : []));
    if (score < 12) continue;
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }
  for (const group of byType.values()) {
    if (!Array.isArray(group) || group.length < 2) continue;
    out.push(...buildEndpointConnectors(group, Math.max(0.08, maxGapKm * 0.78)));
  }

  const dedup = [];
  const seen = new Set();
  for (const c of out) {
    const a = buildCoordKey(c?.coords?.[0], 5);
    const b = buildCoordKey(c?.coords?.[1], 5);
    if (!a || !b) continue;
    const k = [a, b].sort().join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(c);
  }
  return dedup;
}

function normalizeRoadLineKey(type = "", name = "") {
  const t = String(type || "").trim().toLowerCase();
  const n = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${t}|${n}`;
}

function buildRoadGapConnectors(routes = [], maxGapKm = 0.1) {
  const out = [];
  const byRoad = new Map();
  for (const r of routes || []) {
    const key = normalizeRoadLineKey(r?.type, r?.name);
    if (!key || key.endsWith("|")) continue;
    if (!byRoad.has(key)) byRoad.set(key, []);
    byRoad.get(key).push(r);
  }
  for (const group of byRoad.values()) {
    if (!Array.isArray(group) || group.length < 2) continue;
    out.push(...buildEndpointConnectors(group, maxGapKm));
  }

  // Additional stitching for strategic roads where naming changes across
  // contiguous motorway/trunk segments.
  const strategic = [];
  for (const r of routes || []) {
    const t = String(r?.type || "").toLowerCase();
    if (!(t === "motorway" || t === "trunk" || t === "primary")) continue;
    const score = staticRoadPriorityScore(r, routeLengthKm(Array.isArray(r?.coords) ? r.coords : []));
    if (score < 18) continue;
    strategic.push(r);
  }
  if (strategic.length >= 2) {
    out.push(...buildEndpointConnectors(strategic, Math.max(0.1, maxGapKm * 0.82)));
  }

  const dedup = [];
  const seen = new Set();
  for (const c of out) {
    const a = buildCoordKey(c?.coords?.[0], 5);
    const b = buildCoordKey(c?.coords?.[1], 5);
    if (!a || !b) continue;
    const k = [a, b].sort().join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(c);
  }
  return dedup;
}

function routeLengthKm(coords = []) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = distanceKm(coords[i - 1], coords[i]);
    if (Number.isFinite(d)) total += d;
  }
  return total;
}

function buildRoadLineLengthTotals(routes = []) {
  const totals = new Map();
  for (const r of routes || []) {
    const coords = Array.isArray(r?.coords) ? r.coords : [];
    if (coords.length < 2) continue;
    const key = normalizeRoadLineKey(r?.type, r?.name);
    if (!key || key.endsWith("|")) continue;
    const km = routeLengthKm(coords);
    totals.set(key, (totals.get(key) || 0) + km);
  }
  return totals;
}

function buildOsRoadLinePopupHtml(route = {}, lineKey = "", totalKm = 0) {
  const safeName = String(route?.name || "Unnamed Road");
  const safeType = String(route?.type || "road");
  const segKm = routeLengthKm(Array.isArray(route?.coords) ? route.coords : []);
  const selected = String(OS_DERIVED_STATE.roadsSelectedLineKey || "") === String(lineKey || "");
  const encodedKey = encodeURIComponent(String(lineKey || ""));
  const actionButton = selected
    ? `<button class="popup-psc-btn" type="button" onclick="clearOsRoadLineSelection()">Clear Focus</button>`
    : `<button class="popup-psc-btn" type="button" onclick="selectOsRoadLine('${encodedKey}')">Focus This Road</button>`;
  return (
    `<strong>${escapeHtml(safeName)}</strong><br>` +
    `<span class="popup-label">Type</span> ${escapeHtml(safeType)}<br>` +
    `<span class="popup-label">Route Length</span> ${Number(totalKm || 0).toFixed(1)} km<br>` +
    `<span class="popup-label">Visible Segment</span> ${Number(segKm || 0).toFixed(2)} km<br>` +
    `<span class="popup-label">Priority</span> ${selected ? "Focused" : "Default (longest routes drawn on top)"}<br>` +
    `<div class="cp-btn-row" style="margin-top:8px;">${actionButton}</div>`
  );
}

function applyOsRoadSelectionStyles() {
  const segments = Array.isArray(OS_DERIVED_STATE.roadsRenderedSegments) ? OS_DERIVED_STATE.roadsRenderedSegments : [];
  if (!segments.length) return;
  const selectedKey = String(OS_DERIVED_STATE.roadsSelectedLineKey || "");
  let minTotal = Infinity;
  let maxTotal = 0;
  for (const seg of segments) {
    const t = Number(seg?.totalKm || 0);
    if (!Number.isFinite(t)) continue;
    minTotal = Math.min(minTotal, t);
    maxTotal = Math.max(maxTotal, t);
  }
  if (!Number.isFinite(minTotal)) minTotal = 0;
  const span = Math.max(0.0001, maxTotal - minTotal);

  for (const seg of segments) {
    const layer = seg?.layer;
    if (!layer || typeof layer.setStyle !== "function") continue;
    const totalKm = Number(seg?.totalKm || 0);
    const baseWeight = Number(seg?.baseWeight || 3);
    const hasSelection = !!selectedKey;
    const selected = hasSelection && String(seg?.lineKey || "") === selectedKey;
    const rank = Math.max(0, Math.min(1, (totalKm - minTotal) / span));

    let opacity = 0.7 + (rank * 0.24);
    let weight = baseWeight + (rank * 0.45);
    if (hasSelection) {
      opacity = selected ? 0.99 : 0.12;
      weight = selected ? (baseWeight + 2.1) : Math.max(1.4, baseWeight - 1.2);
    }
    layer.setStyle({ opacity, weight });
    if (layer._path) {
      layer._path.classList.remove("os-road-line-selected", "os-road-line-dimmed");
      if (hasSelection && selected) layer._path.classList.add("os-road-line-selected");
      if (hasSelection && !selected) layer._path.classList.add("os-road-line-dimmed");
    }
    if (hasSelection && selected && typeof layer.bringToFront === "function") layer.bringToFront();
  }
}

window.selectOsRoadLine = function selectOsRoadLine(encodedLineKey = "") {
  let lineKey = String(encodedLineKey || "");
  try {
    lineKey = decodeURIComponent(lineKey);
  } catch (_) {
    // keep raw value
  }
  OS_DERIVED_STATE.roadsSelectedLineKey = lineKey;
  applyOsRoadSelectionStyles();
  if (lineKey) setStatus(`OS roads focus: ${lineKey}`);
};

window.clearOsRoadLineSelection = function clearOsRoadLineSelection() {
  OS_DERIVED_STATE.roadsSelectedLineKey = "";
  applyOsRoadSelectionStyles();
  setStatus("OS roads focus cleared");
};

function buildRailLineLengthTotals(routes = []) {
  const totals = new Map();
  for (const r of routes || []) {
    const coords = Array.isArray(r?.coords) ? r.coords : [];
    if (coords.length < 2) continue;
    const key = normalizeRailLineKey(r?.type, r?.name);
    if (!key || key.endsWith("|")) continue;
    const km = routeLengthKm(coords);
    totals.set(key, (totals.get(key) || 0) + km);
  }
  return totals;
}

function buildOsRailLinePopupHtml(route = {}, lineKey = "", totalKm = 0) {
  const safeName = String(route?.name || "Unnamed Rail Line");
  const safeType = String(route?.type || "rail");
  const segKm = routeLengthKm(Array.isArray(route?.coords) ? route.coords : []);
  const selected = String(OS_DERIVED_STATE.railSelectedLineKey || "") === String(lineKey || "");
  const encodedKey = encodeURIComponent(String(lineKey || ""));
  const actionButton = selected
    ? `<button class="popup-psc-btn" type="button" onclick="clearOsRailLineSelection()">Clear Focus</button>`
    : `<button class="popup-psc-btn" type="button" onclick="selectOsRailLine('${encodedKey}')">Focus This Line</button>`;
  return (
    `<strong>${escapeHtml(safeName)}</strong><br>` +
    `<span class="popup-label">Type</span> ${escapeHtml(safeType)}<br>` +
    `<span class="popup-label">Line Length</span> ${Number(totalKm || 0).toFixed(1)} km<br>` +
    `<span class="popup-label">Visible Segment</span> ${Number(segKm || 0).toFixed(2)} km<br>` +
    `<span class="popup-label">Priority</span> ${selected ? "Focused" : "Default (longest lines drawn on top)"}<br>` +
    `<div class="cp-btn-row" style="margin-top:8px;">${actionButton}</div>`
  );
}

function applyOsRailSelectionStyles() {
  const segments = Array.isArray(OS_DERIVED_STATE.railRenderedSegments) ? OS_DERIVED_STATE.railRenderedSegments : [];
  if (!segments.length) return;
  const selectedKey = String(OS_DERIVED_STATE.railSelectedLineKey || "");
  let minTotal = Infinity;
  let maxTotal = 0;
  for (const seg of segments) {
    const t = Number(seg?.totalKm || 0);
    if (!Number.isFinite(t)) continue;
    minTotal = Math.min(minTotal, t);
    maxTotal = Math.max(maxTotal, t);
  }
  if (!Number.isFinite(minTotal)) minTotal = 0;
  const span = Math.max(0.0001, maxTotal - minTotal);

  for (const seg of segments) {
    const layer = seg?.layer;
    if (!layer || typeof layer.setStyle !== "function") continue;
    const totalKm = Number(seg?.totalKm || 0);
    const baseWeight = Number(seg?.baseWeight || 3);
    const hasSelection = !!selectedKey;
    const selected = hasSelection && String(seg?.lineKey || "") === selectedKey;
    const rank = Math.max(0, Math.min(1, (totalKm - minTotal) / span));

    let opacity = 0.72 + (rank * 0.24);
    let weight = baseWeight + (rank * 0.5);
    if (hasSelection) {
      opacity = selected ? 0.99 : 0.14;
      weight = selected ? (baseWeight + 2.2) : Math.max(1.6, baseWeight - 1.2);
    }
    layer.setStyle({ opacity, weight });
    if (layer._path) {
      layer._path.classList.remove("os-rail-line-selected", "os-rail-line-dimmed");
      if (hasSelection && selected) layer._path.classList.add("os-rail-line-selected");
      if (hasSelection && !selected) layer._path.classList.add("os-rail-line-dimmed");
    }
    if (hasSelection && selected && typeof layer.bringToFront === "function") layer.bringToFront();
  }
}

window.selectOsRailLine = function selectOsRailLine(encodedLineKey = "") {
  let lineKey = String(encodedLineKey || "");
  try {
    lineKey = decodeURIComponent(lineKey);
  } catch (_) {
    // keep raw value
  }
  OS_DERIVED_STATE.railSelectedLineKey = lineKey;
  applyOsRailSelectionStyles();
  if (lineKey) setStatus(`UK rail focus: ${lineKey}`);
};

window.clearOsRailLineSelection = function clearOsRailLineSelection() {
  OS_DERIVED_STATE.railSelectedLineKey = "";
  applyOsRailSelectionStyles();
  setStatus("UK rail focus cleared");
};

function buildCoordKey(coord, precision = 4) {
  if (!Array.isArray(coord) || coord.length < 2) return "";
  const lat = Number(coord[0]);
  const lon = Number(coord[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  return `${lat.toFixed(precision)},${lon.toFixed(precision)}`;
}

function normalizeRouteCoords(coords = []) {
  const out = [];
  let lastKey = "";
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lat = Number(c[0]);
    const lon = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = buildCoordKey([lat, lon], 5);
    if (!key || key === lastKey) continue;
    out.push([lat, lon]);
    lastKey = key;
  }
  return out;
}

function mergeStaticRailRoutes(rawRoutes = []) {
  const joinPrecision = 3;
  const buckets = new Map();
  for (const r of rawRoutes) {
    const coords = normalizeRouteCoords(Array.isArray(r?.coords) ? r.coords : []);
    if (coords.length < 2) continue;
    const type = String(r?.type || "rail");
    const name = String(r?.name || "");
    const key = `${type.toLowerCase()}|${name.toLowerCase()}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ ...r, type, name, coords });
  }

  const merged = [];
  for (const segments of buckets.values()) {
    const pending = [...segments];
    while (pending.length) {
      const current = pending.pop();
      const line = [...current.coords];
      let changed = true;
      while (changed) {
        changed = false;
        const lineStart = buildCoordKey(line[0], joinPrecision);
        const lineEnd = buildCoordKey(line[line.length - 1], joinPrecision);
        for (let i = pending.length - 1; i >= 0; i--) {
          const seg = pending[i];
          const segStart = buildCoordKey(seg.coords[0], joinPrecision);
          const segEnd = buildCoordKey(seg.coords[seg.coords.length - 1], joinPrecision);
          let consumed = false;
          if (lineEnd && lineEnd === segStart) {
            line.push(...seg.coords.slice(1));
            consumed = true;
          } else if (lineEnd && lineEnd === segEnd) {
            line.push(...[...seg.coords].reverse().slice(1));
            consumed = true;
          } else if (lineStart && lineStart === segEnd) {
            line.unshift(...seg.coords.slice(0, -1));
            consumed = true;
          } else if (lineStart && lineStart === segStart) {
            line.unshift(...[...seg.coords].reverse().slice(0, -1));
            consumed = true;
          }
          if (consumed) {
            pending.splice(i, 1);
            changed = true;
          }
        }
      }
      merged.push({
        name: current.name,
        type: current.type,
        coords: normalizeRouteCoords(line)
      });
    }
  }
  return merged;
}

function mergeStaticRoadRoutes(rawRoutes = []) {
  return mergeStaticRailRoutes((rawRoutes || []).map((r) => ({
    ...(r || {}),
    type: String(r?.type || "road"),
    name: String(r?.name || "")
  })));
}

function renderOsRailOverlayViewport() {
  if (!OS_DERIVED_STATE.railData || !OS_DERIVED_STATE.railLayer) return;
  const sig = getOsRenderSignature();
  if (sig === OS_DERIVED_STATE.railRenderSig) return;
  OS_DERIVED_STATE.railRenderSig = sig;
  const bounds = getExpandedBounds(0.22);
  const zoom = map.getZoom();
  const features = (OS_DERIVED_STATE.railData.features || []).filter((f) => {
    const p = f.properties || {};
    return railVisibleAtZoom(p, zoom) && featureInBounds(f, bounds);
  });
  OS_DERIVED_STATE.railLayer.clearLayers();
  L.geoJSON({ type: "FeatureCollection", features }, {
    style: (f) => ({
      color: osRailColorForFeature(f.properties || {}),
      weight: zoom <= 8 ? 2.8 : 3.6,
      opacity: zoom <= 8 ? 0.8 : 0.9,
      className: "os-rail-static-line"
    }),
    onEachFeature: (f, l) => {
      const name = f.properties?.name || "Rail Line";
      const kind = f.properties?.railway || "";
      const coords = f.geometry?.type === "LineString"
        ? (f.geometry.coordinates || []).map((p) => [Number(p?.[1]), Number(p?.[0])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
        : [];
      const segKm = routeLengthKm(coords);
      l.bindPopup(
        `<strong>${escapeHtml(name)}</strong><br>` +
        `<span class="popup-label">Type</span> ${escapeHtml(kind || "rail")}<br>` +
        `<span class="popup-label">Visible Segment</span> ${segKm.toFixed(2)} km`
      );
      if (zoom >= 9) {
        l.bindTooltip(`${escapeHtml(name)}${kind ? ` (${escapeHtml(kind)})` : ""}`, { sticky: true, opacity: 0.88 });
      }
    }
  }).addTo(OS_DERIVED_STATE.railLayer);
}

const scheduleOsRailViewportRender = debounce(renderOsRailOverlayViewport, 160);

function renderStaticRoadOverlay() {
  if (!OS_DERIVED_STATE.roadsLayer || !OS_DERIVED_STATE.roadsData) return;
  const sig = getStaticRenderSignature();
  if (sig === OS_DERIVED_STATE.roadsStaticRenderSig) return;
  OS_DERIVED_STATE.roadsStaticRenderSig = sig;
  const routes = Array.isArray(OS_DERIVED_STATE.roadsMergedRoutes) && OS_DERIVED_STATE.roadsMergedRoutes.length
    ? OS_DERIVED_STATE.roadsMergedRoutes
    : (Array.isArray(OS_DERIVED_STATE.roadsData.routes) ? OS_DERIVED_STATE.roadsData.routes : []);
  const bounds = getExpandedBounds(0.5);
  const zoom = map.getZoom();
  OS_DERIVED_STATE.roadsLayer.clearLayers();
  OS_DERIVED_STATE.roadsRenderedSegments = [];

  const routesForTotals = routes.filter((r) => {
    const coords = Array.isArray(r?.coords) ? r.coords : [];
    return coords.length >= 2 && staticRoadVisibleAtZoom(r?.type, zoom);
  });
  const roadLengthTotals = buildRoadLineLengthTotals(routesForTotals);

  const visibleRoutes = routes.filter((r) => {
    const coords = Array.isArray(r?.coords) ? r.coords : [];
    if (!(coords.length >= 2 && staticRoadVisibleAtZoom(r?.type, zoom) && staticRouteInBounds(coords, bounds))) return false;
    const lineKey = normalizeRoadLineKey(r?.type, r?.name);
    const totalKm = Number(roadLengthTotals.get(lineKey) || routeLengthKm(coords));
    return isMajorStaticRoadRoute(r, totalKm, zoom);
  });
  const orderedVisibleRoutes = [...visibleRoutes].sort((a, b) => {
    const keyA = normalizeRoadLineKey(a?.type, a?.name);
    const keyB = normalizeRoadLineKey(b?.type, b?.name);
    const totalA = Number(roadLengthTotals.get(keyA) || 0);
    const totalB = Number(roadLengthTotals.get(keyB) || 0);
    const priA = staticRoadPriorityScore(a, totalA);
    const priB = staticRoadPriorityScore(b, totalB);
    if (priA !== priB) return priA - priB;
    if (totalA !== totalB) return totalA - totalB;
    return routeLengthKm(a?.coords || []) - routeLengthKm(b?.coords || []);
  });

  for (const r of orderedVisibleRoutes) {
    const coords = Array.isArray(r?.coords) ? r.coords : [];
    const lineKey = normalizeRoadLineKey(r?.type, r?.name);
    const totalKm = Number(roadLengthTotals.get(lineKey) || routeLengthKm(coords));
    const priority = staticRoadPriorityScore(r, totalKm);
    const priorityBoost = Math.max(0, Math.min(1.6, (priority - 8) * 0.06));
    const baseWeight = (zoom <= 8 ? 3.0 : 3.7) + priorityBoost;
    const line = L.polyline(coords, {
      color: osRoadColorForFeature({ highway: r.type, name: r.name }),
      weight: baseWeight,
      opacity: 0.92,
      smoothFactor: 1.8,
      className: "os-road-static-line os-road-line-interactive"
    }).addTo(OS_DERIVED_STATE.roadsLayer);
    line.bindPopup(buildOsRoadLinePopupHtml(r, lineKey, totalKm));
    line.on("click", () => {
      if (lineKey) OS_DERIVED_STATE.roadsSelectedLineKey = lineKey;
      applyOsRoadSelectionStyles();
    });
    if (r.name && zoom >= 9) {
      line.bindTooltip(`${escapeHtml(r.name)}${r.type ? ` (${escapeHtml(r.type)})` : ""}`, { sticky: true, opacity: 0.88 });
    }
    OS_DERIVED_STATE.roadsRenderedSegments.push({ layer: line, lineKey, totalKm, baseWeight });
  }

  const roadConnectors = buildRoadGapConnectors(visibleRoutes, zoom <= 8 ? 0.38 : 0.24);
  for (const c of roadConnectors) {
    const lineKey = normalizeRoadLineKey(c?.type, c?.name);
    const totalKm = Number(roadLengthTotals.get(lineKey) || routeLengthKm(c?.coords || []));
    const priority = staticRoadPriorityScore(c, totalKm);
    const priorityBoost = Math.max(0, Math.min(1.1, (priority - 8) * 0.045));
    const baseWeight = (zoom <= 8 ? 2.3 : 2.7) + priorityBoost;
    const connector = L.polyline(c.coords, {
      color: osRoadColorForFeature({ highway: c.type, name: c.name }),
      weight: baseWeight,
      opacity: 0.88,
      smoothFactor: 1.8,
      className: "os-road-static-line os-road-line-interactive"
    }).addTo(OS_DERIVED_STATE.roadsLayer);
    connector.bindPopup(buildOsRoadLinePopupHtml(c, lineKey, totalKm));
    connector.on("click", () => {
      if (lineKey) OS_DERIVED_STATE.roadsSelectedLineKey = lineKey;
      applyOsRoadSelectionStyles();
    });
    OS_DERIVED_STATE.roadsRenderedSegments.push({ layer: connector, lineKey, totalKm, baseWeight });
  }
  applyOsRoadSelectionStyles();
}

function renderStaticRailOverlay() {
  if (!OS_DERIVED_STATE.railLayer || !OS_DERIVED_STATE.railData) return;
  const sig = getStaticRenderSignature();
  if (sig === OS_DERIVED_STATE.railStaticRenderSig) return;
  OS_DERIVED_STATE.railStaticRenderSig = sig;
  const routes = Array.isArray(OS_DERIVED_STATE.railMergedRoutes) && OS_DERIVED_STATE.railMergedRoutes.length
    ? OS_DERIVED_STATE.railMergedRoutes
    : (Array.isArray(OS_DERIVED_STATE.railData.routes) ? OS_DERIVED_STATE.railData.routes : []);
  const stations = Array.isArray(OS_DERIVED_STATE.railStationData?.stations) ? OS_DERIVED_STATE.railStationData.stations : [];
  const bounds = getExpandedBounds(0.5);
  const zoom = map.getZoom();
  OS_DERIVED_STATE.railLayer.clearLayers();
  OS_DERIVED_STATE.railRenderedSegments = [];

  const routesForTotals = routes.filter((r) => {
    const coords = Array.isArray(r?.coords) ? r.coords : [];
    return coords.length >= 2 && staticRailVisibleAtZoom(r?.type, zoom);
  });
  const lineLengthTotals = buildRailLineLengthTotals(routesForTotals);

  const visibleCandidates = routes.filter((r) => {
    const coords = Array.isArray(r?.coords) ? r.coords : [];
    return coords.length >= 2 && staticRailVisibleAtZoom(r?.type, zoom) && staticRouteInBounds(coords, bounds);
  });
  const prioritizedVisible = [...visibleCandidates].sort((a, b) => {
    const keyA = normalizeRailLineKey(a?.type, a?.name);
    const keyB = normalizeRailLineKey(b?.type, b?.name);
    const totalA = Number(lineLengthTotals.get(keyA) || 0);
    const totalB = Number(lineLengthTotals.get(keyB) || 0);
    const priA = staticRailPriorityScore(a, totalA);
    const priB = staticRailPriorityScore(b, totalB);
    if (priA !== priB) return priB - priA;
    if (totalA !== totalB) return totalB - totalA;
    return routeLengthKm(b?.coords || []) - routeLengthKm(a?.coords || []);
  });
  const visibleRoutes = prioritizedVisible
    .filter((r) => {
      const key = normalizeRailLineKey(r?.type, r?.name);
      const totalKm = Number(lineLengthTotals.get(key) || routeLengthKm(r?.coords || []));
      // Keep a trunk-network view at lower zoom, similar to TfL-style line clarity.
      if (zoom <= 7) return isMajorStaticRailRoute(r, totalKm, zoom);
      if (zoom <= 9) return staticRailPriorityScore(r, totalKm) >= 8 || isMajorStaticRailRoute(r, totalKm, zoom);
      return true;
    })
    .slice(0, railDisplayRouteLimitForZoom(zoom));

  const useSpineMode = zoom <= 10;
  const displayRoutes = useSpineMode ? buildRailSpineDisplayRoutes(visibleRoutes, zoom) : visibleRoutes;

  for (const r of displayRoutes) {
    const rawCoords = Array.isArray(r?.coords) ? r.coords : [];
    const coords = simplifyRailRouteForDisplay(rawCoords, zoom);
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lineKey = normalizeRailLineKey(r?.type, r?.name);
    const totalKm = Number(lineLengthTotals.get(lineKey) || routeLengthKm(rawCoords));
    const priority = staticRailPriorityScore(r, totalKm);
    const priorityBoost = Math.max(0, Math.min(1.8, (priority - 8) * 0.07));
    const baseWeight = (zoom <= 8 ? 3.0 : 3.8) + priorityBoost;
    const line = L.polyline(coords, {
      color: osRailColorForFeature({ railway: r.type, name: r.name }),
      weight: baseWeight,
      opacity: 0.93,
      smoothFactor: 1.8,
      className: "os-rail-static-line os-rail-line-interactive"
    }).addTo(OS_DERIVED_STATE.railLayer);
    line.bindPopup(buildOsRailLinePopupHtml(r, lineKey, totalKm));
    line.on("click", () => {
      if (lineKey) OS_DERIVED_STATE.railSelectedLineKey = lineKey;
      applyOsRailSelectionStyles();
    });
    const tipName = r.displayName || r.name;
    if (tipName && zoom >= 9) {
      line.bindTooltip(`${escapeHtml(tipName)}${r.type ? ` (${escapeHtml(r.type)})` : ""}`, { sticky: true, opacity: 0.9 });
    }
    OS_DERIVED_STATE.railRenderedSegments.push({ layer: line, lineKey, totalKm, baseWeight });
  }

  if (!useSpineMode) {
    // Larger join radius prevents obvious breaks where adjacent segments are not perfectly snapped.
    const connectorSource = visibleRoutes.length > 520 ? visibleRoutes.slice(0, 520) : visibleRoutes;
    const railGapConnectors = buildRailGapConnectors(connectorSource, zoom <= 8 ? 0.55 : 0.35);
    for (const c of railGapConnectors) {
      const lineKey = normalizeRailLineKey(c?.type, c?.name);
      const totalKm = Number(lineLengthTotals.get(lineKey) || routeLengthKm(c?.coords || []));
      const priority = staticRailPriorityScore(c, totalKm);
      const priorityBoost = Math.max(0, Math.min(1.2, (priority - 8) * 0.05));
      const baseWeight = (zoom <= 8 ? 2.5 : 2.9) + priorityBoost;
      const connector = L.polyline(c.coords, {
        color: osRailColorForFeature({ railway: c.type, name: c.name }),
        weight: baseWeight,
        opacity: 0.9,
        smoothFactor: 1.6,
        className: "os-rail-static-line os-rail-line-interactive"
      }).addTo(OS_DERIVED_STATE.railLayer);
      connector.bindPopup(buildOsRailLinePopupHtml(c, lineKey, totalKm));
      connector.on("click", () => {
        if (lineKey) OS_DERIVED_STATE.railSelectedLineKey = lineKey;
        applyOsRailSelectionStyles();
      });
      OS_DERIVED_STATE.railRenderedSegments.push({ layer: connector, lineKey, totalKm, baseWeight });
    }
  }
  applyOsRailSelectionStyles();

  if (zoom < 7) return;
  for (const s of stations) {
    const lat = Number(s?.lat);
    const lon = Number(s?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!bounds.contains([lat, lon])) continue;
    const marker = L.circleMarker([lat, lon], {
      radius: zoom >= 10 ? 3 : 2.4,
      color: "#e0f2fe",
      fillColor: "#38bdf8",
      fillOpacity: 0.88,
      weight: 1.2,
      className: "os-rail-static-node"
    }).addTo(OS_DERIVED_STATE.railLayer);
    if (s.name && zoom >= 10) marker.bindTooltip(escapeHtml(s.name), { sticky: true, opacity: 0.82 });
  }

  // No synthetic nearest-station links in static rail mode:
  // they can create patchy diagonals and inconsistent line coloring.
}

async function loadOsRoadOverlay() {
  if (OS_DERIVED_STATE.roadsLoaded || OS_DERIVED_STATE.roadsFailed) return;
  if (map.getZoom() < 6) {
    setStatus("Zoom in to level 6+ to load OS roads overlay.");
    return;
  }
  try {
    const staticPicked = await fetchJsonFromCandidates(["data/transport_static/roads_core.json"]);
    const staticRoadPayload = (staticPicked && typeof staticPicked.data === "object" && staticPicked.data)
      ? staticPicked.data
      : staticPicked;
    if (staticRoadPayload && Array.isArray(staticRoadPayload.routes) && staticRoadPayload.routes.length) {
      OS_DERIVED_STATE.roadsData = staticRoadPayload;
      OS_DERIVED_STATE.roadsMergedRoutes = mergeStaticRoadRoutes(staticRoadPayload.routes || []);
      OS_DERIVED_STATE.roadsLayer = L.featureGroup().addTo(layers.os_roads);
      OS_DERIVED_STATE.roadsLoaded = true;
      OS_DERIVED_STATE.roadsStatic = true;
      OS_DERIVED_STATE.roadsStaticRenderSig = "";
      renderStaticRoadOverlay();
      markLayerAsStaticMode("os_roads");
      setStatus("OS roads overlay loaded (static core).");
      return;
    }
    throw new Error("Missing data/transport_static/roads_core.json routes payload");
  } catch (err) {
    OS_DERIVED_STATE.roadsFailed = true;
    console.warn("OS major roads overlay unavailable:", err);
    markOsDerivedLayerUnavailable("os_roads", "Static roads core data is not available.");
    notifyOsDerivedUnavailableOnce("OS-derived overlays unavailable in this build.");
  }
}

async function loadOsRailOverlay() {
  if (OS_DERIVED_STATE.railLoaded || OS_DERIVED_STATE.railFailed) return;
  if (map.getZoom() < 6) {
    setStatus("Zoom in to level 6+ to load UK rail network overlay.");
    return;
  }
  try {
    // Always prefer compact static core to avoid browser crashes on huge rail GeoJSON.
    const staticRail = await fetchJsonFromCandidates(["data/transport_static/rail_core.json"]);
    const staticRailPayload = (staticRail && typeof staticRail.data === "object" && staticRail.data)
      ? staticRail.data
      : staticRail;
    if (staticRailPayload && Array.isArray(staticRailPayload.routes) && staticRailPayload.routes.length) {
      const staticStations = await fetchJsonFromCandidates(["data/transport_static/rail_stations_core.json"]);
      const staticStationPayload = (staticStations && typeof staticStations.data === "object" && staticStations.data)
        ? staticStations.data
        : staticStations;
      OS_DERIVED_STATE.railData = staticRailPayload;
      OS_DERIVED_STATE.railMergedRoutes = mergeStaticRailRoutes(staticRailPayload.routes || []);
      OS_DERIVED_STATE.railStationData = (staticStationPayload && Array.isArray(staticStationPayload.stations))
        ? staticStationPayload
        : { stations: [] };
      OS_DERIVED_STATE.railLayer = L.featureGroup().addTo(layers.os_rail);
      OS_DERIVED_STATE.railLoaded = true;
      OS_DERIVED_STATE.railStatic = true;
      OS_DERIVED_STATE.railStaticRenderSig = "";
      renderStaticRailOverlay();
      markLayerAsStaticMode("os_rail");
      setStatus("UK rail network loaded (static core).");
      return;
    }
    throw new Error("Missing data/transport_static/rail_core.json routes payload");
  } catch (err) {
    OS_DERIVED_STATE.railFailed = true;
    console.warn("UK rail network overlay unavailable:", err);
    markOsDerivedLayerUnavailable("os_rail", "Static UK rail network data is not available.");
    setStatus("UK rail network data unavailable");
  }
}

// TfL (Transport for London) ALL stations - Underground, DLR, Overground, Tram, Rail

// Map line names to roundel logo files
function getTfLRoundelIcon(lines) {
  const lineToLogo = {
    "Bakerloo": "data/TFL/logos/Bakerloo_line_roundel.svg.png",
    "Central": "data/TFL/logos/Central_Line_roundel.svg.png",
    "Circle": "data/TFL/logos/Circle_Line_roundel.svg.png",
    "District": "data/TFL/logos/District_line_roundel.svg.png",
    "Hammersmith & City": "data/TFL/logos/H&c_line_roundel.svg.png",
    "Jubilee": "data/TFL/logos/Jubilee_line_roundel.svg.png",
    "Metropolitan": "data/TFL/logos/Metropolitan_line_roundel.svg.png",
    "Piccadilly": "data/TFL/logos/Piccadilly_line_roundel.svg.png",
    "Victoria": "data/TFL/logos/Victoria_line_roundel.svg.png",
    "Waterloo & City": "data/TFL/logos/W&c_line_roundel.svg.png",
    "Northern": "data/TFL/logos/Underground.svg.png",
    "DLR": "data/TFL/logos/Underground.svg.png",
    "Elizabeth": "data/TFL/logos/Underground.svg.png"
  };
  
  // Pick the first line that has a specific logo, otherwise use generic Underground
  let logoPath = "data/TFL/logos/Underground.svg.png";
  
  if (lines && lines.length > 0) {
    for (const line of lines) {
      if (lineToLogo[line]) {
        logoPath = lineToLogo[line];
        break;
      }
    }
  }
  
  return L.icon({
    iconUrl: logoPath,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10],
    className: 'tfl-roundel-icon'
  });
}

// Load station line information first
let stationLinesData = {};

// Map polyline colors from london-lines.json to line metadata
const TFL_COLOR_TO_META = {
  "#9364cc": { id: "elizabeth-line", name: "Elizabeth", color: "#753bbd" },
  "#3c8cff": { id: "victoria", name: "Victoria", color: "#00a3e0" },
  "#149600": { id: "district", name: "District", color: "#007a33" },
  "#64500a": { id: "bakerloo", name: "Bakerloo", color: "#a45a2a" },
  "#8c505a": { id: "metropolitan", name: "Metropolitan", color: "#840b55" },
  "#ff64a0": { id: "hammersmith-city", name: "Hammersmith & City", color: "#e89cae" },
  "#ffff00": { id: "circle", name: "Circle", color: "#ffcd00" },
  "#ff0000": { id: "central", name: "Central", color: "#da291c" },
  "#0000c8": { id: "piccadilly", name: "Piccadilly", color: "#10069f" },
  "#808080": { id: "jubilee", name: "Jubilee", color: "#7c878e" },
  "#000000": { id: "northern", name: "Northern", color: "#000000" },
  "#00ffa0": { id: "waterloo-city", name: "Waterloo & City", color: "#6eceb2" },
  "#ffbe28": { id: "overground", name: "Overground", color: "#e87722" }
};

const TFL_STATUS_TONE = {
  good: "#22c55e",
  warning: "#f59e0b",
  bad: "#ef4444",
  neutral: "#94a3b8"
};

window._tflRouteRegistry = {};
window._selectedTflLineId = null;
window._lastTflStatuses = [];

window.updateSelectedTflLineInfo = function updateSelectedTflLineInfo() {
  const el = document.getElementById("tfl-selected-line");
  if (!el) return;
  const selectedId = window._selectedTflLineId;
  if (!selectedId) {
    el.textContent = "Selected: None";
    return;
  }

  const meta = window._tflRouteRegistry[selectedId];
  const status = (window._lastTflStatuses || []).find(
    (line) => String(line.id || "").toLowerCase() === selectedId
  );
  const label = status?.lineStatuses?.[0]?.statusSeverityDescription || "Status unknown";
  const name = meta?.name || selectedId;
  el.textContent = `Selected: ${name} (${label})`;
};

function getStatusToneFromSeverity(severity) {
  if (severity === 10) return "good";
  if (severity === 9) return "warning";
  if (severity <= 8) return "bad";
  return "neutral";
}

function applyTflLineVisual(lineMeta, statusSeverity) {
  const tone = getStatusToneFromSeverity(statusSeverity);
  const selected = window._selectedTflLineId && window._selectedTflLineId === lineMeta.id;
  const dimmed = window._selectedTflLineId && !selected;
  const glow = TFL_STATUS_TONE[tone] || TFL_STATUS_TONE.neutral;

  for (const seg of lineMeta.segments) {
    seg.setStyle({
      color: lineMeta.color,
      weight: selected ? 7 : 4,
      opacity: dimmed ? 0.16 : 0.82
    });

    if (seg._path) {
      seg._path.classList.remove("tfl-status-good", "tfl-status-warning", "tfl-status-bad", "tfl-line-selected", "tfl-line-dimmed");
      seg._path.classList.add(`tfl-status-${tone}`);
      if (selected) seg._path.classList.add("tfl-line-selected");
      if (dimmed) seg._path.classList.add("tfl-line-dimmed");
      seg._path.style.setProperty("--tfl-glow", glow);
    }
  }
}

window.updateTflLineStylesFromStatus = function updateTflLineStylesFromStatus(lines) {
  window._lastTflStatuses = Array.isArray(lines) ? lines : [];
  const statusById = {};
  for (const line of window._lastTflStatuses) {
    statusById[(line.id || "").toLowerCase()] = line.lineStatuses?.[0]?.statusSeverity ?? 10;
  }
  for (const meta of Object.values(window._tflRouteRegistry)) {
    const severity = statusById[meta.id] ?? 10;
    applyTflLineVisual(meta, severity);
  }
  window.updateSelectedTflLineInfo();
};

window.selectTflLine = function selectTflLine(lineId) {
  if (!lineId) return;
  const normalized = String(lineId).toLowerCase();
  window._selectedTflLineId = window._selectedTflLineId === normalized ? null : normalized;
  window.updateTflLineStylesFromStatus(window._lastTflStatuses);
  window.updateSelectedTflLineInfo();
  document.dispatchEvent(new CustomEvent("tfl-line-selection-changed", { detail: { lineId: window._selectedTflLineId } }));
};

window.focusTflLine = function focusTflLine(lineId) {
  const normalized = String(lineId || "").toLowerCase();
  const meta = window._tflRouteRegistry[normalized];
  if (!meta || !meta.segments || !meta.segments.length) return;
  const group = L.featureGroup(meta.segments);
  map.fitBounds(group.getBounds(), { padding: [80, 80], maxZoom: 12 });
};

async function ensureUndergroundLoaded() {
  if (OVERLAY_LOAD_STATE.undergroundLoaded) return true;
  if (OVERLAY_LOAD_STATE.undergroundLoading) return OVERLAY_LOAD_STATE.undergroundLoading;
  OVERLAY_LOAD_STATE.undergroundLoading = Promise.all([
    fetch("data/underground_map/underground-live-map-master/bin/lines_for_stations.json").then((r) => r.json()),
    fetch("data/underground_map/underground-live-map-master/bin/stations.json").then((r) => r.json()),
    fetch("data/underground_map/underground-live-map-master/bin/london-lines.json").then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
  ]).then(([lineInfo, stationData, lineRouteData]) => {
    stationLinesData = lineInfo || {};

    const seen = new Set();
    for (const [fullName, coords] of Object.entries(stationData || {})) {
      const parts = String(coords || "").split(",").map(Number);
      const lon = parts[0], lat = parts[1];
      if (isNaN(lat) || isNaN(lon)) continue;

      const key = lat.toFixed(4) + "," + lon.toFixed(4);
      if (seen.has(key)) continue;
      seen.add(key);

      const stationName = fullName
        .replace(/ Station$/i, "").replace(/ Rail Station$/i, "")
        .replace(/ DLR Station$/i, "").replace(/ Tram Stop$/i, "");

      const lines = stationLinesData[stationName] || [];
      let networkType = lines.length > 0 ? lines.join(", ") : "Underground";
      if (fullName.includes("DLR")) networkType = "DLR";
      else if (fullName.includes("Tram")) networkType = "Tram";

      const stationMarker = L.marker([lat, lon], {
        icon: getTfLRoundelIcon(lines),
        pane: "tflStationsPane"
      }).addTo(layers.underground);

      stationMarker.bindPopup(
        `<strong>${stationName}</strong><br>` +
        `<span class="popup-label">Lines</span> ${networkType}` +
        '<div class="tfl-arrivals"><div class="tfl-arrivals-loading">Loading arrivals...</div></div>'
      );

      stationMarker.on("popupopen", async () => {
        if (typeof window.buildTflStationPopup !== "function") return;
        try {
          const popupData = await window.buildTflStationPopup(stationName, networkType);
          stationMarker.setPopupContent(popupData.loadingHtml);
          const fullHtml = await popupData.fetchFull();
          stationMarker.setPopupContent(fullHtml);
        } catch (_) {
          stationMarker.setPopupContent(
            `<strong>${stationName}</strong><br>` +
            `<span class="popup-label">Lines</span> ${networkType}` +
            '<div class="tfl-arrivals"><div class="tfl-arrivals-empty">Arrivals unavailable</div></div>'
          );
        }
      });
    }

    if (!lineRouteData.polylines || !Array.isArray(lineRouteData.polylines)) {
      throw new Error("Invalid data structure - no polylines array");
    }

    let addedCount = 0;
    for (const segment of lineRouteData.polylines) {
      if (!Array.isArray(segment) || segment.length < 3) continue;

      const sourceColor = String(segment[0] || "").toLowerCase();
      const meta = TFL_COLOR_TO_META[sourceColor];
      const coords = segment.slice(2);
      if (!coords.length || !meta) continue;

      if (!window._tflRouteRegistry[meta.id]) {
        window._tflRouteRegistry[meta.id] = {
          id: meta.id,
          name: meta.name,
          color: meta.color,
          segments: []
        };
      }

      const routeSegment = L.polyline(coords, {
        color: meta.color,
        weight: 4,
        opacity: 0.82,
        smoothFactor: 1,
        className: "tfl-line",
        pane: "tflRoutesPane"
      }).addTo(layers.underground);

      routeSegment.on("click", (ev) => {
        L.DomEvent.stop(ev);
        window.selectTflLine(meta.id);
      });
      routeSegment.bindTooltip(meta.name, { sticky: true, opacity: 0.9, direction: "top" });

      window._tflRouteRegistry[meta.id].segments.push(routeSegment);
      addedCount += 1;
    }

    window.updateTflLineStylesFromStatus(window._lastTflStatuses);
    OVERLAY_LOAD_STATE.undergroundLoaded = true;
    console.log(`TfL underground loaded: ${addedCount} route segments`);
    return true;
  }).catch((e) => {
    console.warn("TfL underground data unavailable:", e?.message || e);
    setStatus("TfL underground dataset unavailable");
    return false;
  }).finally(() => {
    OVERLAY_LOAD_STATE.undergroundLoading = null;
  });
  return OVERLAY_LOAD_STATE.undergroundLoading;
}

// UI
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function getCriteriaFromUI() {
  return {
    name:     document.getElementById("ch_name")?.value     || "",
    number:   document.getElementById("ch_number")?.value   || "",
    postcode: document.getElementById("ch_postcode")?.value || "",
    town:     document.getElementById("ch_town")?.value     || "",
    status:   document.getElementById("ch_status")?.value   || "",
    sic:      document.getElementById("ch_sic")?.value      || ""
  };
}
function pickSeed(c) { return c.number || c.postcode || c.name || c.town || ""; }
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

// â”€â”€ Company Results list â”€â”€
const MAX_VISIBLE = 50;
function renderResults(container, rows, isPartial) {
  container.innerHTML = "";
  if (!rows.length) { container.innerHTML = '<div class="ch-result-count">No matches found</div>'; return; }
  const el = document.createElement("div"); el.className = "ch-result-count";
  const sfx = isPartial ? " (searching...)" : "";
  el.textContent = rows.length > MAX_VISIBLE
    ? `${MAX_VISIBLE} of ${rows.length} matches${sfx}` : `${rows.length} match${rows.length===1?"":"es"}${sfx}`;
  container.appendChild(el);
  for (const r of rows.slice(0, MAX_VISIBLE)) {
    const item = document.createElement("div"); item.className = "ch-result-item";
    item.innerHTML =
      `<div class="ch-r-name">${escapeHtml(r.CompanyName||"Unknown")}</div>` +
      `<div class="ch-r-detail">#${escapeHtml(r.CompanyNumber)} &middot; ${escapeHtml(r["RegAddress.PostTown"])} &middot; ${escapeHtml(r["RegAddress.PostCode"])}</div>`;
    item.addEventListener("click", () => plotCompanies([r]));
    container.appendChild(item);
  }
}

// â”€â”€ PSC Results list â”€â”€


// Look up companies by number and plot them
async function lookupAndPlotCompanies(companyNumbers) {
  setStatus(`Looking up ${companyNumbers.length} compan${companyNumbers.length === 1 ? "y" : "ies"}...`);
  showProgress();

  const results = [];
  const uniqueNums = [...new Set(companyNumbers)];

  // For each company number, find the right subset file and search
  for (let i = 0; i < uniqueNums.length; i++) {
    const num = uniqueNums[i];
    const numClean = num.replace(/\D/g, "");
    if (!numClean) continue;
    const numInt = parseInt(numClean, 10);
    const entry = CH_INDEX.find(e => numInt >= e.start && numInt <= e.end);
    if (!entry) continue;

    try {
      await loadSubset(entry.file);
      const hits = filterByCriteria(CH_CACHE[entry.file] || [], { number: num }, 1);
      if (hits.length) results.push(hits[0]);
    } catch (e) {
      console.warn("Failed to load for company", num, e);
    }

    if (i % 5 === 0) {
      setProgress(i + 1, uniqueNums.length, results.length);
    }
  }

  hideProgress();

  if (results.length) {
    await plotCompanies(results);
    setStatus(`Plotted ${results.length} of ${uniqueNums.length} companies`);
  } else {
    setStatus("Could not find company data");
  }
}

// â”€â”€ Live search â”€â”€
let _seq = 0;
function liveSearch(container) {
  const c = getCriteriaFromUI(), seed = pickSeed(c).trim();
  if (!seed || seed.length < 3) { container.innerHTML = ""; return; }
  if (!Object.keys(CH_CACHE).length) {
    container.innerHTML = '<div class="ch-result-count">Press Enter to search</div>'; return;
  }
  const seq = ++_seq;
  const matches = searchCached(c, 200);
  if (seq !== _seq) return;
  CH_LAST_RESULTS = matches;
  renderResults(container, matches, Object.keys(CH_CACHE).length < CH_INDEX.length);
}

// â”€â”€ Plot companies â”€â”€
async function plotCompanies(rows, clearFirst = false) {
  if (clearFirst) layers.companies.clearLayers();
  if (!rows.length) { setStatus("No companies to plot"); return; }
  setStatus(`Plotting ${rows.length} compan${rows.length===1?"y":"ies"}...`);
  let plotted = 0;
  let skipped = 0;
  const failedPostcodes = new Set();
  for (const r of rows) {
    try {
      const raw = r["RegAddress.PostCode"];
      if (!raw) { skipped++; continue; }
      const co = await geocodePostcode(raw);
      if (!co || !Number.isFinite(co.lat) || !Number.isFinite(co.lon)) {
        skipped++;
        failedPostcodes.add(String(raw).trim().toUpperCase());
        continue;
      }

      const coNum = escapeHtml(r.CompanyNumber);
      const companyName = escapeHtml(r.CompanyName);
      const popup =
        `<strong>${companyName}</strong>` +
        `<span class="popup-label">Company #</span> ${coNum}<br>` +
        (r["RegAddress.AddressLine1"] ? escapeHtml(r["RegAddress.AddressLine1"]) + "<br>" : "") +
        (r["RegAddress.PostTown"] ? escapeHtml(r["RegAddress.PostTown"]) + " " : "") + escapeHtml(raw) +
        (r.CompanyStatus ? `<br><span class="popup-label">Status</span> <span class="popup-tag">${escapeHtml(r.CompanyStatus)}</span>` : "") +
        (r["SICCode.SicText_1"] ? `<br><span class="popup-label">SIC</span> ${escapeHtml(r["SICCode.SicText_1"])}` : "") +
        `<div class="popup-btn-row">` +
        `<button class="popup-psc-btn" onclick="viewCompanyPsc('${coNum}', '${companyName.replace(/'/g, "\\'")}')">View PSC</button>` +
        `<button class="popup-psc-btn" onclick="connectCompanyEntity('${coNum}')">Connect</button>` +
        `<button class="popup-psc-btn" onclick="downloadCompanyProfile('${coNum}', '${companyName.replace(/'/g, "\\'")}')">Profile PDF</button>` +
        `<button class="popup-psc-btn" onclick="downloadFilingHistory('${coNum}', '${companyName.replace(/'/g, "\\'")}')">Filings PDF</button>` +
        `</div>`;

      const marker = createOrganisationMarker([co.lat, co.lon]);
      marker.bindPopup(popup).addTo(layers.companies);
      registerCompanyMarkerAsEntity(marker, {
        number: r.CompanyNumber,
        name: r.CompanyName,
        status: r.CompanyStatus || "",
        address: [r["RegAddress.AddressLine1"], r["RegAddress.PostTown"], raw].filter(Boolean).join(", "),
        postcode: raw,
        latLng: [co.lat, co.lon]
      });

      plotted++;
    } catch (err) {
      skipped++;
      console.warn("Skipping company row due to plot error:", r?.CompanyNumber || r, err);
    }
  }
  if (plotted) {
    if (!map.hasLayer(layers.companies)) {
      layers.companies.addTo(map);
      const cb = document.querySelector('[data-layer="companies"]');
      if (cb) cb.checked = true;
    }
    map.fitBounds(layers.companies.getBounds(), { padding: [40, 40] });
    const suffix = skipped ? ` (${skipped} skipped)` : "";
    setStatus(`${plotted} compan${plotted===1?"y":"ies"} plotted${suffix}`);
    if (failedPostcodes.size) {
      console.warn("Company geocode failed postcodes (sample):", Array.from(failedPostcodes).slice(0, 20));
    }
  } else {
    setStatus(`No geocodable postcodes in ${rows.length} results`);
    if (failedPostcodes.size) {
      console.warn("No companies plotted, failed postcodes (sample):", Array.from(failedPostcodes).slice(0, 40));
    }
  }
}

// View PSC for a company (called from popup button)
// NOW USES API - defined in psc_api.js
// This is just a fallback/compatibility wrapper
async function viewCompanyPsc(companyNumber, companyName = '') {
  // Call the API version from psc_api.js
  if (typeof viewCompanyPSC === 'function') {
    return viewCompanyPSC(companyNumber, companyName);
  }
  
  // Fallback if psc_api.js not loaded
  console.error('PSC API module not loaded');
  alert('PSC feature not available. Please refresh the page.');
}

// Add individual company to map with connection line
async function addCompanyToMap(companyNumber, companyName, personName = '', personLatLng = null, appointmentInfo = null) {
  if (!companyNumber) return;
  
  setStatus(`Adding ${companyName} to map...`);
  
  try {
    // Get company profile to get address/postcode
    const profile = await getCompanyProfile(companyNumber);
    
    if (!profile || !profile.registered_office_address) {
      alert('Could not get company address');
      setStatus('Failed to add company');
      return;
    }
    
    const addr = profile.registered_office_address;
    const postcode = addr.postal_code;
    
    if (!postcode) {
      alert('Company has no postcode');
      setStatus('Failed to add company');
      return;
    }
    
    // Lookup coordinates (local first, then postcodes.io fallback)
    const coords = await geocodePostcode(postcode);
    if (!coords) {
      alert(`Could not geocode postcode: ${postcode}`);
      setStatus('Failed to add company');
      return;
    }
    
    // Create marker
    const popup = `
      <strong>${escapeHtml(companyName)}</strong>
      <span class="popup-label">Company #</span> ${escapeHtml(companyNumber)}<br>
      ${addr.address_line_1 ? escapeHtml(addr.address_line_1) + '<br>' : ''}
      ${addr.locality ? escapeHtml(addr.locality) + ' ' : ''}${escapeHtml(postcode)}
      ${profile.company_status ? `<br><span class="popup-label">Status</span> <span class="popup-tag">${escapeHtml(profile.company_status)}</span>` : ''}
      ${personName ? `<br><span class="popup-label">Connected to</span> ${escapeHtml(personName)}` : ''}
      <div class="popup-btn-row">
        <button class="popup-psc-btn" onclick="viewCompanyPsc('${escapeHtml(companyNumber)}', '${escapeHtml(companyName).replace(/'/g, "\\'")}')">View PSC</button>
        <button class="popup-psc-btn" onclick="connectCompanyEntity('${escapeHtml(companyNumber)}')">Connect</button>
        <button class="popup-psc-btn" onclick="downloadCompanyProfile('${escapeHtml(companyNumber)}', '${escapeHtml(companyName).replace(/'/g, "\\'")}')">Profile PDF</button>
        <button class="popup-psc-btn" onclick="downloadFilingHistory('${escapeHtml(companyNumber)}', '${escapeHtml(companyName).replace(/'/g, "\\'")}')">Filings PDF</button>
      </div>
    `;
    
    const companyLatLng = [coords.lat, coords.lon];
    
    const marker = createOrganisationMarker(companyLatLng);
    marker.bindPopup(popup).addTo(layers.companies);
    registerCompanyMarkerAsEntity(marker, {
      number: companyNumber,
      name: companyName,
      status: profile.company_status || "",
      address: [addr.address_line_1, addr.address_line_2, addr.locality, postcode].filter(Boolean).join(", "),
      postcode,
      latLng: companyLatLng
    });
    
    // Store company data on marker
    marker._companyData = { number: companyNumber, name: companyName, latLng: companyLatLng };
    
    // Ensure layer is visible
    if (!map.hasLayer(layers.companies)) {
      layers.companies.addTo(map);
      const cb = document.querySelector('[data-layer="companies"]');
      if (cb) cb.checked = true;
    }
    
    // Draw connection line if person provided
    if (personLatLng && appointmentInfo) {
      const role = appointmentInfo.officer_role || 'officer';
      const appointedOn = appointmentInfo.appointed_on || '';
      const normalizedRole = normalizeConnectionLabel(role);
      const label = appointedOn ? `${normalizedRole} since ${appointedOn}` : normalizedRole;
      addConnection(personLatLng, companyLatLng, label, 'officer');
    }
    
    // Pan to marker
    map.panTo(companyLatLng);
    marker.openPopup();
    
    setStatus(`Added: ${companyName}`);
    
    return { marker, latLng: companyLatLng };
  } catch (error) {
    console.error('Error adding company to map:', error);
    alert('Failed to add company to map');
    setStatus('Error');
    return null;
  }
}

// Add person/officer to map
async function addPersonToMap(officerName, address, companies = [], options = {}) {
  if (!address || !address.postal_code) {
    alert('Officer has no valid address with postcode');
    return;
  }
  
  setStatus(`Adding ${officerName} to map...`);
  
  try {
    const postcode = address.postal_code;
    const coords = await geocodePostcode(postcode);
    if (!coords) {
      alert(`Could not geocode postcode: ${postcode}`);
      setStatus('Failed to add person');
      return;
    }
    
    // Create address string
    const addrParts = [];
    if (address.address_line_1) addrParts.push(address.address_line_1);
    if (address.address_line_2) addrParts.push(address.address_line_2);
    if (address.locality) addrParts.push(address.locality);
    if (address.postal_code) addrParts.push(address.postal_code);
    const addrString = addrParts.join(', ');
    const resolvedCompanyName = String(options?.companyName || companies?.[0] || "").trim();
    
    let personLatLng = [coords.lat, coords.lon];
    const linkedCompanyEntity = options.companyNumber ? getCompanyEntityByNumber(options.companyNumber) : null;
    if (linkedCompanyEntity?.latLng) {
      const fanIndex = getNextPscFanIndex(linkedCompanyEntity.id);
      personLatLng = offsetLatLngFromAnchor(linkedCompanyEntity.latLng, fanIndex);
    } else if (options.anchorLatLng) {
      personLatLng = offsetLatLngFromAnchor(options.anchorLatLng, 0);
    }

    const personPayload = {
      name: officerName,
      address: addrString,
      postcode,
      latLng: personLatLng,
      notes: companies.length ? `${companies.length} related compan${companies.length === 1 ? "y" : "ies"}` : "",
      dob: options?.pscData?.date_of_birth || options?.dob || "",
      nationality: options?.pscData?.nationality || options?.nationality || "",
      countryOfResidence: options?.pscData?.country_of_residence || options?.countryOfResidence || "",
      relationship: options?.relationship || options?.officerRole || "",
      officerId: options?.officerId || "",
      companyName: resolvedCompanyName,
      companyNumber: options?.companyNumber || ""
    };
    const existingOfficerId = findExistingOfficerEntityId(personPayload);
    if (existingOfficerId) {
      const existingEntity = getEntityById(existingOfficerId);
      if (existingEntity) {
        mergeOfficerEntityData(existingEntity, personPayload);
        upsertOfficerEntityIndexes(existingOfficerId, {
          name: existingEntity.label || personPayload.name,
          postcode: personPayload.postcode,
          officerId: existingEntity.officerId || personPayload.officerId,
          dob: existingEntity.dob || personPayload.dob
        });
        existingEntity.marker.setPopupContent(buildEntityPopup(existingOfficerId, existingEntity));
        bindEntityHoverTooltip(existingEntity.marker, existingEntity);
        if (linkedCompanyEntity && personPayload.relationship && !hasPscAutoConnection(existingOfficerId, linkedCompanyEntity.id)) {
          addConnection(
            existingEntity.latLng,
            linkedCompanyEntity.latLng,
            personPayload.relationship,
            "officer",
            {
              fromId: existingOfficerId,
              toId: linkedCompanyEntity.id,
              fromLabel: existingEntity.label,
              toLabel: linkedCompanyEntity.label,
              source: "psc_auto",
              hoverDetail: String(options?.relationshipDetail || "").trim()
            }
          );
        }
        map.panTo(existingEntity.latLng);
        existingEntity.marker.openPopup();
        setStatus(`Matched existing person: ${existingEntity.label}`);
        return { marker: existingEntity.marker, latLng: existingEntity.latLng, entityId: existingOfficerId, reused: true };
      }
    }

    const officerIconData = getOfficerEntityIconData();
    const marker = L.marker(personLatLng, {
      icon: L.icon({
        iconUrl: officerIconData.icon,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        popupAnchor: [0, -14]
      }),
      draggable: true
    });
    marker.addTo(entitiesMarkerCluster);
    const personEntityId = registerOfficerMarkerAsEntity(marker, personPayload);
    const popup = personEntityId
      ? buildEntityPopup(personEntityId, getEntityById(personEntityId))
      : (
        `<strong>${escapeHtml(officerName)}</strong>` +
        `<span class="popup-label">Type</span> <span class="popup-tag" style="background:rgba(167,139,250,0.15); color:#c4b5fd; border:1px solid rgba(167,139,250,0.3);">Person/Officer</span><br>` +
        `<span class="popup-label">Address</span> ${escapeHtml(addrString)}`
      );
    marker.bindPopup(popup);
    
    // Add click handler to highlight connections
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      const entityId = marker._entityId;
      if (connectionDrawingMode && entityId && connectionDrawingMode.fromId !== entityId) {
        completeConnection(entityId);
        return;
      }
      highlightConnections(marker.getLatLng());
    });
    marker.on("dragend", () => {
      const entityId = marker._entityId;
      const entity = entityId ? getEntityById(entityId) : null;
      if (entity) {
        const next = marker.getLatLng();
        entity.latLng = [Number(next.lat), Number(next.lng)];
        marker.setPopupContent(buildEntityPopup(entityId, entity));
        refreshConnectionsForEntity(entityId);
      }
    });
    
    // Store person data on marker
    marker._personData = { name: officerName, companies: companies, latLng: personLatLng };
    
    const relationshipLabel = String(options.relationship || "").trim();
    if (personEntityId && linkedCompanyEntity && relationshipLabel && !hasPscAutoConnection(personEntityId, linkedCompanyEntity.id)) {
      addConnection(
        personLatLng,
        linkedCompanyEntity.latLng,
        relationshipLabel,
        "officer",
        {
          fromId: personEntityId,
          toId: linkedCompanyEntity.id,
          fromLabel: officerName,
          toLabel: linkedCompanyEntity.label,
          source: "psc_auto",
          hoverDetail: String(options.relationshipDetail || "").trim()
        }
      );
    }
    
    // Pan to marker
    map.panTo(personLatLng);
    marker.openPopup();
    
    setStatus(`Added person: ${officerName}`);
    
    return { marker, latLng: personLatLng };
  } catch (error) {
    console.error('Error adding person to map:', error);
    alert('Failed to add person to map');
    setStatus('Error');
    return null;
  }
}

map.on("moveend zoomend", () => {
  if (map.hasLayer(layers.os_roads) && OS_DERIVED_STATE.roadsLoaded) {
    renderStaticRoadOverlay();
  }
  if (map.hasLayer(layers.os_rail) && OS_DERIVED_STATE.railLoaded) {
    if (OS_DERIVED_STATE.railStatic) renderStaticRailOverlay();
    else scheduleOsRailViewportRender();
  }
});

function extractOfficerIdFromPath(rawPath = "") {
  const path = String(rawPath || "").trim();
  const match = path.match(/\/officers\/([^/]+)\/appointments/i);
  return match ? match[1] : "";
}

async function expandOfficerCompanies(entityId) {
  const entity = getEntityById(entityId);
  if (!entity) return;
  let officerId = String(entity.officerId || "").trim();
  if (!officerId && entity.companyNumber && typeof lookupCompanyOfficerMatch === "function") {
    try {
      const resolved = await lookupCompanyOfficerMatch(entity.companyNumber, entity.label);
      officerId = String(resolved?.officerId || "").trim();
      if (officerId) entity.officerId = officerId;
    } catch (err) {
      console.warn("Officer ID resolve fallback failed:", err);
    }
  }
  if (!officerId) {
    alert("No officer ID is stored for this person, so appointments cannot be expanded.");
    return;
  }
  setStatus(`Loading appointments for ${entity.label}...`);
  try {
    const appointments = typeof getOfficerAppointmentsAPI === "function"
      ? await getOfficerAppointmentsAPI(officerId)
      : [];
    if (!Array.isArray(appointments) || appointments.length === 0) {
      setStatus(`No company appointments found for ${entity.label}`);
      return;
    }
    let added = 0;
    for (const appt of appointments) {
      const companyNumber = String(appt?.appointed_to?.company_number || "").trim();
      const companyName = String(appt?.appointed_to?.company_name || "").trim();
      if (!companyNumber || !companyName) continue;
      await addCompanyToMap(
        companyNumber,
        companyName,
        entity.label,
        entity.latLng,
        {
          officer_role: String(appt?.officer_role || entity.officerRole || "Officer"),
          appointed_on: String(appt?.appointed_on || "")
        }
      );
      added += 1;
    }
    setStatus(`Expanded ${added} linked compan${added === 1 ? "y" : "ies"} for ${entity.label}`);
  } catch (err) {
    console.error("Expand officer companies failed:", err);
    setStatus("Failed to expand officer companies");
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// API-BASED SEARCH (REPLACES LOCAL FILE SEARCH)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function searchCompaniesViaAPI(criteria, limit = 100) {
  // Primary search by company name or number
  const nameQuery = criteria.name?.trim() || "";
  const numberQuery = criteria.number?.trim() || "";
  const postcodeFilter = criteria.postcode?.trim().toLowerCase() || "";
  const townFilter = criteria.town?.trim().toLowerCase() || "";
  const statusFilter = criteria.status?.trim().toLowerCase() || "";
  const sicFilter = criteria.sic?.trim() || "";
  
  const query = nameQuery || numberQuery;
  if (!query || query.length < 2) {
    return [];
  }
  
  try {
    const response = await fetchCH(`/search/companies?q=${encodeURIComponent(query)}&items_per_page=${limit}`);
    
    if (!response.ok) {
      console.error("API search failed:", response.status);
      return [];
    }
    
    const data = await response.json();
    let items = data.items || [];
    
    // Transform API results to match local format
    let results = items.map(item => ({
      CompanyName: item.title || item.company_name || "",
      CompanyNumber: item.company_number || "",
      "RegAddress.PostCode": item.address?.postal_code || "",
      "RegAddress.PostTown": item.address?.locality || "",
      "RegAddress.AddressLine1": item.address?.address_line_1 || "",
      CompanyStatus: item.company_status || "",
      "SICCode.SicText_1": item.sic_codes ? item.sic_codes.join(", ") : "",
      _rawSicCodes: item.sic_codes || []
    }));
    
    // Apply local filters (postcode, town) if specified
    if (postcodeFilter) {
      results = results.filter(r => 
        r["RegAddress.PostCode"].toLowerCase().includes(postcodeFilter)
      );
    }
    
    if (townFilter) {
      results = results.filter(r => 
        r["RegAddress.PostTown"].toLowerCase().includes(townFilter)
      );
    }
    
    // Filter by company status
    if (statusFilter) {
      results = results.filter(r => 
        (r.CompanyStatus || "").toLowerCase().includes(statusFilter)
      );
    }
    
    // Filter by SIC code
    if (sicFilter) {
      results = results.filter(r => 
        (r._rawSicCodes || []).some(sic => String(sic).includes(sicFilter))
      );
    }
    
    return results;
  } catch (err) {
    console.error("API search error:", err);
    return [];
  }
}

// â”€â”€ Clear â”€â”€
function clearAll() {
  _searchAbort = true;
  if (confirm('Clear all companies from map?')) {
    removeCompanyEntitiesFromStore();
    window._officerEntityIndex = {};
    window._officerEntityByOfficerId = {};
    window._officerEntityByNameDob = {};
    layers.companies.clearLayers();
  }
  ["ch_name","ch_number","ch_postcode","ch_town","ch_status","ch_sic"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  document.getElementById("ch_results").innerHTML = "";
  hideProgress(); CH_LAST_RESULTS = [];
  setStatus("Ready");
}

function clearPsc() {
  document.getElementById("psc_name").value = "";
  document.getElementById("psc_company").value = "";
  document.getElementById("psc_results").innerHTML = "";
  hidePscProgress();
  setStatus("Ready");
}

// â”€â”€ PSC Search handler (NOW USES API) â”€â”€
async function runPscSearch() {
  const nameVal = document.getElementById("psc_name")?.value?.trim() || "";
  const coVal = document.getElementById("psc_company")?.value?.trim() || "";
  const resultsDiv = document.getElementById("psc_results");

  if (!nameVal && !coVal) return;

  resultsDiv.innerHTML = '<div class="ch-loading">Searching via API...</div>';
  showPscProgress();

  if (coVal) {
    // Search by company number via API
    setPscProgress("Fetching PSC from API...", 50);
    setStatus(`Searching PSC for company #${coVal}...`);
    
    const pscRecords = await getPSCForCompanyAPI(coVal);
    hidePscProgress();
    
    // Get company details for better display
    let companyName = '';
    try {
      const companyProfile = await getCompanyProfile(coVal);
      if (companyProfile) {
        companyName = companyProfile.company_name || '';
      }
    } catch (e) {
      console.log('Could not fetch company name:', e);
    }
    
    displayPSCResults(resultsDiv, pscRecords, coVal, companyName || `Company #${coVal}`);
    setStatus(`${pscRecords.length} PSC record${pscRecords.length === 1 ? "" : "s"} for #${coVal}`);
  } else if (nameVal && nameVal.length >= 3) {
    // Search by officer name via API
    setPscProgress("Searching officers...", 20);
    setStatus(`Searching for "${nameVal}"...`);
    
    const results = await searchCompaniesByOfficerAPI(nameVal, 50);
    hidePscProgress();
    
    // Display officer search results
    resultsDiv.innerHTML = '';
    if (!results || results.length === 0) {
      resultsDiv.innerHTML = '<div class="ch-result-count">No matches found</div>';
      setStatus('No officer matches found');
    } else {
      const header = document.createElement('div');
      header.className = 'ch-result-count';
      header.textContent = `${results.length} officer match${results.length === 1 ? '' : 'es'}`;
      resultsDiv.appendChild(header);
      
      results.slice(0, 30).forEach(officer => {
        const card = document.createElement('div');
        card.className = 'ch-result-item officer-card';
        card.dataset.officerPath = officer.links?.self || '';
        card.dataset.officerId = extractOfficerIdFromPath(officer.links?.self || '');
        card.dataset.officerName = officer.title || officer.name || 'Unknown';
        card.dataset.officerAddress = JSON.stringify(officer.address || {});
        card.dataset.officerDob = JSON.stringify(officer.date_of_birth || null);
        card.dataset.officerNationality = String(officer.nationality || "");
        card.dataset.officerCountryOfResidence = String(officer.country_of_residence || "");
        
        card.innerHTML = `
          <div class="ch-r-name">${escapeHtml(officer.title || officer.name || 'Unknown')} <span class="expand-icon">></span></div>
          <div class="ch-r-detail">
            ${officer.appointment_count ? `${officer.appointment_count} appointment${officer.appointment_count === 1 ? '' : 's'}` : ''}
            ${officer.date_of_birth ? ` - Born ${officer.date_of_birth.month}/${officer.date_of_birth.year}` : ''}
            ${officer.address_snippet ? `<br>${escapeHtml(officer.address_snippet)}` : ''}
          </div>
          ${officer.address?.postal_code ? `<button class="btn-add-company btn-sm btn-add-officer-map" style="margin-top: 6px;">Add Person to Map</button>` : ''}
          <div class="officer-companies" style="display: none;">
            <div class="officer-loading">Loading appointments...</div>
          </div>
        `;

        const addOfficerBtn = card.querySelector(".btn-add-officer-map");
        if (addOfficerBtn) {
          addOfficerBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const officerAddress = card.dataset.officerAddress ? JSON.parse(card.dataset.officerAddress) : null;
            const officerDob = card.dataset.officerDob ? JSON.parse(card.dataset.officerDob) : null;
            if (!officerAddress?.postal_code) return;
            await addPersonToMap(card.dataset.officerName || "Unknown", officerAddress, [], {
              officerId: card.dataset.officerId || "",
              dob: officerDob || "",
              nationality: card.dataset.officerNationality || "",
              countryOfResidence: card.dataset.officerCountryOfResidence || ""
            });
          });
        }
        
        // Click handler to expand/collapse
        card.addEventListener('click', async (e) => {
          if (e.target.closest('.btn-add-company')) return; // Don't trigger if clicking add button
          
          const companiesDiv = card.querySelector('.officer-companies');
          const expandIcon = card.querySelector('.expand-icon');
          const isExpanded = companiesDiv.style.display !== 'none';
          
          if (isExpanded) {
            companiesDiv.style.display = 'none';
            expandIcon.textContent = '>';
          } else {
            companiesDiv.style.display = 'block';
            expandIcon.textContent = 'v';
            
            // Fetch appointments if not already loaded
            if (!companiesDiv.dataset.loaded) {
              const officerId = card.dataset.officerId || extractOfficerIdFromPath(card.dataset.officerPath || "");
              if (!officerId) {
                companiesDiv.innerHTML = '<div class="officer-no-companies">Officer ID missing for appointments lookup</div>';
                return;
              }
              const appointments = await getOfficerAppointmentsAPI(officerId);
              
              companiesDiv.dataset.loaded = 'true';
              
              if (appointments.length === 0) {
                companiesDiv.innerHTML = '<div class="officer-no-companies">No appointments found</div>';
              } else {
                companiesDiv.innerHTML = '';
                appointments.slice(0, 20).forEach(appt => {
                  const companyItem = document.createElement('div');
                  companyItem.className = 'officer-company-item';
                  companyItem.innerHTML = `
                    <div class="officer-company-name">${escapeHtml(appt.appointed_to?.company_name || 'Unknown Company')}</div>
                    <div class="officer-company-detail">
                      #${escapeHtml(appt.appointed_to?.company_number || 'N/A')}
                      ${appt.officer_role ? ` - ${escapeHtml(appt.officer_role)}` : ''}
                      ${appt.appointed_on ? ` - Since ${appt.appointed_on}` : ''}
                    </div>
                    <button class="btn-add-company btn-sm" 
                            data-company-number="${escapeHtml(appt.appointed_to?.company_number || '')}"
                            data-company-name="${escapeHtml(appt.appointed_to?.company_name || '')}"
                            data-officer-name="${card.dataset.officerName}"
                            data-officer-role="${escapeHtml(appt.officer_role || 'officer')}"
                            data-appointed-on="${escapeHtml(appt.appointed_on || '')}">
                      Add to Map
                    </button>
                  `;
                  companiesDiv.appendChild(companyItem);
                });
                
                // Add click handlers for "Add to Map" buttons
                companiesDiv.querySelectorAll('.btn-add-company').forEach(btn => {
                  btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const companyNumber = btn.dataset.companyNumber;
                    const companyName = btn.dataset.companyName;
                    const officerName = btn.dataset.officerName;
                    const officerRole = btn.dataset.officerRole;
                    const appointedOn = btn.dataset.appointedOn;
                    
                    // Try to add person first if they have address
                    const officerAddress = card.dataset.officerAddress ? JSON.parse(card.dataset.officerAddress) : null;
                    const officerDob = card.dataset.officerDob ? JSON.parse(card.dataset.officerDob) : null;
                    let personLatLng = null;
                    
                    if (officerAddress && officerAddress.postal_code) {
                      const personResult = await addPersonToMap(officerName, officerAddress, [companyName], {
                        officerId: card.dataset.officerId || "",
                        dob: officerDob || "",
                        nationality: card.dataset.officerNationality || "",
                        countryOfResidence: card.dataset.officerCountryOfResidence || "",
                        relationship: officerRole,
                        companyNumber,
                        companyName
                      });
                      personLatLng = personResult?.latLng;
                    }
                    
                    // Add company with connection
                    if (companyNumber) {
                      const appointmentInfo = { officer_role: officerRole, appointed_on: appointedOn };
                      await addCompanyToMap(companyNumber, companyName, officerName, personLatLng, appointmentInfo);
                    }
                  });
                });
              }
            }
          }
        });
        
        resultsDiv.appendChild(card);
      });
      
      setStatus(`${results.length} officer match${results.length === 1 ? '' : 'es'}`);
    }
  } else {
    hidePscProgress();
    resultsDiv.innerHTML = '<div class="ch-result-count">Enter at least 3 characters</div>';
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BOOTSTRAP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

document.addEventListener("DOMContentLoaded", async () => {
  setStatus("Initializing...");
  // Compatibility-only preload (non-blocking): search path is API-driven.
  loadCompaniesHouseIndex().catch(() => console.log('Legacy company index not loaded'));

  setStatus("Ready - Live API search enabled");

  // i2 catalog now loads lazily when i2/entity placement UI is first used.
  initializeEntitySelector();
  
  // Entity placement panel handlers
  const entityCategorySelect = document.getElementById('entity-category');
  const entityIconSelect = document.getElementById('entity-icon');
  const entityI2TypeSelect = document.getElementById('entity-i2-type');
  const entityLabelInput = document.getElementById('entity-label');
  const entityForm = document.getElementById('entity-placement-form');
  const entityI2FieldsWrap = document.getElementById('entity-i2-fields');
  const entityPanelClose = document.getElementById('entity-panel-close');
  const entityPanelMinimize = document.getElementById('entity-panel-minimize');
  const entityCancelBtn = document.getElementById('entity-cancel-btn');
  const entityImportFile = document.getElementById('entity-import-file');
  const entityImportRunBtn = document.getElementById('entity-import-run');
  const entityImportTemplateBtn = document.getElementById('entity-import-template');
  const entityImportClearBtn = document.getElementById('entity-import-clear');
  const entitySelectBoxBtn = document.getElementById('entity-select-box');
  const entitySelectAllBtn = document.getElementById('entity-select-all');
  const entityExportExcelBtn = document.getElementById('entity-export-excel');
  const entityImportPanel = document.querySelector('.entity-import-panel');
  
  // Category change handler
  entityCategorySelect?.addEventListener('change', async (e) => {
    const category = e.target.value;
    ENTITY_ICON_MANUAL_OVERRIDE = false;
    updateIconDropdown(category);
    await ensureI2EntityCatalogLoaded(category);
    const defaultI2Entity = defaultI2EntityForCategory(category);
    if (defaultI2Entity && entityI2TypeSelect) {
      entityI2TypeSelect.value = defaultI2Entity.entity_id;
      renderI2FieldsForType(defaultI2Entity.entity_id);
    }
    autoSelectIconFromI2Fields(true);
  });

  entityI2TypeSelect?.addEventListener('change', async (e) => {
    if (!I2_CATALOG_LOADED) {
      await ensureI2EntityCatalogLoaded(entityCategorySelect?.value || "");
    }
    renderI2FieldsForType(e.target.value);
    autoSelectIconFromI2Fields(true);
  });
  entityI2TypeSelect?.addEventListener('focus', () => {
    if (!I2_CATALOG_LOADED) {
      ensureI2EntityCatalogLoaded(entityCategorySelect?.value || "");
    }
  });
  
  // Label input handler - auto-suggest icon (unless user locked icon)
  entityLabelInput?.addEventListener('input', (e) => {
    const label = e.target.value;
    const category = entityCategorySelect.value;
    
    if (label && category) {
      autoSelectIconFromI2Fields(false);
    }
  });

  entityIconSelect?.addEventListener('change', () => {
    ENTITY_ICON_MANUAL_OVERRIDE = true;
    updateEntityIconPreview(entityCategorySelect?.value || "", parseInt(entityIconSelect.value, 10));
  });

  entityI2FieldsWrap?.addEventListener('change', () => {
    const activeField = document.activeElement;
    if (activeField && activeField.matches && activeField.matches("[data-i2-property-id]")) {
      activeField.dataset.autogen = "0";
    }
    const addrField = getI2FieldByNames(["Address String", "Address"]);
    if (addrField && document.activeElement === addrField) {
      addrField.dataset.autogen = "0";
    }
    syncAddressStringDerivedFields();
    updateWarningMarkerVisibility();
    autoSelectIconFromI2Fields(false);
  });
  entityI2FieldsWrap?.addEventListener('input', () => {
    const activeField = document.activeElement;
    if (activeField && activeField.matches && activeField.matches("[data-i2-property-id]")) {
      activeField.dataset.autogen = "0";
    }
    const addrField = getI2FieldByNames(["Address String", "Address"]);
    if (addrField && document.activeElement === addrField) {
      addrField.dataset.autogen = "0";
    }
    syncAddressStringDerivedFields();
    autoSelectIconFromI2Fields(false);
  });
  
  // Form submission handler
  entityForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const rawLabel = entityLabelInput.value.trim();
    const categoryKey = entityCategorySelect.value;
    const iconIndex = parseInt(entityIconSelect.value, 10);
    const editingEntityId = window._editingEntityId;
    const editingEntity = editingEntityId ? getEntityById(editingEntityId) : null;
    const latLng = editingEntity ? editingEntity.latLng : window._pendingEntityLatLng;
    const i2EntityData = collectI2EntityFormData();
    if (!i2EntityData) {
      alert('Select an i2 entity type for this entity');
      return;
    }
    if (i2EntityData && i2EntityData.error) {
      alert(i2EntityData.error);
      return;
    }
    
    if (!categoryKey || isNaN(iconIndex) || !latLng) {
      alert('Please fill in all required fields');
      return;
    }
    
    const category = ICON_CATEGORIES[categoryKey];
    const iconData = {...category.icons[iconIndex]};
    iconData.categoryColor = category.color;
    iconData.categoryName = category.name;
    const label = inferEntityLabel(rawLabel, i2EntityData, iconData.name);
    const manualPlacementAddress = String(document.getElementById("entity-placement-address")?.value || "").trim();
    const address = inferEntityAddress(i2EntityData) || manualPlacementAddress;
    const notes = inferEntityNotes(i2EntityData);
    if (!label) {
      alert('Please enter a label or complete i2 name fields');
      return;
    }
    
    // Prefer postcode geocode from i2 fields when available.
    let placementLatLng = latLng;
    const postcode = getI2ValueByNames(i2EntityData, ["Post Code", "Postal Code", "Postcode"]);
    const addressString = getI2ValueByNames(i2EntityData, ["Address String", "Address"]) || manualPlacementAddress;
    const extractedPostcode = !postcode ? extractUkPostcode(addressString) : "";
    let usedPostcodeGeo = false;
    const geoPostcode = postcode || extractedPostcode;
    if (geoPostcode) {
      const geo = await geocodePostcode(geoPostcode);
      if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
        placementLatLng = [geo.lat, geo.lon];
        usedPostcodeGeo = true;
      }
    }

    if (editingEntity) {
      editingEntity.label = label;
      editingEntity.address = address;
      editingEntity.notes = notes;
      editingEntity.iconData = iconData;
      editingEntity.i2EntityData = i2EntityData;
      editingEntity.latLng = placementLatLng;

      editingEntity.marker.setLatLng(placementLatLng);
      editingEntity.marker.setIcon(createEntityMarkerIcon(iconData, i2EntityData));
      editingEntity.marker.setPopupContent(buildEntityPopup(editingEntityId, editingEntity));
      bindEntityHoverTooltip(editingEntity.marker, editingEntity);
      refreshConnectionsForEntity(editingEntityId);
      refreshEntitySelectionStyles();
      map.panTo(placementLatLng);

      closeEntityPanel();
      setStatus(usedPostcodeGeo ? `Updated: ${label} (address/postcode geocoded)` : `Updated: ${label}`);
      return;
    }

    // Place new entity
    placeEntity(placementLatLng, iconData, label, address, notes, i2EntityData);
    map.panTo(placementLatLng);
    closeEntityPanel();
    setStatus(usedPostcodeGeo ? `Placed: ${label} (address/postcode geocoded)` : `Placed: ${label}`);
  });
  
  // Close button handlers
  entityPanelMinimize?.addEventListener('click', toggleEntityPanelMinimized);
  entityPanelClose?.addEventListener('click', closeEntityPanel);
  entityCancelBtn?.addEventListener('click', closeEntityPanel);

  entityImportRunBtn?.addEventListener('click', async () => {
    const file = entityImportFile?.files?.[0];
    const summaryEl = document.getElementById('entity-import-summary');
    if (!file) {
      if (summaryEl) summaryEl.textContent = 'Choose a file first (xlsx/csv/tsv/txt/json/geojson).';
      return;
    }

    if (summaryEl) summaryEl.textContent = `Parsing ${file.name}...`;
    setStatus(`Importing ${file.name}...`);
    if (entityImportRunBtn) entityImportRunBtn.disabled = true;
    try {
      const ext = (String(file.name).split(".").pop() || "").toLowerCase();
      if (["xlsx", "xls"].includes(ext)) {
        const rows = await readSpreadsheetRows(file);
        await importEntitiesFromRows(rows);
      } else if (["csv", "tsv", "txt"].includes(ext)) {
        const rows = await readDelimitedRows(file);
        await importEntitiesFromRows(rows);
      } else if (["geojson"].includes(ext)) {
        await importGeoJsonFile(file);
      } else if (["json"].includes(ext)) {
        await importJsonRowsFile(file);
      } else {
        throw new Error(`Unsupported file type .${ext || "unknown"}`);
      }
    } catch (err) {
      console.error('Entity import failed:', err);
      if (summaryEl) summaryEl.textContent = `Import failed: ${err.message || err}`;
      setStatus('Entity import failed');
    } finally {
      if (entityImportRunBtn) entityImportRunBtn.disabled = false;
    }
  });

  entityImportTemplateBtn?.addEventListener('click', () => {
    const a = document.createElement("a");
    a.href = "data/example import.xlsx";
    a.download = "example import.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus("Downloaded import template");
  });

  if (entityImportPanel && entityImportFile) {
    entityImportFile.addEventListener("change", () => {
      const chosen = entityImportFile.files?.[0];
      const summaryEl = document.getElementById('entity-import-summary');
      if (chosen && summaryEl) {
        summaryEl.textContent = `Selected: ${chosen.name}. Click "Import And Plot".`;
      }
    });
    entityImportPanel.addEventListener("dragover", (e) => {
      e.preventDefault();
      entityImportPanel.classList.add("dragover");
    });
    entityImportPanel.addEventListener("dragleave", () => {
      entityImportPanel.classList.remove("dragover");
    });
    entityImportPanel.addEventListener("drop", (e) => {
      e.preventDefault();
      entityImportPanel.classList.remove("dragover");
      const dropped = e.dataTransfer?.files?.[0];
      if (!dropped) return;
      const dt = new DataTransfer();
      dt.items.add(dropped);
      entityImportFile.files = dt.files;
      const summaryEl = document.getElementById('entity-import-summary');
      if (summaryEl) summaryEl.textContent = `Selected: ${dropped.name}. Click "Import And Plot".`;
    });
  }

  entityImportClearBtn?.addEventListener('click', () => {
    if (window._importedEntityIds.size === 0) {
      const summaryEl = document.getElementById('entity-import-summary');
      if (summaryEl) summaryEl.textContent = 'No imported entities to clear.';
      return;
    }
    clearImportedEntities();
  });

  entitySelectBoxBtn?.addEventListener('click', () => toggleEntityBoxSelectMode());
  entitySelectAllBtn?.addEventListener('click', () => selectAllEntities());
  entityExportExcelBtn?.addEventListener('click', () => exportEntitiesToExcel());

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'a') {
      if (isEditingInputTarget(e.target)) return;
      e.preventDefault();
      selectAllEntities();
    }
    if (String(e.key || "") === "Escape" && entityBoxSelectMode) {
      toggleEntityBoxSelectMode(false);
    }
  });

  const resultsDiv = document.getElementById("ch_results");
  const pscResultsDiv = document.getElementById("psc_results");
  const btn        = document.getElementById("ch_search");
  const clearBtn   = document.getElementById("ch_clear");
  const pscBtn     = document.getElementById("psc_search");
  const pscClearBtn = document.getElementById("psc_clear");
  const toggleBtn  = document.getElementById("cp-toggle");
  const body       = document.getElementById("cp-body");
  const cpMenuBtn = document.getElementById("cp-menu-btn");
  const cpMenu = document.getElementById("cp-menu");
  const controlPanel = document.getElementById("control-panel");
  const controlPanelHeader = controlPanel?.querySelector(".cp-header");
  const entityPanel = document.getElementById("entity-placement-panel");
  const mobilePanelToggle = document.getElementById("mobile-panel-toggle");
  const mobileViewport = window.matchMedia("(max-width: 920px)");
  let mobilePanelHidden = false;
  const inputs = ["ch_name","ch_number","ch_postcode","ch_town"]
    .map(id => document.getElementById(id)).filter(Boolean);
  const pscInputs = ["psc_name","psc_company"]
    .map(id => document.getElementById(id)).filter(Boolean);

  function applyMobilePanelState(hidden) {
    if (!controlPanel || !mobilePanelToggle) return;
    mobilePanelHidden = !!hidden;
    const shouldHide = mobileViewport.matches && mobilePanelHidden;
    controlPanel.classList.toggle("mobile-hidden", shouldHide);
    mobilePanelToggle.textContent = shouldHide ? "Panel" : "Hide";
    mobilePanelToggle.setAttribute("aria-expanded", shouldHide ? "false" : "true");
    mobilePanelToggle.setAttribute("title", shouldHide ? "Show control panel" : "Hide control panel");
  }

  function syncMobileViewportLayout() {
    if (!controlPanel || !mobilePanelToggle) return;
    if (mobileViewport.matches) {
      if (!mobilePanelToggle.dataset.mobileInitDone) {
        mobilePanelToggle.dataset.mobileInitDone = "1";
        mobilePanelHidden = true;
      }
      applyMobilePanelState(mobilePanelHidden);
    } else {
      mobilePanelHidden = false;
      controlPanel.classList.remove("mobile-hidden");
      mobilePanelToggle.textContent = "Panel";
      mobilePanelToggle.setAttribute("aria-expanded", "true");
      mobilePanelToggle.setAttribute("title", "Toggle control panel");
    }
    map.invalidateSize(false);
  }

  mobilePanelToggle?.addEventListener("click", () => {
    applyMobilePanelState(!mobilePanelHidden);
    map.invalidateSize(false);
  });

  mobileViewport.addEventListener("change", syncMobileViewportLayout);
  syncMobileViewportLayout();
  makePanelDraggable(controlPanel, controlPanelHeader);
  makePanelDraggable(entityPanel, document.querySelector(".entity-panel-header"));

  map.on("click", () => {
    if (!mobileViewport.matches || mobilePanelHidden) return;
    if (window._placementMode || entityBoxSelectMode) return;
    applyMobilePanelState(true);
  });

  // â”€â”€ Panel collapse â”€â”€
  toggleBtn?.addEventListener("click", () => {
    body.classList.toggle("collapsed");
    toggleBtn.textContent = body.classList.contains("collapsed") ? "+" : "\u2212";
  });

  function activateControlPanelTab(tabId = "search") {
    const tab = document.querySelector(`.cp-tab[data-tab="${tabId}"]`);
    if (!tab) return;
    document.querySelectorAll(".cp-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".cp-tab-pane").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab)?.classList.add("active");
    controlPanel?.classList.remove("control-panel-layers-docked");
  }

  // Tabs
  document.querySelectorAll(".cp-tab").forEach(tab => {
    tab.addEventListener("click", () => activateControlPanelTab(tab.dataset.tab));
  });

  // Top menu dropdown
  cpMenuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !cpMenu?.classList.contains("hidden");
    cpMenu?.classList.toggle("hidden", open);
    cpMenu?.setAttribute("aria-hidden", open ? "true" : "false");
  });

  cpMenu?.querySelectorAll("[data-tab-target]")?.forEach((btnEl) => {
    btnEl.addEventListener("click", () => {
      const tabId = btnEl.getAttribute("data-tab-target") || "search";
      activateControlPanelTab(tabId);
      cpMenu.classList.add("hidden");
      cpMenu.setAttribute("aria-hidden", "true");
    });
  });

  document.addEventListener("click", (e) => {
    if (!cpMenu || !cpMenuBtn) return;
    if (cpMenu.classList.contains("hidden")) return;
    if (cpMenu.contains(e.target) || cpMenuBtn.contains(e.target)) return;
    cpMenu.classList.add("hidden");
    cpMenu.setAttribute("aria-hidden", "true");
  });

  // â”€â”€ Base layer pills â”€â”€
  document.querySelectorAll(".bl-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      const name = pill.dataset.base;
      if (name === activeBase) return;
      map.removeLayer(baseLayers[activeBase]);
      baseLayers[name].addTo(map);
      activeBase = name;
      document.querySelectorAll(".bl-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
    });
  });

  // â”€â”€ Overlay toggles â”€â”€
  function syncLayerToolBlocks() {
    document.querySelectorAll("[data-layer-tools]").forEach((el) => {
      const layerId = el.getAttribute("data-layer-tools");
      const cb = document.querySelector(`.layer-cb[data-layer="${layerId}"]`);
      const enabled = !!cb?.checked;
      el.classList.toggle("hidden", !enabled);
    });
  }
  document.querySelectorAll(".layer-cb").forEach(cb => {
    cb.addEventListener("change", async () => {
      const layerId = cb.dataset.layer;
      const layer = layers[layerId];
      if (!layer) return;
      if (cb.checked && layerId === "areas") {
        const ok = await ensurePoliceAreasLoaded();
        if (!ok) { cb.checked = false; return; }
      }
      if (cb.checked && (layerId === "airports_uk" || layerId === "airports_global" || layerId === "flights")) {
        await ensureAirportsLoaded();
      }
      if (cb.checked && layerId === "seaports") {
        await ensureSeaportsLoaded();
      }
      if (cb.checked && layerId === "underground") {
        const ok = await ensureUndergroundLoaded();
        if (!ok) { cb.checked = false; return; }
      }
      if (cb.checked && cb.dataset.layer === "os_roads") {
        if (map.getZoom() < 6) {
          cb.checked = false;
          setStatus("Zoom in to level 6+ before enabling OS roads.");
          return;
        }
        await loadOsRoadOverlay();
      }
      if (cb.checked && cb.dataset.layer === "os_rail") {
        if (map.getZoom() < 6) {
          cb.checked = false;
          setStatus("Zoom in to level 6+ before enabling UK rail network.");
          return;
        }
        await loadOsRailOverlay();
      }
      if (cb.checked) { layer.addTo(map); }
      else { map.removeLayer(layer); }
      syncLayerToolBlocks();
    });
  });
  syncLayerToolBlocks();

  const airportSearchInput = document.getElementById("airport-search-q");
  const airportSearchBtn = document.getElementById("airport-search-btn");
  const airportSearchClearBtn = document.getElementById("airport-search-clear-btn");
  const runAirportSearch = async () => {
    const q = String(airportSearchInput?.value || "").trim();
    if (!q) {
      renderAirportSearchResults([]);
      return;
    }
    const ok = await ensureAirportsLoaded();
    if (!ok) {
      const wrap = document.getElementById("airport-search-results");
      if (wrap) wrap.innerHTML = `<div class="nr-empty">Airport dataset unavailable.</div>`;
      return;
    }
    const hits = searchAirports(q, 12);
    renderAirportSearchResults(hits);
    if (hits.length === 1) {
      focusAirportOnMap(hits[0]);
    }
  };
  airportSearchBtn?.addEventListener("click", runAirportSearch);
  airportSearchInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      runAirportSearch();
    }
  });
  airportSearchClearBtn?.addEventListener("click", () => {
    if (airportSearchInput) airportSearchInput.value = "";
    const wrap = document.getElementById("airport-search-results");
    if (wrap) wrap.innerHTML = "";
  });

  // â”€â”€ Live company search DISABLED (now using API on button click) â”€â”€
  // const debouncedSearch = debounce(() => liveSearch(resultsDiv), 300);
  // inputs.forEach(input => input.addEventListener("input", debouncedSearch));

  // â”€â”€ Full company search (NOW USES API) â”€â”€
  const runSearch = async () => {
    const criteria = getCriteriaFromUI();
    if (!pickSeed(criteria).trim()) return;
    
    showProgress(); 
    setProgress(0, 1, 0);
    setStatus("Searching via API...");
    resultsDiv.innerHTML = '<div class="ch-loading">Searching Companies House API...</div>';
    
    try {
      const matches = await searchCompaniesViaAPI(criteria, 100);

      hideProgress();
      CH_LAST_RESULTS = matches;
      renderResults(resultsDiv, matches, false);

      if (matches.length) {
        setStatus(`Search returned ${matches.length} result${matches.length === 1 ? "" : "s"} - click entries to plot selected companies`);
      } else {
        setStatus("No matches found");
      }
    } catch (error) {
      hideProgress();
      console.error("Search error:", error);
      resultsDiv.innerHTML = '<div class="ch-error">Search failed. Check console for details.</div>';
      setStatus("Search failed");
    }
  };
  btn?.addEventListener("click", runSearch);
  inputs.forEach(input => input.addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); }));

  // â”€â”€ Clear company â”€â”€
  clearBtn?.addEventListener("click", clearAll);

  // â”€â”€ PSC search â”€â”€
  pscBtn?.addEventListener("click", runPscSearch);
  pscInputs.forEach(input => input.addEventListener("keydown", e => { if (e.key === "Enter") runPscSearch(); }));

  // â”€â”€ Clear PSC â”€â”€
  pscClearBtn?.addEventListener("click", clearPsc);
});
