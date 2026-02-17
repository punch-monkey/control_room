// ================== entity_renderer.js ==================
// Entity rendering bridge — EntityStore ↔ Leaflet markers
// Listens to EntityStore events and creates/removes/updates map markers.
// Provides upgraded entity placement that routes through EntityStore.
(function () {
  "use strict";

  // References filled on init (after map.js has loaded)
  let _map = null;
  let _entitiesCluster = null;
  let _connectionsLayer = null;
  let _initialized = false;

  // ── Initialise with map references ──
  function init(map, entitiesCluster, connectionsLayer) {
    if (_initialized) return;
    _map = map;
    _entitiesCluster = entitiesCluster;
    _connectionsLayer = connectionsLayer;
    _initialized = true;

    // Listen for EntityStore events
    if (window.EntityStore) {
      window.EntityStore.on("entity:added", _onEntityAdded);
      window.EntityStore.on("entity:removed", _onEntityRemoved);
      window.EntityStore.on("entity:updated", _onEntityUpdated);
      window.EntityStore.on("relationship:added", _onRelationshipAdded);
      window.EntityStore.on("relationship:removed", _onRelationshipRemoved);
      window.EntityStore.on("store:cleared", _onStoreCleared);
    }

    // Sync any legacy entities already placed before init
    _syncLegacyToStore();
  }

  // ── Import existing window._mapEntities into EntityStore (one-time) ──
  function _syncLegacyToStore() {
    if (!window.EntityStore || !Array.isArray(window._mapEntities)) return;
    // Only sync if store is empty and legacy has entities
    if (window.EntityStore.getAll().length > 0 || window._mapEntities.length === 0) return;
    window.EntityStore._syncFromLegacy();
  }

  // ── Map legacy iconData category to EntityStore type ──
  function _inferEntityType(iconData, sourceType, i2EntityData) {
    if (sourceType === "company") return "organisation";
    if (sourceType === "officer") return "person";

    const i2Name = String(i2EntityData?.entityName || "").toLowerCase();
    if (i2Name.includes("person")) return "person";
    if (i2Name.includes("vehicle")) return "vehicle";
    if (i2Name.includes("organisation") || i2Name.includes("company")) return "organisation";
    if (i2Name.includes("phone") || i2Name.includes("telephone")) return "phone";
    if (i2Name.includes("aircraft")) return "aircraft";
    if (i2Name.includes("location") || i2Name.includes("address")) return "location";
    if (i2Name.includes("vessel") || i2Name.includes("ship")) return "vessel";

    const catName = String(iconData?.categoryName || iconData?.name || "").toLowerCase();
    if (catName.includes("people") || catName.includes("person")) return "person";
    if (catName.includes("vehicle") || catName.includes("car")) return "vehicle";
    if (catName.includes("building") || catName.includes("organisation")) return "organisation";
    if (catName.includes("phone") || catName.includes("mobile")) return "phone";
    if (catName.includes("email")) return "email";
    if (catName.includes("aviation") || catName.includes("aircraft")) return "aircraft";

    return "location";
  }

  // ── Extract attributes from legacy entity data ──
  function _extractAttributes(entity) {
    var attrs = {};
    if (entity.address) attrs.address = entity.address;
    if (entity.notes) attrs.notes = entity.notes;
    if (entity.dob) attrs.dob = entity.dob;
    if (entity.nationality) attrs.nationality = entity.nationality;
    if (entity.countryOfResidence) attrs.countryOfResidence = entity.countryOfResidence;
    if (entity.officerId) attrs.officerId = entity.officerId;
    if (entity.officerRole) attrs.officerRole = entity.officerRole;
    if (entity.companyName) attrs.companyName = entity.companyName;
    if (entity.companyNumber) attrs.companyNumber = entity.companyNumber;

    // Extract from i2 values
    var values = entity.i2EntityData?.values;
    if (Array.isArray(values)) {
      values.forEach(function (v) {
        if (!v?.propertyName) return;
        var key = String(v.propertyName).replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
        if (key && v.value != null && !attrs[key]) attrs[key] = String(v.value);
      });
    }
    return attrs;
  }

  // ── Create marker icon using IconSystem or legacy ──
  async function createEntityMarkerIconAsync(entity) {
    if (window.IconSystem) {
      var storeEntity = {
        type: entity._storeType || _inferEntityType(entity.iconData, entity.sourceType, entity.i2EntityData),
        iconOverride: null,
        attributes: {}
      };
      return window.IconSystem.resolveEntityIcon(storeEntity);
    }
    // Legacy fallback
    if (typeof window.createEntityMarkerIcon === "function") {
      return window.createEntityMarkerIcon(entity.iconData, entity.i2EntityData);
    }
    return L.icon({ iconUrl: entity.iconData?.icon || "gfx/map_icons/buildings/building.png", iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16] });
  }

  // ── Synchronous icon creation (uses cache) ──
  function createEntityMarkerIconSync(entityType, iconData, i2EntityData) {
    if (window.IconSystem) {
      return window.IconSystem.resolveEntityIconSync({ type: entityType, attributes: {} });
    }
    if (typeof window.createEntityMarkerIcon === "function") {
      return window.createEntityMarkerIcon(iconData, i2EntityData);
    }
    return L.icon({ iconUrl: iconData?.icon || "gfx/map_icons/buildings/building.png", iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -16] });
  }

  // ── Place entity through EntityStore (new path) ──
  // Returns entityId. This is the preferred way to place entities going forward.
  function placeEntityViaStore(type, label, latLng, attributes, source, i2EntityData, iconOverride) {
    if (!window.EntityStore) return null;

    var coords = _normalizeLatLng(latLng);
    if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;

    var entityId = window.EntityStore.addEntity({
      type: type || "location",
      label: label || "Entity",
      latLng: coords,
      attributes: attributes || {},
      source: source || null,
      i2EntityData: i2EntityData || null,
      iconOverride: iconOverride || null
    });

    return entityId;
  }

  // ── Remove entity through EntityStore ──
  function removeEntityViaStore(entityId) {
    if (!window.EntityStore) return false;
    return window.EntityStore.removeEntity(entityId);
  }

  // ── EntityStore event handlers ──

  function _onEntityAdded(entity) {
    if (!_map || !_entitiesCluster) return;
    if (entity._marker) return; // Already has a marker

    var icon = createEntityMarkerIconSync(entity.type, null, entity.i2EntityData);
    var marker = L.marker(entity.latLng, { icon: icon, draggable: true });

    marker._entityId = entity.id;
    marker._storeManaged = true;

    // Build popup
    var popupHtml = buildStoreEntityPopup(entity);
    marker.bindPopup(popupHtml);

    // Hover tooltip
    _bindStoreEntityTooltip(marker, entity);

    // Drag handler
    marker.on("dragend", function () {
      var next = marker.getLatLng();
      var newLatLng = [Number(next.lat), Number(next.lng)];
      if (window.EntityStore) {
        window.EntityStore.updateEntity(entity.id, { latLng: newLatLng });
      }
      marker.setPopupContent(buildStoreEntityPopup(window.EntityStore.getEntity(entity.id) || entity));
      if (typeof window.refreshConnectionsForEntity === "function") {
        window.refreshConnectionsForEntity(entity.id);
      }
    });

    // Click handler for connections
    marker.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
      if (window.connectionDrawingMode && window.connectionDrawingMode.fromId !== entity.id) {
        if (typeof window.completeConnection === "function") window.completeConnection(entity.id);
        return;
      }
      if (typeof window.highlightConnections === "function") window.highlightConnections(marker.getLatLng());
    });

    // Context menu
    marker.on("contextmenu", function (e) {
      if (typeof window.showEntityContextMenu === "function") {
        window.showEntityContextMenu(e.originalEvent, entity.id);
      }
    });

    marker.addTo(_entitiesCluster);
    marker.openPopup();

    // Store marker reference back on the entity
    entity._marker = marker;
    entity._visible = true;

    // Update dashboard
    if (typeof window.updateDashboardCounts === "function") window.updateDashboardCounts();
    if (window.CRDashboard) window.CRDashboard.logActivity("Entity placed", entity.label || "entity", "entity");
  }

  function _onEntityRemoved(entity) {
    if (!_entitiesCluster) return;
    if (entity._marker) {
      _entitiesCluster.removeLayer(entity._marker);
      entity._marker = null;
    }
    if (window._selectedEntityIds) window._selectedEntityIds.delete(entity.id);
    if (typeof window.updateDashboardCounts === "function") window.updateDashboardCounts();
    if (window.CRDashboard) window.CRDashboard.logActivity("Entity removed", entity.label || entity.id, "entity");
  }

  function _onEntityUpdated(entity) {
    if (!entity._marker) return;
    // Update marker position if changed
    var markerPos = entity._marker.getLatLng();
    if (entity.latLng && (Math.abs(markerPos.lat - entity.latLng[0]) > 0.000001 || Math.abs(markerPos.lng - entity.latLng[1]) > 0.000001)) {
      entity._marker.setLatLng(entity.latLng);
    }
    // Update popup
    entity._marker.setPopupContent(buildStoreEntityPopup(entity));
    _bindStoreEntityTooltip(entity._marker, entity);
  }

  function _onRelationshipAdded(rel) {
    if (!_map || !_connectionsLayer) return;
    if (rel._line) return; // Already rendered

    var fromEntity = window.EntityStore.getEntity(rel.fromId);
    var toEntity = window.EntityStore.getEntity(rel.toId);
    if (!fromEntity?.latLng || !toEntity?.latLng) return;

    var relType = window.EntityStore.RELATIONSHIP_TYPES[rel.type];
    var color = relType?.color || "#64748b";

    var polyline = L.polyline([fromEntity.latLng, toEntity.latLng], {
      color: color,
      weight: 3,
      opacity: 0.7,
      dashArray: rel.type === "associated_with" ? "8, 4" : "5, 5"
    }).addTo(_connectionsLayer);

    polyline.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
      if (typeof window.showConnectionPopup === "function") {
        window.showConnectionPopup(e.latlng, rel.id, rel.label || rel.type, {
          fromId: rel.fromId,
          toId: rel.toId,
          fromLabel: fromEntity.label,
          toLabel: toEntity.label
        });
      }
    });

    rel._line = polyline;

    // Label at midpoint
    if (rel.label || rel.type) {
      var midLat = (fromEntity.latLng[0] + toEntity.latLng[0]) / 2;
      var midLng = (fromEntity.latLng[1] + toEntity.latLng[1]) / 2;
      var displayLabel = rel.label || (relType?.label || rel.type).replace(/_/g, " ");
      var labelIcon = L.divIcon({
        className: "connection-label",
        html: '<div class="connection-label-text">' + _escapeHtml(displayLabel) + '</div>',
        iconSize: [150, 30],
        iconAnchor: [75, 15]
      });
      rel._labelMarker = L.marker([midLat, midLng], { icon: labelIcon }).addTo(_connectionsLayer);
    }

    if (typeof window.updateDashboardCounts === "function") window.updateDashboardCounts();
  }

  function _onRelationshipRemoved(rel) {
    if (!_connectionsLayer) return;
    if (rel._line) {
      _connectionsLayer.removeLayer(rel._line);
      rel._line = null;
    }
    if (rel._labelMarker) {
      _connectionsLayer.removeLayer(rel._labelMarker);
      rel._labelMarker = null;
    }
    if (typeof window.updateDashboardCounts === "function") window.updateDashboardCounts();
  }

  function _onStoreCleared() {
    if (_entitiesCluster) _entitiesCluster.clearLayers();
    if (typeof window.updateDashboardCounts === "function") window.updateDashboardCounts();
  }

  // ── Build popup HTML for an EntityStore entity ──
  function buildStoreEntityPopup(entity) {
    if (!entity) return "";
    var type = entity.type || "location";
    var typeDef = window.EntityStore?.ENTITY_TYPES?.[type];
    var color = typeDef?.color || "#64748b";
    var typeLabel = typeDef?.label || type;
    var attrs = entity.attributes || {};

    var html = '<strong>' + _escapeHtml(entity.label || "Entity") + '</strong>';

    // Type badge
    html += ' <span class="popup-tag" style="background:' + color + '">' + _escapeHtml(typeLabel) + '</span><br>';

    // Key attributes based on entity type
    if (type === "person") {
      if (attrs.dob) html += '<span class="popup-label">DOB</span> ' + _escapeHtml(attrs.dob) + '<br>';
      if (attrs.nationality) html += '<span class="popup-label">Nationality</span> ' + _escapeHtml(attrs.nationality) + '<br>';
      if (attrs.officerRole) html += '<span class="popup-label">Role</span> ' + _escapeHtml(attrs.officerRole) + '<br>';
    } else if (type === "vehicle") {
      if (attrs.vrm) html += '<span class="popup-label">VRM</span> ' + _escapeHtml(attrs.vrm) + '<br>';
      if (attrs.Vehicle_Make) html += '<span class="popup-label">Make</span> ' + _escapeHtml(attrs.Vehicle_Make) + '<br>';
      if (attrs.Vehicle_Model) html += '<span class="popup-label">Model</span> ' + _escapeHtml(attrs.Vehicle_Model) + '<br>';
    } else if (type === "organisation") {
      if (attrs.companyNumber) html += '<span class="popup-label">Company #</span> ' + _escapeHtml(attrs.companyNumber) + '<br>';
      if (attrs.Status) html += '<span class="popup-label">Status</span> ' + _escapeHtml(attrs.Status) + '<br>';
    } else if (type === "phone") {
      if (attrs.number) html += '<span class="popup-label">Number</span> ' + _escapeHtml(attrs.number) + '<br>';
    } else if (type === "vessel") {
      if (attrs.mmsi) html += '<span class="popup-label">MMSI</span> ' + _escapeHtml(attrs.mmsi) + '<br>';
      if (attrs.imo) html += '<span class="popup-label">IMO</span> ' + _escapeHtml(attrs.imo) + '<br>';
      if (attrs.vesselType) html += '<span class="popup-label">Type</span> ' + _escapeHtml(attrs.vesselType) + '<br>';
    }

    // Address and notes
    if (attrs.address) html += '<span class="popup-label">Address</span> ' + _escapeHtml(attrs.address) + '<br>';
    if (attrs.notes) html += '<span class="popup-label">Notes</span> ' + _escapeHtml(attrs.notes).replace(/\n/g, '<br>') + '<br>';

    // Coordinates
    if (entity.latLng) {
      html += '<span class="popup-label">Lat/Lng</span> ' + entity.latLng[0].toFixed(5) + ', ' + entity.latLng[1].toFixed(5);
    }

    // i2 data summary
    if (entity.i2EntityData && typeof window.formatI2EntitySummary === "function") {
      html += window.formatI2EntitySummary(entity.i2EntityData);
    }

    // Source provenance
    if (entity.source) {
      html += '<br><span class="popup-label">Source</span> ';
      if (entity.source.documentId) {
        var doc = window.EntityStore?.getEntity(entity.source.documentId);
        html += '<span class="popup-tag" style="background:#475569">' + _escapeHtml(doc?.label || entity.source.documentId) + '</span>';
      }
      if (entity.source.method) html += ' <span style="color:#94a3b8;font-size:0.8em">[' + _escapeHtml(entity.source.method) + ']</span>';
      if (entity.source.confidence) html += ' <span style="color:#94a3b8;font-size:0.8em">(' + entity.source.confidence + ')</span>';
    }

    // Action buttons
    html += '<div class="popup-btn-row">';
    html += '<button class="popup-psc-btn" onclick="editEntity(\'' + entity.id + '\')">Edit</button>';
    html += '<button class="popup-psc-btn" onclick="drawConnectionFrom(\'' + entity.id + '\')">Connect</button>';
    if (entity.type === "person" && attrs.officerId) {
      html += '<button class="popup-psc-btn" onclick="expandOfficerCompanies(\'' + entity.id + '\')">Expand Companies</button>';
    }
    html += '<button class="popup-psc-btn" onclick="removeEntity(\'' + entity.id + '\')">Remove</button>';
    html += '</div>';

    return html;
  }

  // ── Tooltip for store entities ──
  function _bindStoreEntityTooltip(marker, entity) {
    if (!marker || !entity) return;
    var type = entity.type || "location";
    var typeDef = window.EntityStore?.ENTITY_TYPES?.[type];
    var typeLabel = typeDef?.label || type;
    var attrs = entity.attributes || {};

    var row1 = _escapeHtml(entity.label || "Entity");
    var row2 = _escapeHtml(typeLabel);
    var row3 = "";

    if (type === "person" && attrs.dob) {
      row2 = "DOB " + _escapeHtml(attrs.dob);
      if (attrs.nationality) row3 = "Nationality " + _escapeHtml(attrs.nationality);
    } else if (type === "organisation" && attrs.companyNumber) {
      row2 = "Company #" + _escapeHtml(attrs.companyNumber);
    } else if (type === "vehicle" && attrs.vrm) {
      row2 = "VRM " + _escapeHtml(attrs.vrm);
    }

    var html = '<div class="entity-hover-card"><strong>' + row1 + '</strong><br>' + row2 + (row3 ? '<br>' + row3 : '') + '</div>';

    marker.unbindTooltip();
    marker.bindTooltip(html, {
      direction: "bottom",
      offset: [0, 16],
      sticky: true,
      opacity: 0.95,
      className: "entity-hover-tooltip"
    });
  }

  // ── Upgrade icon for an existing entity to Maki SVG ──
  async function upgradeEntityIcon(entityId) {
    if (!window.EntityStore || !window.IconSystem) return;
    var entity = window.EntityStore.getEntity(entityId);
    if (!entity || !entity._marker) return;
    var icon = await window.IconSystem.resolveEntityIcon(entity);
    if (icon) entity._marker.setIcon(icon);
  }

  // ── Batch upgrade all entity icons to Maki ──
  async function upgradeAllEntityIcons() {
    if (!window.EntityStore || !window.IconSystem) return;
    var all = window.EntityStore.getAll();
    for (var i = 0; i < all.length; i++) {
      if (all[i]._marker) {
        var icon = await window.IconSystem.resolveEntityIcon(all[i]);
        if (icon) all[i]._marker.setIcon(icon);
      }
    }
  }

  // ── Get entity type colour ──
  function getTypeColor(type) {
    if (window.IconSystem) return window.IconSystem.getEntityTypeColor(type);
    var typeDef = window.EntityStore?.ENTITY_TYPES?.[type];
    return typeDef?.color || "#64748b";
  }

  // ── Utility: escape HTML ──
  function _escapeHtml(str) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(str);
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(String(str || "")));
    return div.innerHTML;
  }

  // ── Utility: normalize lat/lng ──
  function _normalizeLatLng(latLng) {
    if (Array.isArray(latLng) && latLng.length >= 2) return [Number(latLng[0]), Number(latLng[1])];
    if (latLng && typeof latLng === "object" && Number.isFinite(latLng.lat) && Number.isFinite(latLng.lng)) return [Number(latLng.lat), Number(latLng.lng)];
    return [NaN, NaN];
  }

  // ── Public API ──
  window.EntityRenderer = {
    init: init,
    placeEntityViaStore: placeEntityViaStore,
    removeEntityViaStore: removeEntityViaStore,
    buildStoreEntityPopup: buildStoreEntityPopup,
    createEntityMarkerIconAsync: createEntityMarkerIconAsync,
    createEntityMarkerIconSync: createEntityMarkerIconSync,
    upgradeEntityIcon: upgradeEntityIcon,
    upgradeAllEntityIcons: upgradeAllEntityIcons,
    getTypeColor: getTypeColor,
    inferEntityType: _inferEntityType,
    extractAttributes: _extractAttributes
  };

  // Also expose the aircraft icon creator for IconSystem
  window.createAircraftEntityDivIcon = window.createAircraftEntityDivIcon || function () {
    var svg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.6 0 1 .4 1 1v7.1l7.4 3.3c.5.2.8.7.7 1.2l-.3 1.4c-.1.6-.7 1-1.3.8l-6.5-1.7v3.9l2 1.5c.3.2.5.6.5 1v.8c0 .6-.5 1-1.1.9L12 22l-2.9.9c-.6.1-1.1-.3-1.1-.9v-.8c0-.4.2-.8.5-1l2-1.5v-3.9l-6.5 1.7c-.6.2-1.2-.2-1.3-.8l-.3-1.4c-.1-.5.2-1 .7-1.2L10.9 10.1V3c0-.6.4-1 1-1z"/></svg>';
    var html = '<div class="flight-icon flight-transit" style="--flight-icon-size:20px"><span class="flight-inner" style="transform:rotate(0deg)">' + svg + '</span></div>';
    return L.divIcon({
      className: "flight-marker entity-aircraft-marker",
      html: html,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      popupAnchor: [0, -14]
    });
  };

})();
