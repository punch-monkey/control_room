const CONTROL_ROOM_CONFIG = {
  map: {
    center: [54.5, -3.5],
    zoom: 6,
    minZoom: 3,
    maxZoom: 18
  },

  tiles: {
    dark: {
      name: "Dark",
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      options: { subdomains: "abcd", maxZoom: 20, className: "dark-tiles-boosted" }
    },
    grey: {
      name: "Grey",
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      options: { subdomains: "abcd", maxZoom: 20 }
    },
    street: {
      name: "Street",
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "&copy; OpenStreetMap contributors",
      options: { maxZoom: 19 }
    },
    satellite: {
      name: "Satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "&copy; Esri",
      options: { maxZoom: 18 }
    }
  },

  // Overlay display colours (used by layer dots + markers)
  layerColours: {
    areas:           "#818cf8",
    airports_uk:     "#38bdf8",
    airports_global: "#0284c7",
    seaports:        "#2dd4bf",
    underground:     "#f43f5e",
    national_rail:   "#38bdf8",
    roads:           "#f97316",
    flights:         "#f59e0b",
    bikes:           "#22c55e"
  },

  // FlightRadar-backed flight tracking
  flights: {
    refreshInterval: 480000,  // 8 minutes (stays within 200 req/day anonymous budget)
    bbox: { lamin: 35.0, lamax: 63.0, lomin: -15.0, lomax: 20.0 }  // UK + nearby overseas corridors
  },

  // Companies House API (direct browser calls with Basic Auth)
  companiesHouse: {
    baseUrl: "https://api.company-information.service.gov.uk",
    apiKey: window.CH_API_KEY || ""  // Set in js/api_keys.js (gitignored)
  },

  // TfL API
  tfl: {
    baseUrl: "https://api.tfl.gov.uk",
    statusRefresh: 60000,     // 60 seconds
    bikesRefresh: 300000,     // 5 minutes
    arrivalCache: 30000       // cache arrivals for 30s
  },

  // National Rail (RailData via local/worker proxy)
  nationalRail: {
    refreshInterval: 60000,
    defaultRows: 12
  },

  // National Highways WebTRIS traffic API (roads)
  webtris: {
    baseUrl: "https://webtris.highwaysengland.co.uk/api",
    version: "v1.0",
    refreshInterval: 300000, // 5 mins
    defaultWindowDays: 1,
    maxPlottedSites: 600
  }
};

