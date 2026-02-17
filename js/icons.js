// ================== icons.js ==================
// Custom map icon configuration

const CUSTOM_ICONS = {
  // Company/Business markers
  company: {
    standard: L.icon({
      iconUrl: 'gfx/map_icons/buildings/building.png',
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -28]
    }),
    api: L.icon({
      iconUrl: 'gfx/map_icons/buildings/building.png',
      iconSize: [30, 30],
      iconAnchor: [15, 30],
      popupAnchor: [0, -30]
    }),
    large: L.icon({
      iconUrl: 'gfx/map_icons/buildings/building.png',
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -32]
    })
  },
  
  // People/Person markers
  person: {
    male: L.icon({
      iconUrl: 'gfx/map_icons/people/man.png',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -26]
    }),
    female: L.icon({
      iconUrl: 'gfx/map_icons/people/woman.png',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -26]
    }),
    business: L.icon({
      iconUrl: 'gfx/map_icons/people/businessman.png',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -26]
    }),
    professional: L.icon({
      iconUrl: 'gfx/map_icons/people/lawyer.png',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -26]
    })
  },
  
  // Fallback circle markers (used when icon loading fails)
  circle: {
    company: {
      radius: 7,
      color: '#c4b5fd',
      fillColor: '#a78bfa',
      fillOpacity: 0.9,
      weight: 2,
      className: 'company-circle-marker'
    },
    companyAPI: {
      radius: 8,
      color: '#4ade80',
      fillColor: '#22c55e',
      fillOpacity: 0.9,
      weight: 2,
      className: 'company-api-circle-marker'
    },
    person: {
      radius: 6,
      color: '#fbbf24',
      fillColor: '#f59e0b',
      fillOpacity: 0.9,
      weight: 2,
      className: 'person-circle-marker'
    }
  }
};

// Helper function to create marker with icon fallback
function createCustomMarker(latLng, iconType, iconVariant = 'standard', useCircle = false) {
  if (useCircle || !CUSTOM_ICONS[iconType] || !CUSTOM_ICONS[iconType][iconVariant]) {
    // Fallback to circle marker
    const circleKey = iconType === 'company' && iconVariant === 'api' ? 'companyAPI' : iconType;
    const options = CUSTOM_ICONS.circle[circleKey] || CUSTOM_ICONS.circle.company;
    return L.circleMarker(latLng, options);
  }
  
  try {
    const icon = CUSTOM_ICONS[iconType][iconVariant];
    return L.marker(latLng, { icon: icon });
  } catch (e) {
    console.warn('Icon creation failed, using circle marker:', e);
    const circleKey = iconType === 'company' && iconVariant === 'api' ? 'companyAPI' : iconType;
    const options = CUSTOM_ICONS.circle[circleKey] || CUSTOM_ICONS.circle.company;
    return L.circleMarker(latLng, options);
  }
}

// Icon availability check (call this on page load)
function checkIconAvailability() {
  const testImg = new Image();
  testImg.onerror = function() {
    console.warn('Custom icons not available, using circle markers');
    window._useCircleMarkers = true;
  };
  testImg.onload = function() {
    console.log('✓ Custom icons loaded');
    window._useCircleMarkers = false;
  };
  testImg.src = 'gfx/map_icons/buildings/building.png';
}

// Auto-check on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkIconAvailability);
} else {
  checkIconAvailability();
}

// Bridge: createCustomMarker can use IconSystem when available
function createCustomMarkerMaki(latLng, entityType) {
  if (window.IconSystem) {
    var icon = window.IconSystem.resolveEntityIconSync({ type: entityType, attributes: {} });
    if (icon) return L.marker(latLng, { icon: icon });
  }
  return createCustomMarker(latLng, entityType === "organisation" ? "company" : entityType);
}
