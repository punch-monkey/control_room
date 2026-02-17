// ================== icon_system.js ==================
// Unified intelligence icon system — Maki SVG + legacy PNG + circle fallback
(function () {
  "use strict";

  const MAKI_BASE = "gfx/map_icons/maki_mapbox_icons/mapbox-maki-28e2a36/icons";

  // ── SVG cache (loaded on demand, kept in memory) ──
  const _svgCache = {};
  let _preloadDone = false;

  // ── Entity type → default Maki icon mapping ──
  const ENTITY_ICON_MAP = {
    person:       { maki: "marker",      color: "#8b5cf6", fallbackPng: "gfx/map_icons/people/man.png" },
    vehicle:      { maki: "car",         color: "#f59e0b", fallbackPng: "gfx/map_icons/cars/car.png" },
    organisation: { maki: "building",    color: "#6366f1", fallbackPng: "gfx/map_icons/buildings/building.png" },
    location:     { maki: "marker",      color: "#22c55e", fallbackPng: "gfx/map_icons/buildings/building.png" },
    phone:        { maki: "telephone",   color: "#a855f7", fallbackPng: "gfx/map_icons/mobile_phone/mobile_phone.png" },
    email:        { maki: "post",        color: "#ec4899", fallbackPng: null },
    vessel:       { maki: "ferry",       color: "#06b6d4", fallbackPng: null },
    port:         { maki: "harbor",      color: "#14b8a6", fallbackPng: null },
    aircraft:     { maki: null,          color: "#38bdf8", fallbackPng: null },   // Uses existing flight SVG
    event:        { maki: "star",        color: "#ef4444", fallbackPng: null },
    document:     { maki: "library",     color: "#64748b", fallbackPng: null }
  };

  // ── Sub-type icon specialisations ──
  const ENTITY_SUBTYPE_ICONS = {
    "person.police":       "police",
    "person.doctor":       "doctor",
    "person.officer":      "marker",
    "location.home":       "home",
    "location.school":     "school",
    "location.hospital":   "hospital",
    "location.prison":     "prison",
    "location.church":     "place-of-worship",
    "location.park":       "park",
    "location.shop":       "shop",
    "location.restaurant": "restaurant",
    "location.hotel":      "lodging",
    "location.bar":        "bar",
    "location.office":     "commercial",
    "organisation.bank":   "bank",
    "organisation.shop":   "shop",
    "organisation.government": "town-hall",
    "vehicle.bus":         "bus",
    "vehicle.bicycle":     "bicycle",
    "vessel.ferry":        "ferry",
    "event.fire":          "fire-station",
    "event.crime":         "police",
    "event.accident":      "car",
    "event.explosion":     "explosive"
  };

  // ── All available Maki icon names for the icon picker ──
  const MAKI_ICON_NAMES = [
    "airport","alcohol-shop","amusement-park","aquarium","art-gallery","bakery","bank","bar",
    "baseball","basketball","beach","beer","bicycle","bicycle-share","blood-bank","bowling-alley",
    "bridge","building","building-alt1","bus","cafe","campsite","car","car-rental","car-repair",
    "casino","castle","cemetery","charging-station","cinema","circle","city","clothing-store",
    "college","commercial","communications-tower","confectionery","construction","convenience",
    "cricket","cross","dam","danger","defibrillator","dentist","doctor","dog-park","drinking-water",
    "embassy","entrance","farm","fast-food","fence","ferry","fire-station","fitness-centre",
    "florist","fuel","furniture","garden","garden-centre","globe","golf","grocery","hairdresser",
    "harbor","hardware","heart","heliport","home","horse-riding","hospital","ice-cream","industry",
    "information","jewelry-store","karaoke","landmark","laundry","library","lighthouse","lodging",
    "logging","marker","mobile-phone","monument","mountain","museum","music","natural","optician",
    "paint","park","parking","parking-garage","pharmacy","picnic-site","pitch","place-of-worship",
    "playground","police","post","prison","rail","rail-light","rail-metro","ranger-station",
    "recycling","religious-buddhist","religious-christian","religious-jewish","religious-muslim",
    "religious-shinto","restaurant","restaurant-noodle","restaurant-pizza","restaurant-seafood",
    "roadblock","rocket","school","scooter","shelter","shoe","shop","skateboard","skiing",
    "slaughterhouse","slipway","snowmobile","soccer","square","square-stroked","stadium","star",
    "suitcase","swimming","table-tennis","telephone","tennis","theatre","toilet","town-hall",
    "triangle","triangle-stroked","veterinary","volcano","volleyball","warehouse","waste-basket",
    "watch","water","waterfall","watermill","wetland","wheelchair","windmill","zoo"
  ];

  // ── Load a Maki SVG and cache it ──
  async function loadMakiSvg(iconName) {
    if (_svgCache[iconName] !== undefined) return _svgCache[iconName];
    try {
      const resp = await fetch(`${MAKI_BASE}/${iconName}.svg`);
      if (!resp.ok) { _svgCache[iconName] = null; return null; }
      const text = await resp.text();
      _svgCache[iconName] = text;
      return text;
    } catch (e) {
      _svgCache[iconName] = null;
      return null;
    }
  }

  // ── Pre-load the most common icons on startup ──
  function preloadCommonIcons() {
    if (_preloadDone) return;
    _preloadDone = true;
    const common = ["marker","building","car","telephone","ferry","harbor","star","library","post","police","bank","home","hospital"];
    common.forEach(name => loadMakiSvg(name));
  }

  // ── Create a Leaflet DivIcon from Maki SVG with colour tinting ──
  function createMakiDivIcon(svgText, color, size) {
    size = size || 28;
    // Inject fill colour into the SVG
    const coloured = svgText
      .replace(/<svg/, '<svg style="fill:' + color + ';width:' + (size - 8) + 'px;height:' + (size - 8) + 'px"')
      .replace(/width="\d+"/, '')
      .replace(/height="\d+"/, '');

    var html = '<div class="entity-maki-icon" style="' +
      'width:' + size + 'px;height:' + size + 'px;' +
      'background:rgba(0,0,0,0.55);border-radius:50%;' +
      'display:flex;align-items:center;justify-content:center;' +
      'border:2px solid ' + color + ';' +
      'box-shadow:0 0 6px ' + color + '40' +
      '">' + coloured + '</div>';

    return L.divIcon({
      className: "entity-maki-marker",
      html: html,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -(size / 2)]
    });
  }

  // ── Create circle fallback marker options ──
  function createCircleFallback(entityType) {
    var cfg = ENTITY_ICON_MAP[entityType] || ENTITY_ICON_MAP.location;
    return L.divIcon({
      className: "entity-circle-fallback",
      html: '<div style="width:14px;height:14px;border-radius:50%;background:' + cfg.color +
        ';border:2px solid #fff;box-shadow:0 0 4px ' + cfg.color + '80"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
      popupAnchor: [0, -7]
    });
  }

  // ── Resolve the best icon for an entity ──
  // Returns a Promise<L.Icon|L.DivIcon>
  async function resolveEntityIcon(entity) {
    if (!entity) return createCircleFallback("location");

    var typeDef = ENTITY_ICON_MAP[entity.type];
    if (!typeDef) return createCircleFallback(entity.type || "location");

    var color = typeDef.color;

    // Aircraft uses existing flight icon system
    if (entity.type === "aircraft") {
      if (typeof window.createAircraftEntityDivIcon === "function") {
        return window.createAircraftEntityDivIcon();
      }
      return createCircleFallback("aircraft");
    }

    // Check for icon override
    var overrideName = entity.iconOverride;
    if (overrideName) {
      var overrideSvg = await loadMakiSvg(overrideName);
      if (overrideSvg) return createMakiDivIcon(overrideSvg, color);
    }

    // Check for subtype specialisation
    var subtype = entity.attributes && entity.attributes.subtype;
    var subtypeKey = subtype ? (entity.type + "." + subtype) : null;
    var makiName = (subtypeKey && ENTITY_SUBTYPE_ICONS[subtypeKey]) || typeDef.maki;

    // Try Maki SVG
    if (makiName) {
      var svg = await loadMakiSvg(makiName);
      if (svg) return createMakiDivIcon(svg, color);
    }

    // Fallback to legacy PNG
    if (typeDef.fallbackPng) {
      return L.icon({
        iconUrl: typeDef.fallbackPng,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14]
      });
    }

    return createCircleFallback(entity.type);
  }

  // ── Synchronous best-effort icon (for when you can't await) ──
  function resolveEntityIconSync(entity) {
    if (!entity) return createCircleFallback("location");
    var typeDef = ENTITY_ICON_MAP[entity.type];
    if (!typeDef) return createCircleFallback(entity.type || "location");

    var color = typeDef.color;
    var makiName = typeDef.maki;
    if (makiName && _svgCache[makiName]) {
      return createMakiDivIcon(_svgCache[makiName], color);
    }
    if (typeDef.fallbackPng) {
      return L.icon({
        iconUrl: typeDef.fallbackPng,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14]
      });
    }
    return createCircleFallback(entity.type);
  }

  // ── Get colour for an entity type ──
  function getEntityTypeColor(type) {
    var cfg = ENTITY_ICON_MAP[type];
    return cfg ? cfg.color : "#64748b";
  }

  // ── Start preloading when DOM is ready ──
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", preloadCommonIcons);
  } else {
    preloadCommonIcons();
  }

  // ── Public API ──
  window.IconSystem = {
    resolveEntityIcon: resolveEntityIcon,
    resolveEntityIconSync: resolveEntityIconSync,
    createMakiDivIcon: createMakiDivIcon,
    createCircleFallback: createCircleFallback,
    loadMakiSvg: loadMakiSvg,
    getEntityTypeColor: getEntityTypeColor,
    ENTITY_ICON_MAP: ENTITY_ICON_MAP,
    ENTITY_SUBTYPE_ICONS: ENTITY_SUBTYPE_ICONS,
    MAKI_ICON_NAMES: MAKI_ICON_NAMES
  };

})();
