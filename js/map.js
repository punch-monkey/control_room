// ================== map.js ==================

// ── Status / Progress helpers ──

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

// ── Companies House data ──

let CH_INDEX = [];
let CH_CACHE = {};
let CH_LAST_RESULTS = [];
let CH_TOTAL_ROWS = 0;

async function loadCompaniesHouseIndex() {
  const r = await fetch("data/companies_house_index.json");
  CH_INDEX = await r.json();
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

// ── Search ──

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

// ── Postcode lookup ──

const PC_CACHE = {}, PC_LOADING = {};
function postcodeArea(pc) { const m = pc.match(/^([A-Z]{1,2})/); return m ? m[1] : null; }
function loadPostcodeArea(area) {
  if (PC_CACHE[area]) return Promise.resolve(PC_CACHE[area]);
  if (PC_LOADING[area]) return PC_LOADING[area];
  PC_LOADING[area] = fetch(`data/postcodes/${area}.json`).then(r => r.json())
    .then(d => { PC_CACHE[area] = d; delete PC_LOADING[area]; return d; })
    .catch(() => { delete PC_LOADING[area]; return {}; });
  return PC_LOADING[area];
}
function lookupPostcode(pc) { const a = postcodeArea(pc); return a && PC_CACHE[a] ? PC_CACHE[a][pc] || null : null; }
async function ensurePostcodesForRows(rows) {
  const needed = new Set();
  for (const r of rows) {
    const raw = r["RegAddress.PostCode"]; if (!raw) continue;
    const a = postcodeArea(raw.toUpperCase().replace(/[^A-Z0-9]/g, ""));
    if (a && !PC_CACHE[a]) needed.add(a);
  }
  if (needed.size) await Promise.all([...needed].map(loadPostcodeArea));
}

// ══════════════════════════════════════════════════════
// PSC (Persons with Significant Control)
// ══════════════════════════════════════════════════════

let PSC_MANIFEST = null;
const PSC_NAME_CACHE = {};    // keyed by 2-char prefix (e.g. "SM"), value = array
const PSC_CO_CACHE = {};      // keyed by chunk key (e.g. "08_03"), value = array
const PSC_CACHE_MAX = 5;      // max cached files per type to limit memory

// LRU tracking
const _nameAccessOrder = [];
const _coAccessOrder = [];

function evictOldCache(cache, accessOrder, max) {
  while (accessOrder.length > max) {
    const old = accessOrder.shift();
    delete cache[old];
  }
}

async function loadPscManifest() {
  try {
    const r = await fetch("data/psc_manifest.json");
    PSC_MANIFEST = await r.json();
  } catch (e) {
    console.warn("PSC manifest not found — run preprocess_psc_v2.py first", e);
    PSC_MANIFEST = null;
  }
}

// Extract 2-char surname prefix (same logic as Python preprocessor)
const PSC_TITLES = new Set(["mr","mrs","ms","miss","dr","sir","lord","lady","dame","professor","prof","rev","reverend"]);
function extractSurname(name) {
  if (!name) return "";
  const parts = name.trim().split(/\s+/);
  const filtered = parts.filter(p => !PSC_TITLES.has(p.toLowerCase()));
  return filtered.length ? filtered[filtered.length - 1].toUpperCase() : parts[parts.length - 1].toUpperCase();
}

function getNamePrefix(name) {
  const surname = extractSurname(name);
  if (!surname || surname.length < 2) return surname ? surname[0] + "X" : "ZZ";
  const c1 = /[A-Z]/.test(surname[0]) ? surname[0] : "Z";
  const c2 = /[A-Z]/.test(surname[1]) ? surname[1] : "Z";
  return c1 + c2;
}

function getCompanyPrefix(coNum) {
  if (!coNum || coNum.length < 2) return "00";
  return coNum.substring(0, 2).toUpperCase();
}

// Find which chunk files to load for a name search
function findNameFiles(nameQuery) {
  if (!PSC_MANIFEST || !PSC_MANIFEST.name_index) return [];
  const prefix = getNamePrefix(nameQuery);
  const files = [];
  // Look for exact prefix and sub-chunks (e.g., "SM", "SM_00", "SM_01")
  for (const key in PSC_MANIFEST.name_index) {
    if (key === prefix || key.startsWith(prefix + "_")) {
      files.push({ key, ...PSC_MANIFEST.name_index[key] });
    }
  }
  return files;
}

// Find which chunk files to load for a company number PSC lookup
function findCompanyPscFiles(coNum) {
  if (!PSC_MANIFEST || !PSC_MANIFEST.company_chunks) return [];
  const prefix = getCompanyPrefix(coNum);
  const files = [];
  for (const key in PSC_MANIFEST.company_chunks) {
    if (key === prefix || key.startsWith(prefix + "_")) {
      files.push({ key, ...PSC_MANIFEST.company_chunks[key] });
    }
  }
  return files;
}

// Load a name index file
async function loadNameFile(key, filePath) {
  if (PSC_NAME_CACHE[key]) {
    // Move to end of access order
    const idx = _nameAccessOrder.indexOf(key);
    if (idx >= 0) _nameAccessOrder.splice(idx, 1);
    _nameAccessOrder.push(key);
    return PSC_NAME_CACHE[key];
  }
  const r = await fetch(filePath);
  const data = await r.json();
  PSC_NAME_CACHE[key] = data;
  _nameAccessOrder.push(key);
  evictOldCache(PSC_NAME_CACHE, _nameAccessOrder, PSC_CACHE_MAX);
  return data;
}

// Load a company PSC chunk file
async function loadCompanyPscFile(key, filePath) {
  if (PSC_CO_CACHE[key]) {
    const idx = _coAccessOrder.indexOf(key);
    if (idx >= 0) _coAccessOrder.splice(idx, 1);
    _coAccessOrder.push(key);
    return PSC_CO_CACHE[key];
  }
  const r = await fetch(filePath);
  const data = await r.json();
  PSC_CO_CACHE[key] = data;
  _coAccessOrder.push(key);
  evictOldCache(PSC_CO_CACHE, _coAccessOrder, PSC_CACHE_MAX);
  return data;
}

// Search by person name — loads relevant name chunk files progressively
async function searchPersonByName(nameQuery, limit) {
  limit = limit || 200;
  const files = findNameFiles(nameQuery);
  if (!files.length) return [];

  const queryLower = nameQuery.trim().toLowerCase();
  const results = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setPscProgress(`Loading ${i + 1}/${files.length}...`, Math.round(((i + 1) / files.length) * 100));
    try {
      const data = await loadNameFile(f.key, f.file);
      for (let j = 0; j < data.length; j++) {
        if (data[j].n.toLowerCase().includes(queryLower)) {
          results.push(data[j]);
          if (results.length >= limit) return results;
        }
      }
    } catch (e) {
      console.warn("Failed to load name file:", f.file, e);
    }
  }
  return results;
}

// Search PSC by company number — loads relevant company chunk files
async function searchPscByCompany(coNum) {
  const files = findCompanyPscFiles(coNum);
  if (!files.length) return [];

  const coUpper = coNum.toUpperCase().trim();
  const results = [];

  for (const f of files) {
    try {
      const data = await loadCompanyPscFile(f.key, f.file);
      for (let j = 0; j < data.length; j++) {
        if (data[j].c === coUpper) {
          results.push(data[j]);
        }
      }
    } catch (e) {
      console.warn("Failed to load PSC chunk:", f.file, e);
    }
  }
  return results;
}

// ══════════════════════════════════════════════════════
// MAP
// ══════════════════════════════════════════════════════

const map = L.map("map", { zoomControl: true }).setView(
  CONTROL_ROOM_CONFIG.map.center, CONTROL_ROOM_CONFIG.map.zoom
);

// Scale bar
L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);

// ── Tile layers ──

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

// ── Overlay layers (ALL OFF by default) ──

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

// ── Connection Lines Layer ──
const connectionsLayer = L.layerGroup();

// ── Custom Entities Layer ──
const entitiesLayer = L.layerGroup();

const layers = {
  companies:       companyCluster,
  connections:     connectionsLayer,
  entities:        entitiesLayer,
  areas:           L.featureGroup(),
  airports_uk:     L.featureGroup(),
  airports_global: L.featureGroup(),
  seaports:        L.featureGroup(),
  underground:     L.featureGroup(),
  flights:         L.featureGroup(),
  bikes:           L.featureGroup()
};

// Track connections and entity data
window._mapConnections = [];
window._mapEntities = [];
window._placementMode = null;

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
  }
});

function showEntityPlacementDialog(latLng) {
  const category = window._placementMode;
  if (!category) return;
  
  // Store the lat/lng for later use
  window._pendingEntityLatLng = latLng;
  
  // Open the entity placement panel
  const panel = document.getElementById('entity-placement-panel');
  panel.classList.add('open');
  
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
  
  // Update coordinates display
  document.getElementById('entity-coords').textContent = `${latLng[0].toFixed(5)}, ${latLng[1].toFixed(5)}`;
  
  // Focus on the label input
  setTimeout(() => {
    document.getElementById('entity-label').focus();
  }, 100);
}

function updateIconDropdown(category) {
  const iconSelect = document.getElementById('entity-icon');
  iconSelect.innerHTML = '<option value="">Select icon...</option>';
  
  if (!category || !ICON_CATEGORIES[category]) return;
  
  const icons = ICON_CATEGORIES[category].icons;
  icons.forEach((iconData, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = iconData.name;
    iconSelect.appendChild(option);
  });
}

function closeEntityPanel() {
  const panel = document.getElementById('entity-placement-panel');
  panel.classList.remove('open');
  
  // Clear form
  document.getElementById('entity-placement-form').reset();
  document.getElementById('entity-coords').textContent = '--';
  
  // Cancel placement mode
  cancelPlacementMode();
}

// ══════════════════════════════════════════════════════
// ENTITY DEFINITIONS
// ══════════════════════════════════════════════════════

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
      { id: 'factory', name: 'Factory', icon: 'gfx/map_icons/real_estate/factory.png', keywords: ['factory', 'industrial', 'plant'] }
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
      { id: 'truck', name: 'Truck', icon: 'gfx/map_icons/cars/truck.png', keywords: ['truck', 'lorry'] }
    ]
  },
  communication: {
    name: 'Communication',
    color: '#8b5cf6',
    defaultIcon: 'gfx/map_icons/communication/chat.png',
    icons: [
      { id: 'chat', name: 'Chat', icon: 'gfx/map_icons/communication/chat.png', keywords: ['chat', 'message', 'conversation'] },
      { id: 'email', name: 'Email', icon: 'gfx/map_icons/communication/email.png', keywords: ['email', 'mail'] },
      { id: 'sms', name: 'SMS', icon: 'gfx/map_icons/communication/sms.png', keywords: ['sms', 'text', 'message'] }
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

function getIconByCategory(category) {
  return ICON_CATEGORIES[category] || ICON_CATEGORIES.people;
}

function getAllIcons() {
  const allIcons = [];
  for (const [catId, cat] of Object.entries(ICON_CATEGORIES)) {
    cat.icons.forEach(icon => {
      allIcons.push({ ...icon, category: catId, categoryName: cat.name, categoryColor: cat.color });
    });
  }
  return allIcons;
}

// ══════════════════════════════════════════════════════
// CONNECTION MANAGEMENT
// ══════════════════════════════════════════════════════

function addConnection(fromLatLng, toLatLng, label, type = 'officer', metadata = {}) {
  const connectionId = `conn_${Date.now()}_${Math.random()}`;
  
  const color = type === 'officer' ? '#a78bfa' : 
                type === 'psc' ? '#fbbf24' : 
                type === 'manual' ? '#22c55e' : '#64748b';
  
  const polyline = L.polyline([fromLatLng, toLatLng], {
    color: color,
    weight: 3,
    opacity: 0.7,
    dashArray: type === 'manual' ? '8, 4' : '5, 5'
  }).addTo(connectionsLayer);
  
  // Store reference to connected entities for highlighting
  polyline._connectionData = {
    fromLatLng: fromLatLng,
    toLatLng: toLatLng,
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
    const midLat = (fromLatLng[0] + toLatLng[0]) / 2;
    const midLng = (fromLatLng[1] + toLatLng[1]) / 2;
    
    const labelIcon = L.divIcon({
      className: 'connection-label',
      html: `<div class="connection-label-text">${escapeHtml(label)}</div>`,
      iconSize: [150, 30],
      iconAnchor: [75, 15]
    });
    
    const labelMarker = L.marker([midLat, midLng], { icon: labelIcon }).addTo(connectionsLayer);
    
    window._mapConnections.push({
      id: connectionId,
      type,
      label,
      fromLatLng: fromLatLng,
      toLatLng: toLatLng,
      line: polyline,
      labelMarker: labelMarker,
      metadata: metadata
    });
  } else {
    window._mapConnections.push({
      id: connectionId,
      type,
      fromLatLng: fromLatLng,
      toLatLng: toLatLng,
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

// ══════════════════════════════════════════════════════
// ENTITY PLACEMENT
// ══════════════════════════════════════════════════════

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

function placeEntity(latLng, iconData, label = '', address = '', notes = '') {
  const entityId = `entity_${Date.now()}_${Math.random()}`;
  
  const icon = L.icon({
    iconUrl: iconData.icon,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16]
  });
  
  const marker = L.marker(latLng, { icon: icon });
  
  const popup = `
    <strong>${escapeHtml(label || iconData.name)}</strong>
    <span class="popup-label">Type</span> <span class="popup-tag" style="background:${iconData.categoryColor || iconData.color};">${escapeHtml(iconData.categoryName || iconData.name)}</span><br>
    ${address ? `<span class="popup-label">Address</span> ${escapeHtml(address)}<br>` : ''}
    ${notes ? `<span class="popup-label">Notes</span> ${escapeHtml(notes)}<br>` : ''}
    <span class="popup-label">Lat/Lng</span> ${latLng[0].toFixed(5)}, ${latLng[1].toFixed(5)}
    <div class="popup-btn-row">
      <button class="popup-psc-btn" onclick="editEntity('${entityId}')">Edit</button>
      <button class="popup-psc-btn" onclick="drawConnectionFrom('${entityId}')">Connect</button>
      <button class="popup-psc-btn" onclick="removeEntity('${entityId}')">Remove</button>
    </div>
  `;
  
  marker.bindPopup(popup).addTo(entitiesLayer);
  
  // Add click handler to highlight connections
  marker.on('click', function(e) {
    L.DomEvent.stopPropagation(e);
    highlightConnections(marker.getLatLng());
  });
  
  marker.openPopup();
  
  window._mapEntities.push({
    id: entityId,
    iconData: iconData,
    label: label || iconData.name,
    address: address || '',
    notes: notes || '',
    latLng: latLng,
    marker: marker
  });
  
  updateDashboardCounts();
  
  return entityId;
}

function removeEntity(entityId) {
  const idx = window._mapEntities.findIndex(e => e.id === entityId);
  if (idx >= 0) {
    const entity = window._mapEntities[idx];
    entitiesLayer.removeLayer(entity.marker);
    window._mapEntities.splice(idx, 1);
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
  
  // Update popup
  const popup = `
    <strong>${escapeHtml(entity.label)}</strong>
    <span class="popup-label">Type</span> <span class="popup-tag" style="background:${entity.iconData.categoryColor || entity.iconData.color};">${escapeHtml(entity.iconData.categoryName || entity.iconData.name)}</span><br>
    ${entity.address ? `<span class="popup-label">Address</span> ${escapeHtml(entity.address)}<br>` : ''}
    ${entity.notes ? `<span class="popup-label">Notes</span> ${escapeHtml(entity.notes)}<br>` : ''}
    <span class="popup-label">Lat/Lng</span> ${entity.latLng[0].toFixed(5)}, ${entity.latLng[1].toFixed(5)}
    <div class="popup-btn-row">
      <button class="popup-psc-btn" onclick="editEntity('${entityId}')">Edit</button>
      <button class="popup-psc-btn" onclick="drawConnectionFrom('${entityId}')">Connect</button>
      <button class="popup-psc-btn" onclick="removeEntity('${entityId}')">Remove</button>
    </div>
  `;
  entity.marker.setPopupContent(popup);
  setStatus('Entity updated');
}

function editEntityLabel(entityId) {
  editEntity(entityId);
}

function clearAllEntities() {
  window._mapEntities.forEach(entity => {
    entitiesLayer.removeLayer(entity.marker);
  });
  window._mapEntities = [];
  setStatus('All custom entities removed');
  updateDashboardCounts();
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

// ══════════════════════════════════════════════════════
// MANUAL CONNECTION DRAWING
// ══════════════════════════════════════════════════════

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
  
  // Add temporary click handler
  map.once('click', cancelConnectionDrawing);
}

function cancelConnectionDrawing() {
  connectionDrawingMode = null;
  setStatus('Connection cancelled');
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
  
  setStatus(`Connected: ${connectionDrawingMode.fromEntity.label} → ${toEntity.label}`);
  cancelConnectionDrawing();
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
      ${metadata.toLabel ? `<span class="popup-label">To</span> ${escapeHtml(metadata.toLabel)}` : ''}
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
  
  conn.label = newLabel.trim();
  
  // Update label marker
  if (conn.labelMarker) {
    connectionsLayer.removeLayer(conn.labelMarker);
  }
  
  if (newLabel.trim()) {
    const coords = conn.line.getLatLngs();
    const midLat = (coords[0].lat + coords[1].lat) / 2;
    const midLng = (coords[0].lng + coords[1].lng) / 2;
    
    const labelIcon = L.divIcon({
      className: 'connection-label',
      html: `<div class="connection-label-text">${escapeHtml(newLabel)}</div>`,
      iconSize: [150, 30],
      iconAnchor: [75, 15]
    });
    
    conn.labelMarker = L.marker([midLat, midLng], { icon: labelIcon }).addTo(connectionsLayer);
  }
  
  setStatus('Connection updated');
  map.closePopup();
}

// ══════════════════════════════════════════════════════
// ENTITY SELECTOR UI
// ══════════════════════════════════════════════════════

function initializeEntitySelector() {
  const container = document.getElementById('entity_selector');
  if (!container) return;
  
  container.innerHTML = '';
  
  // Create category buttons  
  for (const [catId, category] of Object.entries(ICON_CATEGORIES)) {
    const categoryBtn = document.createElement('div');
    categoryBtn.className = 'entity-category';
    
    const firstIcon = category.icons[0];
    categoryBtn.innerHTML = `
      <button class="entity-btn" data-category="${catId}">
        <img src="${firstIcon.icon}" class="entity-icon" alt="${category.name}">
        <span class="entity-name">${category.name}</span>
        <span class="entity-count">${category.icons.length}</span>
      </button>
    `;
    
    const btn = categoryBtn.querySelector('.entity-btn');
    btn.addEventListener('click', () => {
      startPlacementMode(catId);
      // Visual feedback
      document.querySelectorAll('.entity-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    
    container.appendChild(categoryBtn);
  }
  
  // Add manual connection button
  const connBtn = document.createElement('button');
  connBtn.className = 'btn-secondary';
  connBtn.innerHTML = '🔗 Draw Connection';
  connBtn.addEventListener('click', () => {
    const entityList = window._mapEntities.map((e, i) => `${i + 1}. ${e.label}`).join('\n');
    if (entityList) {
      alert(`Click the "🔗 Connect" button on any entity to start drawing connections.\n\nEntities on map:\n${entityList}`);
    } else {
      alert('No entities on map. Place entities first, then use the 🔗 Connect button on each entity.');
    }
  });
  container.appendChild(connBtn);
  
  // Add cancel and clear buttons
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = '✕ Cancel Placement';
  cancelBtn.addEventListener('click', () => {
    cancelPlacementMode();
    cancelConnectionDrawing();
    document.querySelectorAll('.entity-btn').forEach(b => b.classList.remove('active'));
  });
  container.appendChild(cancelBtn);
  
  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn-secondary';
  clearBtn.textContent = '🗑️ Clear All';
  clearBtn.addEventListener('click', () => {
    if (confirm('Remove all custom entities and connections from map?')) {
      clearAllEntities();
      clearConnections();
    }
  });
  container.appendChild(clearBtn);
}

// ── Load overlay data ──

// Police force boundaries
fetch("data/police_force_areas_wgs84.geojson").then(r => r.json()).then(data => {
  L.geoJSON(data, {
    style: { color: "#818cf8", weight: 2, fillColor: "#818cf8", fillOpacity: 0.06, dashArray: "6 4" },
    onEachFeature: (f, l) => {
      const n = f.properties?.name || f.properties?.NAME || "Unknown";
      l.bindPopup(`<strong>${n}</strong><br><span class="popup-label">Police Force Area</span>`);
    }
  }).addTo(layers.areas);
}).catch(e => console.warn("Police areas:", e));

// Airports
const UK_COUNTRIES = ["ENGLAND","SCOTLAND","WALES","NORTHERN IRELAND","IRELAND","UK"];
fetch("data/airports.geojson").then(r => r.json()).then(data => {
  L.geoJSON(data, {
    pointToLayer: (f, ll) => {
      const isUK = UK_COUNTRIES.includes((f.properties?.country || "").toUpperCase());
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
      l.bindPopup(`<strong>${f.properties?.name || "Unnamed"}</strong><br><span class="popup-label">${c}</span>`);
      (isUK ? layers.airports_uk : layers.airports_global).addLayer(l);
    }
  });
}).catch(e => console.warn("Airports:", e));

// Seaports
fetch("data/sea_ports_simple.geojson").then(r => r.json()).then(data => {
  L.geoJSON(data, {
    pointToLayer: (_, ll) => L.circleMarker(ll, {
      radius: 5, color: "#2dd4bf", fillColor: "#2dd4bf", fillOpacity: 0.85, weight: 1.5
    }),
    onEachFeature: (f, l) =>
      l.bindPopup(`<strong>${f.properties?.name || "Seaport"}</strong><br><span class="popup-label">Seaport</span>`)
  }).addTo(layers.seaports);
}).catch(e => console.warn("Seaports:", e));

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
fetch("data/underground_map/underground-live-map-master/bin/lines_for_stations.json")
  .then(r => r.json())
  .then(data => {
    stationLinesData = data;
    return fetch("data/underground_map/underground-live-map-master/bin/stations.json");
  })
  .then(r => r.json())
  .then(data => {
    const seen = new Set();
    for (const [fullName, coords] of Object.entries(data)) {
      const parts = coords.split(",").map(Number);
      const lon = parts[0], lat = parts[1];
      if (isNaN(lat) || isNaN(lon)) continue;
      
      // De-duplicate by coordinates
      const key = lat.toFixed(4) + "," + lon.toFixed(4);
      if (seen.has(key)) continue;
      seen.add(key);
      
      // Clean up station name
      const stationName = fullName
        .replace(/ Station$/i, "").replace(/ Rail Station$/i, "")
        .replace(/ DLR Station$/i, "").replace(/ Tram Stop$/i, "");
      
      // Get lines for this station
      const lines = stationLinesData[stationName] || [];
      
      // Determine network type
      let networkType = lines.length > 0 ? lines.join(', ') : 'Underground';
      if (fullName.includes("DLR")) networkType = "DLR";
      else if (fullName.includes("Tram")) networkType = "Tram";
      
      // Use line-specific roundel icon
      const stnMarker = L.marker([lat, lon], {
        icon: getTfLRoundelIcon(lines)
      });

      // Base popup content
      const baseContent =
        `<strong>${stationName}</strong>` +
        `<span class="popup-label">Lines</span> ${networkType}`;

      stnMarker.bindPopup(
        baseContent + '<div class="tfl-arrivals"><div class="tfl-arrivals-loading">Click for live arrivals...</div></div>'
      );

      // On popup open, fetch live arrivals from TfL API
      stnMarker.on("popupopen", async function () {
        if (typeof buildTflStationPopup !== "function") return;
        const popupObj = await buildTflStationPopup(stationName, networkType);
        stnMarker.setPopupContent(popupObj.loadingHtml);
        const fullHtml = await popupObj.fetchFull();
        stnMarker.setPopupContent(fullHtml);
      });

      stnMarker.addTo(layers.underground);
    }
    console.log(`✓ TfL stations loaded with line-specific roundel icons`);
  })
  .catch(e => console.warn("TfL Stations:", e));

// TfL Line Routes with Official Colors
const TFL_LINE_COLORS = {
  "Northern": "#000000",
  "Bakerloo": "#a45a2a", 
  "Central": "#da291c",
  "Circle": "#ffcd00",
  "District": "#007a33",
  "DLR": "#00b2a9",
  "Hammersmith & City": "#e89cae",
  "Jubilee": "#7C878e",
  "Metropolitan": "#840b55",
  "Piccadilly": "#10069f",
  "Victoria": "#00a3e0",
  "Waterloo & City": "#6eceb2",
  "Elizabeth": "#753bbd",
  "Overground": "#e87722",
  "Cable Car": "#c8102e",
  "Tramlink": "#78be20"
};

// Map polyline colors from london-lines.json to official TfL colors
const COLOR_MAP = {
  "#9364cc": "#753bbd",  // Elizabeth line (purple)
  "#3c8cff": "#00a3e0",  // Victoria line (light blue)
  "#149600": "#007a33",  // District line (green)
  "#64500a": "#a45a2a",  // Bakerloo line (brown)
  "#8c505a": "#840b55",  // Metropolitan line (magenta)
  "#ff64a0": "#e89cae",  // Hammersmith & City (pink)
  "#ffff00": "#ffcd00",  // Circle line (yellow)
  "#ff0000": "#da291c",  // Central line (red)
  "#0000c8": "#10069f",  // Piccadilly line (blue)
  "#808080": "#7C878e",  // Jubilee line (grey)
  "#000000": "#000000",  // Northern line (black)
  "#00ffa0": "#6eceb2",  // Waterloo & City (turquoise)
  "#ffbe28": "#e87722"   // Overground (orange)
};

// Load TfL line route polylines  
fetch("data/underground_map/underground-live-map-master/bin/london-lines.json")
  .then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then(data => {
    if (!data.polylines || !Array.isArray(data.polylines)) {
      throw new Error("Invalid data structure - no polylines array");
    }
    
    const polylines = data.polylines;
    let addedCount = 0;
    
    for (let i = 0; i < polylines.length; i++) {
      const segment = polylines[i];
      if (!Array.isArray(segment) || segment.length < 3) continue;
      
      const oldColor = segment[0];
      const opacity = segment[1];
      const coords = segment.slice(2);
      
      if (coords.length === 0) continue;
      
      // Map to official TfL color
      const color = COLOR_MAP[oldColor] || oldColor;
      
      L.polyline(coords, {
        color: color,
        weight: 4,
        opacity: 0.8,
        smoothFactor: 1,
        className: 'tfl-line'
      }).addTo(layers.underground);
      
      addedCount++;
    }
    
    console.log(`✓ TfL route lines loaded: ${addedCount} segments`);
  })
  .catch(e => {
    console.error("✗ TfL route lines failed:", e.message);
  });

// ══════════════════════════════════════════════════════
// UI
// ══════════════════════════════════════════════════════

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

// ── Company Results list ──
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

// ── PSC Results list ──
function renderPscResults(container, results, mode) {
  container.innerHTML = "";
  if (!results.length) {
    container.innerHTML = '<div class="ch-result-count">No matches found</div>';
    return;
  }

  if (mode === "person") {
    // Group by person name, show their companies
    const el = document.createElement("div");
    el.className = "ch-result-count";
    el.textContent = `${results.length} match${results.length === 1 ? "" : "es"}`;
    container.appendChild(el);

    // Group results by name (exact match)
    const byName = {};
    for (const r of results) {
      const key = r.n;
      if (!byName[key]) byName[key] = [];
      byName[key].push(r.c);
    }

    let shown = 0;
    for (const [name, companies] of Object.entries(byName)) {
      if (shown >= MAX_VISIBLE) break;
      const item = document.createElement("div");
      item.className = "ch-result-item psc-person-item";
      const coList = companies.slice(0, 5).map(c => `#${escapeHtml(c)}`).join(", ");
      const extra = companies.length > 5 ? ` +${companies.length - 5} more` : "";
      item.innerHTML =
        `<div class="ch-r-name psc-person-name">${escapeHtml(name)}</div>` +
        `<div class="ch-r-detail">${escapeHtml(companies.length + " compan" + (companies.length === 1 ? "y" : "ies"))}: ${coList}${extra}</div>`;
      item.addEventListener("click", () => lookupAndPlotCompanies(companies));
      container.appendChild(item);
      shown++;
    }
  } else if (mode === "company_psc") {
    // Show PSC records for a company
    const el = document.createElement("div");
    el.className = "ch-result-count";
    el.textContent = `${results.length} PSC record${results.length === 1 ? "" : "s"}`;
    container.appendChild(el);

    for (const r of results) {
      const item = document.createElement("div");
      item.className = "ch-result-item psc-record-item";
      const kind = r.k === "I" ? "Individual" : "Corporate";
      const natures = (r.t || []).join(", ");
      const dob = r.b ? ` &middot; DOB: ${escapeHtml(r.b)}` : "";
      item.innerHTML =
        `<div class="ch-r-name">${escapeHtml(r.n)}</div>` +
        `<div class="ch-r-detail"><span class="popup-tag psc-tag-${r.k === "I" ? "individual" : "corporate"}">${kind}</span> &middot; Co: #${escapeHtml(r.c)}${dob}</div>` +
        (natures ? `<div class="ch-r-detail psc-natures">${escapeHtml(natures)}</div>` : "");
      // Click person to search for them across all companies
      item.addEventListener("click", () => {
        document.getElementById("psc_name").value = r.n;
        document.getElementById("psc_company").value = "";
        runPscSearch();
      });
      container.appendChild(item);
    }
  }
}

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

// ── Live search ──
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

// ── Plot companies ──
async function plotCompanies(rows, clearFirst = false) {
  if (clearFirst) layers.companies.clearLayers();
  if (!rows.length) { setStatus("No companies to plot"); return; }
  setStatus(`Plotting ${rows.length} compan${rows.length===1?"y":"ies"}...`);
  await ensurePostcodesForRows(rows);
  let plotted = 0;
  for (const r of rows) {
    const raw = r["RegAddress.PostCode"]; if (!raw) continue;
    const pc = raw.toUpperCase().replace(/[^A-Z0-9]/g, ""); if (!pc) continue;
    const co = lookupPostcode(pc); if (!co) continue;

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
      `<button class="popup-psc-btn" onclick="downloadCompanyProfile('${coNum}', '${companyName.replace(/'/g, "\\'")}')">Profile PDF</button>` +
      `<button class="popup-psc-btn" onclick="downloadFilingHistory('${coNum}', '${companyName.replace(/'/g, "\\'")}')">Filings PDF</button>` +
      `</div>`;

    // Use custom icon or circle marker
    const useCircle = window._useCircleMarkers !== false;
    const marker = createCustomMarker([co.lat, co.lon], 'company', 'standard', useCircle);
    marker.bindPopup(popup).addTo(layers.companies);
    
    // Add click handler to highlight connections
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      highlightConnections(marker.getLatLng());
    });
    
    plotted++;
  }
  if (plotted) {
    if (!map.hasLayer(layers.companies)) {
      layers.companies.addTo(map);
      const cb = document.querySelector('[data-layer="companies"]');
      if (cb) cb.checked = true;
    }
    map.fitBounds(layers.companies.getBounds(), { padding: [40, 40] });
    setStatus(`${plotted} compan${plotted===1?"y":"ies"} plotted`);
  } else {
    setStatus(`No geocodable postcodes in ${rows.length} results`);
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
    
    // Lookup coordinates
    const pc = postcode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const area = postcodeArea(pc);
    await loadPostcodeArea(area);
    const coords = lookupPostcode(pc);
    
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
        <button class="popup-psc-btn" onclick="downloadCompanyProfile('${escapeHtml(companyNumber)}', '${escapeHtml(companyName).replace(/'/g, "\\'")}')">Profile PDF</button>
        <button class="popup-psc-btn" onclick="downloadFilingHistory('${escapeHtml(companyNumber)}', '${escapeHtml(companyName).replace(/'/g, "\\'")}')">Filings PDF</button>
      </div>
    `;
    
    const companyLatLng = [coords.lat, coords.lon];
    
    const useCircle = window._useCircleMarkers !== false;
    const marker = createCustomMarker(companyLatLng, 'company', 'api', useCircle);
    marker.bindPopup(popup).addTo(layers.companies);
    
    // Add click handler to highlight connections
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      highlightConnections(marker.getLatLng());
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
      const label = appointedOn ? `${role} since ${appointedOn}` : role;
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
async function addPersonToMap(officerName, address, companies = []) {
  if (!address || !address.postal_code) {
    alert('Officer has no valid address with postcode');
    return;
  }
  
  setStatus(`Adding ${officerName} to map...`);
  
  try {
    const postcode = address.postal_code;
    const pc = postcode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const area = postcodeArea(pc);
    await loadPostcodeArea(area);
    const coords = lookupPostcode(pc);
    
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
    
    // Create marker popup
    const popup = `
      <strong>${escapeHtml(officerName)}</strong>
      <span class="popup-label">Type</span> <span class="popup-tag" style="background:rgba(167,139,250,0.15); color:#c4b5fd; border:1px solid rgba(167,139,250,0.3);">Person/Officer</span><br>
      <span class="popup-label">Address</span> ${escapeHtml(addrString)}
      ${companies.length > 0 ? `<br><span class="popup-label">${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}</span>` : ''}
    `;
    
    const personLatLng = [coords.lat, coords.lon];
    
    const useCircle = window._useCircleMarkers !== false;
    const marker = createCustomMarker(personLatLng, 'person', 'officer', useCircle);
    marker.bindPopup(popup).addTo(layers.companies);
    
    // Add click handler to highlight connections
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      highlightConnections(marker.getLatLng());
    });
    
    // Store person data on marker
    marker._personData = { name: officerName, companies: companies, latLng: personLatLng };
    
    // Ensure layer is visible
    if (!map.hasLayer(layers.companies)) {
      layers.companies.addTo(map);
      const cb = document.querySelector('[data-layer="companies"]');
      if (cb) cb.checked = true;
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

// ══════════════════════════════════════════════════════
// API-BASED SEARCH (REPLACES LOCAL FILE SEARCH)
// ══════════════════════════════════════════════════════

async function searchCompaniesViaAPI(criteria, limit = 100) {
  // Primary search by company name or number
  const nameQuery = criteria.name?.trim() || "";
  const numberQuery = criteria.number?.trim() || "";
  const postcodeFilter = criteria.postcode?.trim().toLowerCase() || "";
  const townFilter = criteria.town?.trim().toLowerCase() || "";
  
  const query = nameQuery || numberQuery;
  if (!query || query.length < 2) {
    return [];
  }
  
try {
    // Build endpoint
    const endpoint = `/search/companies?q=${encodeURIComponent(query)}&items_per_page=${limit}`;

    // Encode API key for Basic Auth
    const auth = btoa(window.CH_API_KEY + ":");

    const response = await fetch(
        "https://api.company-information.service.gov.uk" + endpoint,
        {
            headers: {
                "Authorization": "Basic " + auth,
                "Accept": "application/json"
            }
        }
    );

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

    // Apply local filters
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

    if (statusFilter) {
        results = results.filter(r =>
            r.CompanyStatus.toLowerCase().includes(statusFilter)
        );
    }

    if (sicFilter) {
        results = results.filter(r =>
            r._rawSicCodes.some(sic => sic.includes(sicFilter))
        );
    }

    return results;

} catch (err) {
    console.error("API search error:", err);
    return [];
}

}

// ── Clear ──
function clearAll() {
  _searchAbort = true;
  if (confirm('Clear all companies from map?')) {
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

// ── PSC Search handler (NOW USES API) ──
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
        card.dataset.officerId = officer.links?.self || '';
        card.dataset.officerName = officer.title || officer.name || 'Unknown';
        card.dataset.officerAddress = JSON.stringify(officer.address || {});
        
        card.innerHTML = `
          <div class="ch-r-name">${escapeHtml(officer.title || officer.name || 'Unknown')} <span class="expand-icon">▶</span></div>
          <div class="ch-r-detail">
            ${officer.appointment_count ? `${officer.appointment_count} appointment${officer.appointment_count === 1 ? '' : 's'}` : ''}
            ${officer.date_of_birth ? ` • Born ${officer.date_of_birth.month}/${officer.date_of_birth.year}` : ''}
            ${officer.address_snippet ? `<br>${escapeHtml(officer.address_snippet)}` : ''}
          </div>
          ${officer.address?.postal_code ? `<button class="btn-add-company btn-sm" style="margin-top: 6px;" onclick='event.stopPropagation(); addPersonToMap("${escapeHtml(officer.title || officer.name || 'Unknown').replace(/"/g, '&quot;')}", ${JSON.stringify(officer.address)}, [])'>📍 Add Person to Map</button>` : ''}
          <div class="officer-companies" style="display: none;">
            <div class="officer-loading">Loading appointments...</div>
          </div>
        `;
        
        // Click handler to expand/collapse
        card.addEventListener('click', async (e) => {
          if (e.target.closest('.btn-add-company')) return; // Don't trigger if clicking add button
          
          const companiesDiv = card.querySelector('.officer-companies');
          const expandIcon = card.querySelector('.expand-icon');
          const isExpanded = companiesDiv.style.display !== 'none';
          
          if (isExpanded) {
            companiesDiv.style.display = 'none';
            expandIcon.textContent = '▶';
          } else {
            companiesDiv.style.display = 'block';
            expandIcon.textContent = '▼';
            
            // Fetch appointments if not already loaded
            if (!companiesDiv.dataset.loaded) {
              // Extract officer ID from links.self format: /officers/{officer_id}/appointments
              const parts = card.dataset.officerId.split('/');
              const officerId = parts[parts.length - 2]; // Get the ID (second-to-last element)
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
                      ${appt.officer_role ? ` • ${escapeHtml(appt.officer_role)}` : ''}
                      ${appt.appointed_on ? ` • Since ${appt.appointed_on}` : ''}
                    </div>
                    <button class="btn-add-company btn-sm" 
                            data-company-number="${escapeHtml(appt.appointed_to?.company_number || '')}"
                            data-company-name="${escapeHtml(appt.appointed_to?.company_name || '')}"
                            data-officer-name="${card.dataset.officerName}"
                            data-officer-role="${escapeHtml(appt.officer_role || 'officer')}"
                            data-appointed-on="${escapeHtml(appt.appointed_on || '')}">
                      ➕ Add to Map
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
                    let personLatLng = null;
                    
                    if (officerAddress && officerAddress.postal_code) {
                      const personResult = await addPersonToMap(officerName, officerAddress, [companyName]);
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

// ══════════════════════════════════════════════════════
// BOOTSTRAP
// ══════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", async () => {
  setStatus("Initializing...");
  // Only load company index for compatibility (not used for search anymore)
  await loadCompaniesHouseIndex().catch(() => console.log('Legacy company index not loaded'));

  setStatus(`Ready — Live API search enabled ✓`);
  
  // Initialize entity selector
  initializeEntitySelector();
  
  // Entity placement panel handlers
  const entityCategorySelect = document.getElementById('entity-category');
  const entityIconSelect = document.getElementById('entity-icon');
  const entityLabelInput = document.getElementById('entity-label');
  const entityForm = document.getElementById('entity-placement-form');
  const entityPanelClose = document.getElementById('entity-panel-close');
  const entityCancelBtn = document.getElementById('entity-cancel-btn');
  
  // Category change handler
  entityCategorySelect?.addEventListener('change', (e) => {
    const category = e.target.value;
    updateIconDropdown(category);
    
    // Try to auto-suggest icon based on label
    const label = entityLabelInput.value;
    if (label && category) {
      const suggested = suggestIcon(label, category);
      if (suggested) {
        const icons = ICON_CATEGORIES[category].icons;
        const index = icons.findIndex(icon => icon.name === suggested.name);
        if (index >= 0) {
          entityIconSelect.value = index;
        }
      }
    }
  });
  
  // Label input handler - auto-suggest icon
  entityLabelInput?.addEventListener('input', (e) => {
    const label = e.target.value;
    const category = entityCategorySelect.value;
    
    if (label && category) {
      const suggested = suggestIcon(label, category);
      if (suggested) {
        const icons = ICON_CATEGORIES[category].icons;
        const index = icons.findIndex(icon => icon.name === suggested.name);
        if (index >= 0) {
          entityIconSelect.value = index;
        }
      }
    }
  });
  
  // Form submission handler
  entityForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const label = entityLabelInput.value.trim();
    const categoryKey = entityCategorySelect.value;
    const iconIndex = parseInt(entityIconSelect.value);
    const address = document.getElementById('entity-address').value.trim();
    const notes = document.getElementById('entity-notes').value.trim();
    const latLng = window._pendingEntityLatLng;
    
    if (!label || !categoryKey || isNaN(iconIndex) || !latLng) {
      alert('Please fill in all required fields');
      return;
    }
    
    const category = ICON_CATEGORIES[categoryKey];
    const iconData = {...category.icons[iconIndex]};
    iconData.categoryColor = category.color;
    iconData.categoryName = category.name;
    
    // Place the entity
    placeEntity(latLng, iconData, label, address, notes);
    map.panTo(latLng);
    
    // Close panel
    closeEntityPanel();
    
    setStatus(`Placed: ${label}`);
  });
  
  // Close button handlers
  entityPanelClose?.addEventListener('click', closeEntityPanel);
  entityCancelBtn?.addEventListener('click', closeEntityPanel);

  const resultsDiv = document.getElementById("ch_results");
  const pscResultsDiv = document.getElementById("psc_results");
  const btn        = document.getElementById("ch_search");
  const clearBtn   = document.getElementById("ch_clear");
  const pscBtn     = document.getElementById("psc_search");
  const pscClearBtn = document.getElementById("psc_clear");
  const toggleBtn  = document.getElementById("cp-toggle");
  const body       = document.getElementById("cp-body");
  const inputs = ["ch_name","ch_number","ch_postcode","ch_town"]
    .map(id => document.getElementById(id)).filter(Boolean);
  const pscInputs = ["psc_name","psc_company"]
    .map(id => document.getElementById(id)).filter(Boolean);

  // ── Panel collapse ──
  toggleBtn?.addEventListener("click", () => {
    body.classList.toggle("collapsed");
    toggleBtn.textContent = body.classList.contains("collapsed") ? "+" : "\u2212";
  });

  // ── Tabs ──
  document.querySelectorAll(".cp-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".cp-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".cp-tab-pane").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab)?.classList.add("active");
    });
  });

  // ── Base layer pills ──
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

  // ── Overlay toggles ──
  document.querySelectorAll(".layer-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const layer = layers[cb.dataset.layer];
      if (!layer) return;
      if (cb.checked) { layer.addTo(map); }
      else { map.removeLayer(layer); }
    });
  });

  // ── Live company search DISABLED (now using API on button click) ──
  // const debouncedSearch = debounce(() => liveSearch(resultsDiv), 300);
  // inputs.forEach(input => input.addEventListener("input", debouncedSearch));

  // ── Full company search (NOW USES API) ──
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
        await plotCompanies(matches);
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

  // ── Clear company ──
  clearBtn?.addEventListener("click", clearAll);

  // ── PSC search ──
  pscBtn?.addEventListener("click", runPscSearch);
  pscInputs.forEach(input => input.addEventListener("keydown", e => { if (e.key === "Enter") runPscSearch(); }));

  // ── Clear PSC ──
  pscClearBtn?.addEventListener("click", clearPsc);
});
