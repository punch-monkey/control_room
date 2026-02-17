// ================== entity_store.js ==================
// Central entity & relationship store with event system, type definitions, serialization
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════
  // ENTITY TYPE DEFINITIONS
  // ═══════════════════════════════════════════════════
  var ENTITY_TYPES = {
    person:       { label: "Person",       color: "#8b5cf6", shape: "dot",      attrs: ["fullName","dob","nationality","pncId","passportNumber","gender"] },
    vehicle:      { label: "Vehicle",      color: "#f59e0b", shape: "dot",      attrs: ["vrm","make","model","colour","fuelType","registeredKeeper","year"] },
    organisation: { label: "Organisation", color: "#6366f1", shape: "box",      attrs: ["companyNumber","sicCode","status","incorporationDate","companyType"] },
    location:     { label: "Location",     color: "#22c55e", shape: "diamond",  attrs: ["address","postcode","type","subtype"] },
    phone:        { label: "Phone",        color: "#a855f7", shape: "dot",      attrs: ["number","network","type"] },
    email:        { label: "Email",        color: "#ec4899", shape: "dot",      attrs: ["address","domain"] },
    vessel:       { label: "Vessel",       color: "#06b6d4", shape: "dot",      attrs: ["mmsi","imo","name","type","flag","heading","speed","callsign"] },
    port:         { label: "Port",         color: "#14b8a6", shape: "diamond",  attrs: ["name","country","unlocode","type"] },
    aircraft:     { label: "Aircraft",     color: "#38bdf8", shape: "dot",      attrs: ["callsign","icao24","registration","type","airline","origin","destination"] },
    event:        { label: "Event",        color: "#ef4444", shape: "triangle", attrs: ["date","type","description","severity","subtype"] },
    document:     { label: "Document",     color: "#64748b", shape: "box",      attrs: ["filename","sourceType","importDate","excerpt","pageCount","fileType"] }
  };

  // ═══════════════════════════════════════════════════
  // RELATIONSHIP TYPE DEFINITIONS
  // ═══════════════════════════════════════════════════
  var RELATIONSHIP_TYPES = {
    resides_at:      { from: "person",       to: "location",     label: "Resides at",       color: "#22c55e" },
    works_at:        { from: "person",       to: "organisation", label: "Works at",         color: "#6366f1" },
    directs:         { from: "person",       to: "organisation", label: "Director of",      color: "#a78bfa" },
    controls:        { from: "person",       to: "organisation", label: "PSC of",           color: "#fbbf24" },
    owns_vehicle:    { from: "person",       to: "vehicle",      label: "Owns vehicle",     color: "#f59e0b" },
    uses_phone:      { from: "person",       to: "phone",        label: "Uses phone",       color: "#a855f7" },
    uses_email:      { from: "person",       to: "email",        label: "Uses email",       color: "#ec4899" },
    associated_with: { from: "person",       to: "person",       label: "Associated with",  color: "#8b5cf6" },
    registered_at:   { from: "vehicle",      to: "location",     label: "Registered at",    color: "#f59e0b" },
    sighted_at:      { from: "vehicle",      to: "location",     label: "Sighted at",       color: "#fbbf24" },
    berthed_at:      { from: "vessel",       to: "port",         label: "Berthed at",       color: "#06b6d4" },
    located_at:      { from: "organisation", to: "location",     label: "Located at",       color: "#64748b" },
    subsidiary_of:   { from: "organisation", to: "organisation", label: "Subsidiary of",    color: "#818cf8" },
    mentions:        { from: "document",     to: "*",            label: "Mentions",         color: "#94a3b8" },
    evidence_of:     { from: "document",     to: "event",        label: "Evidence of",      color: "#ef4444" },
    attended:        { from: "person",       to: "event",        label: "Attended",         color: "#f87171" },
    travelled_on:    { from: "person",       to: "aircraft",     label: "Travelled on",     color: "#38bdf8" },
    boarded:         { from: "person",       to: "vessel",       label: "Boarded",          color: "#06b6d4" },
    linked_to:       { from: "*",            to: "*",            label: "Linked to",        color: "#64748b" }
  };

  // ═══════════════════════════════════════════════════
  // INTERNAL STATE
  // ═══════════════════════════════════════════════════
  var _entities = [];          // Array of entity objects
  var _relationships = [];     // Array of relationship objects
  var _entityIndex = {};       // id → entity (fast lookup)
  var _relIndex = {};          // id → relationship
  var _listeners = {};         // event → [callbacks]
  var _idCounter = 0;
  var _syncScheduled = false;

  // ═══════════════════════════════════════════════════
  // EVENT SYSTEM
  // ═══════════════════════════════════════════════════
  function emit(event, data) {
    var fns = _listeners[event];
    if (!fns) return;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](data); } catch (e) { console.error("[EntityStore] Event handler error:", e); }
    }
    scheduleLegacySync();
  }

  function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }

  function off(event, fn) {
    var fns = _listeners[event];
    if (!fns) return;
    _listeners[event] = fns.filter(function (f) { return f !== fn; });
  }

  // ═══════════════════════════════════════════════════
  // ID GENERATION
  // ═══════════════════════════════════════════════════
  function generateId(prefix) {
    _idCounter++;
    return prefix + "_" + Date.now() + "_" + _idCounter + "_" + Math.random().toString(36).slice(2, 6);
  }

  // ═══════════════════════════════════════════════════
  // ENTITY CRUD
  // ═══════════════════════════════════════════════════

  /**
   * Add a new entity to the store.
   * @param {string} type - Entity type (person, vehicle, organisation, etc.)
   * @param {string} label - Display label
   * @param {Object} attributes - Type-specific attributes
   * @param {Array|null} latLng - [lat, lng] or null
   * @param {Object|null} source - { documentId, excerpt, confidence, method }
   * @param {Object|null} i2EntityData - Legacy i2 entity data (optional)
   * @returns {string} entityId
   */
  function addEntity(type, label, attributes, latLng, source, i2EntityData) {
    if (!ENTITY_TYPES[type]) {
      console.warn("[EntityStore] Unknown entity type: " + type + ", defaulting to location");
      type = "location";
    }
    var id = generateId("ent");
    var now = Date.now();
    var entity = {
      id: id,
      type: type,
      label: label || "Unknown",
      attributes: attributes || {},
      latLng: latLng || null,
      source: source || null,
      i2EntityData: i2EntityData || null,
      iconOverride: null,
      metadata: { createdAt: now, updatedAt: now },
      _marker: null,
      _visible: true
    };
    _entities.push(entity);
    _entityIndex[id] = entity;
    emit("entity:added", { entity: entity });
    return id;
  }

  function updateEntity(entityId, updates) {
    var entity = _entityIndex[entityId];
    if (!entity) return false;
    var changes = {};
    if (updates.label !== undefined && updates.label !== entity.label) {
      changes.label = { from: entity.label, to: updates.label };
      entity.label = updates.label;
    }
    if (updates.attributes) {
      changes.attributes = {};
      for (var key in updates.attributes) {
        if (updates.attributes[key] !== entity.attributes[key]) {
          changes.attributes[key] = { from: entity.attributes[key], to: updates.attributes[key] };
          entity.attributes[key] = updates.attributes[key];
        }
      }
    }
    if (updates.latLng !== undefined) {
      changes.latLng = { from: entity.latLng, to: updates.latLng };
      entity.latLng = updates.latLng;
    }
    if (updates.iconOverride !== undefined) {
      entity.iconOverride = updates.iconOverride;
      changes.iconOverride = true;
    }
    if (updates.i2EntityData !== undefined) {
      entity.i2EntityData = updates.i2EntityData;
    }
    if (updates._marker !== undefined) {
      entity._marker = updates._marker;
    }
    if (updates._visible !== undefined) {
      entity._visible = updates._visible;
    }
    entity.metadata.updatedAt = Date.now();
    emit("entity:updated", { entity: entity, changes: changes });
    return true;
  }

  function removeEntity(entityId) {
    var entity = _entityIndex[entityId];
    if (!entity) return false;
    // Remove related relationships
    var relatedRels = _relationships.filter(function (r) {
      return r.fromId === entityId || r.toId === entityId;
    });
    relatedRels.forEach(function (r) { removeRelationship(r.id); });
    // Remove from arrays and index
    _entities = _entities.filter(function (e) { return e.id !== entityId; });
    delete _entityIndex[entityId];
    emit("entity:removed", { entityId: entityId, entity: entity });
    return true;
  }

  function getEntity(entityId) {
    return _entityIndex[entityId] || null;
  }

  function getAll() {
    return _entities.slice();
  }

  // ═══════════════════════════════════════════════════
  // RELATIONSHIP CRUD
  // ═══════════════════════════════════════════════════

  function addRelationship(type, fromId, toId, label, attributes, source) {
    if (!RELATIONSHIP_TYPES[type]) {
      console.warn("[EntityStore] Unknown relationship type: " + type + ", defaulting to linked_to");
      type = "linked_to";
    }
    var from = _entityIndex[fromId];
    var to = _entityIndex[toId];
    if (!from || !to) {
      console.warn("[EntityStore] Cannot create relationship: entity not found");
      return null;
    }
    var id = generateId("rel");
    var now = Date.now();
    var rel = {
      id: id,
      type: type,
      fromId: fromId,
      toId: toId,
      label: label || RELATIONSHIP_TYPES[type].label,
      attributes: attributes || {},
      source: source || null,
      metadata: { createdAt: now },
      _line: null,
      _labelMarker: null
    };
    _relationships.push(rel);
    _relIndex[id] = rel;
    emit("relationship:added", { relationship: rel });
    return id;
  }

  function removeRelationship(relId) {
    var rel = _relIndex[relId];
    if (!rel) return false;
    _relationships = _relationships.filter(function (r) { return r.id !== relId; });
    delete _relIndex[relId];
    emit("relationship:removed", { relId: relId, relationship: rel });
    return true;
  }

  function getRelationship(relId) {
    return _relIndex[relId] || null;
  }

  function getRelationshipsFor(entityId) {
    return _relationships.filter(function (r) {
      return r.fromId === entityId || r.toId === entityId;
    });
  }

  function getAllRelationships() {
    return _relationships.slice();
  }

  // ═══════════════════════════════════════════════════
  // QUERIES
  // ═══════════════════════════════════════════════════

  function findByType(type) {
    return _entities.filter(function (e) { return e.type === type; });
  }

  function findByAttribute(key, value) {
    var valueLower = String(value).toLowerCase();
    return _entities.filter(function (e) {
      var attrVal = e.attributes[key];
      if (attrVal === undefined || attrVal === null) return false;
      return String(attrVal).toLowerCase().indexOf(valueLower) >= 0;
    });
  }

  function search(query) {
    if (!query || typeof query !== "string") return [];
    var q = query.toLowerCase().trim();
    if (!q) return [];
    return _entities.filter(function (e) {
      if (e.label && e.label.toLowerCase().indexOf(q) >= 0) return true;
      var attrs = e.attributes;
      for (var key in attrs) {
        var val = attrs[key];
        if (val !== null && val !== undefined && String(val).toLowerCase().indexOf(q) >= 0) return true;
      }
      return false;
    });
  }

  function findDuplicate(type, attributes) {
    if (type === "person" && attributes.fullName) {
      var nameKey = attributes.fullName.toLowerCase();
      var dobKey = attributes.dob || "";
      return _entities.find(function (e) {
        return e.type === "person" &&
          e.attributes.fullName && e.attributes.fullName.toLowerCase() === nameKey &&
          (e.attributes.dob || "") === dobKey;
      }) || null;
    }
    if (type === "vehicle" && attributes.vrm) {
      var vrm = attributes.vrm.toUpperCase().replace(/\s/g, "");
      return _entities.find(function (e) {
        return e.type === "vehicle" &&
          e.attributes.vrm && e.attributes.vrm.toUpperCase().replace(/\s/g, "") === vrm;
      }) || null;
    }
    if (type === "organisation" && attributes.companyNumber) {
      var cn = String(attributes.companyNumber).padStart(8, "0");
      return _entities.find(function (e) {
        return e.type === "organisation" &&
          String(e.attributes.companyNumber).padStart(8, "0") === cn;
      }) || null;
    }
    if (type === "phone" && attributes.number) {
      var num = attributes.number.replace(/\s/g, "");
      return _entities.find(function (e) {
        return e.type === "phone" &&
          e.attributes.number && e.attributes.number.replace(/\s/g, "") === num;
      }) || null;
    }
    if (type === "email" && attributes.address) {
      var addr = attributes.address.toLowerCase();
      return _entities.find(function (e) {
        return e.type === "email" &&
          e.attributes.address && e.attributes.address.toLowerCase() === addr;
      }) || null;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════
  // BULK OPERATIONS
  // ═══════════════════════════════════════════════════

  function importEntities(entityArray) {
    var ids = [];
    for (var i = 0; i < entityArray.length; i++) {
      var e = entityArray[i];
      var id = addEntity(e.type, e.label, e.attributes, e.latLng, e.source, e.i2EntityData);
      ids.push(id);
    }
    return ids;
  }

  function clear() {
    _entities = [];
    _relationships = [];
    _entityIndex = {};
    _relIndex = {};
    emit("store:cleared", {});
  }

  function getStats() {
    var typeCounts = {};
    for (var key in ENTITY_TYPES) typeCounts[key] = 0;
    _entities.forEach(function (e) {
      if (typeCounts[e.type] !== undefined) typeCounts[e.type]++;
    });
    return {
      entityCount: _entities.length,
      relationshipCount: _relationships.length,
      typeCounts: typeCounts
    };
  }

  // ═══════════════════════════════════════════════════
  // SERIALIZATION (for workspace save/load)
  // ═══════════════════════════════════════════════════

  function serialize() {
    return {
      version: 2,
      entities: _entities.map(function (e) {
        return {
          id: e.id,
          type: e.type,
          label: e.label,
          attributes: e.attributes,
          latLng: e.latLng,
          source: e.source,
          i2EntityData: e.i2EntityData,
          iconOverride: e.iconOverride,
          metadata: e.metadata
        };
      }),
      relationships: _relationships.map(function (r) {
        return {
          id: r.id,
          type: r.type,
          fromId: r.fromId,
          toId: r.toId,
          label: r.label,
          attributes: r.attributes,
          source: r.source,
          metadata: r.metadata
        };
      })
    };
  }

  function deserialize(data) {
    if (!data) return;
    clear();
    var entities = data.entities || [];
    var relationships = data.relationships || [];
    entities.forEach(function (e) {
      var entity = {
        id: e.id || generateId("ent"),
        type: e.type || "location",
        label: e.label || "Unknown",
        attributes: e.attributes || {},
        latLng: e.latLng || null,
        source: e.source || null,
        i2EntityData: e.i2EntityData || null,
        iconOverride: e.iconOverride || null,
        metadata: e.metadata || { createdAt: Date.now(), updatedAt: Date.now() },
        _marker: null,
        _visible: true
      };
      _entities.push(entity);
      _entityIndex[entity.id] = entity;
    });
    relationships.forEach(function (r) {
      var rel = {
        id: r.id || generateId("rel"),
        type: r.type || "linked_to",
        fromId: r.fromId,
        toId: r.toId,
        label: r.label || "",
        attributes: r.attributes || {},
        source: r.source || null,
        metadata: r.metadata || { createdAt: Date.now() },
        _line: null,
        _labelMarker: null
      };
      if (_entityIndex[rel.fromId] && _entityIndex[rel.toId]) {
        _relationships.push(rel);
        _relIndex[rel.id] = rel;
      }
    });
    emit("store:deserialized", { entityCount: _entities.length, relationshipCount: _relationships.length });
  }

  // ═══════════════════════════════════════════════════
  // LEGACY BRIDGE
  // Keeps window._mapEntities and window._mapConnections in sync
  // ═══════════════════════════════════════════════════

  function scheduleLegacySync() {
    if (_syncScheduled) return;
    _syncScheduled = true;
    Promise.resolve().then(function () {
      _syncScheduled = false;
      _syncToLegacy();
    });
  }

  function _syncToLegacy() {
    if (!window._mapEntities) window._mapEntities = [];
    if (!window._mapConnections) window._mapConnections = [];

    // Build entity list compatible with legacy format
    window._mapEntities = _entities.map(function (e) {
      return {
        id: e.id,
        iconData: _resolveIconData(e),
        label: e.label,
        address: e.attributes.address || e.attributes.postcode || "",
        notes: _buildNotesFromAttributes(e),
        latLng: e.latLng,
        marker: e._marker,
        i2EntityData: e.i2EntityData || null,
        sourceType: e.source ? e.source.method : "",
        _storeRef: true   // Flag to indicate this came from EntityStore
      };
    });

    // Build connections list compatible with legacy format
    window._mapConnections = _relationships.map(function (r) {
      var from = _entityIndex[r.fromId];
      var to = _entityIndex[r.toId];
      return {
        id: r.id,
        type: r.type,
        label: r.label,
        fromLatLng: from ? from.latLng : null,
        toLatLng: to ? to.latLng : null,
        line: r._line,
        labelMarker: r._labelMarker,
        from: r.fromId,
        to: r.toId,
        metadata: {
          fromId: r.fromId,
          toId: r.toId,
          fromLabel: from ? from.label : "",
          toLabel: to ? to.label : ""
        },
        _storeRef: true
      };
    });
  }

  function _resolveIconData(entity) {
    var iconMap = window.IconSystem && window.IconSystem.ENTITY_ICON_MAP;
    var cfg = iconMap ? iconMap[entity.type] : null;
    return {
      name: entity.label,
      icon: cfg ? cfg.fallbackPng || "" : "",
      category: _typeToCategoryLegacy(entity.type),
      categoryName: ENTITY_TYPES[entity.type] ? ENTITY_TYPES[entity.type].label : entity.type
    };
  }

  function _typeToCategoryLegacy(type) {
    var map = {
      person: "people", vehicle: "vehicles", organisation: "financial",
      location: "buildings", phone: "communication", email: "communication",
      vessel: "vehicles", port: "buildings", aircraft: "aviation",
      event: "misc", document: "misc"
    };
    return map[type] || "misc";
  }

  function _buildNotesFromAttributes(entity) {
    var parts = [];
    var attrs = entity.attributes;
    for (var key in attrs) {
      if (attrs[key] !== null && attrs[key] !== undefined && attrs[key] !== "") {
        parts.push(key + ": " + attrs[key]);
      }
    }
    return parts.join("; ");
  }

  // Import from legacy arrays (one-time migration)
  function _syncFromLegacy() {
    var legacyEntities = window._mapEntities || [];
    var legacyConnections = window._mapConnections || [];
    legacyEntities.forEach(function (le) {
      if (le._storeRef) return;  // Already from store
      var type = _inferTypeFromLegacy(le);
      var entity = {
        id: le.id || generateId("ent"),
        type: type,
        label: le.label || "Unknown",
        attributes: _extractAttributesFromLegacy(le),
        latLng: le.latLng || null,
        source: null,
        i2EntityData: le.i2EntityData || null,
        iconOverride: null,
        metadata: { createdAt: Date.now(), updatedAt: Date.now() },
        _marker: le.marker || null,
        _visible: true
      };
      _entities.push(entity);
      _entityIndex[entity.id] = entity;
    });
    legacyConnections.forEach(function (lc) {
      if (lc._storeRef) return;
      var rel = {
        id: lc.id || generateId("rel"),
        type: _inferRelTypeFromLegacy(lc),
        fromId: lc.metadata?.fromId || lc.from || "",
        toId: lc.metadata?.toId || lc.to || "",
        label: lc.label || "",
        attributes: {},
        source: null,
        metadata: { createdAt: Date.now() },
        _line: lc.line || null,
        _labelMarker: lc.labelMarker || null
      };
      if (_entityIndex[rel.fromId] && _entityIndex[rel.toId]) {
        _relationships.push(rel);
        _relIndex[rel.id] = rel;
      }
    });
  }

  function _inferTypeFromLegacy(le) {
    var i2Type = (le.i2EntityData?.entityType || le.i2EntityData?.entityName || "").toLowerCase();
    if (i2Type.includes("person") || i2Type.includes("officer")) return "person";
    if (i2Type.includes("organisation") || i2Type.includes("company")) return "organisation";
    if (i2Type.includes("vehicle")) return "vehicle";
    if (i2Type.includes("aircraft")) return "aircraft";
    if (i2Type.includes("vessel")) return "vessel";
    if (i2Type.includes("location")) return "location";
    if (i2Type.includes("financial")) return "organisation";
    if (i2Type.includes("communication")) return "phone";
    var cat = (le.iconData?.category || "").toLowerCase();
    if (cat === "people") return "person";
    if (cat === "buildings" || cat === "real_estate") return "location";
    if (cat === "financial") return "organisation";
    if (cat === "vehicles") return "vehicle";
    if (cat === "aviation") return "aircraft";
    if (cat === "communication") return "phone";
    return "location";
  }

  function _inferRelTypeFromLegacy(lc) {
    var type = (lc.type || "").toLowerCase();
    if (type === "officer" || type === "director") return "directs";
    if (type === "psc" || type === "psc_auto") return "controls";
    if (type === "company_officer") return "directs";
    return "linked_to";
  }

  function _extractAttributesFromLegacy(le) {
    var attrs = {};
    if (le.address) attrs.address = le.address;
    var i2Vals = le.i2EntityData?.values;
    if (Array.isArray(i2Vals)) {
      i2Vals.forEach(function (v) {
        if (v && v.propertyName && v.value !== undefined && v.value !== null && v.value !== "") {
          attrs[v.propertyName] = v.value;
        }
      });
    }
    return attrs;
  }

  // ═══════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════
  window.EntityStore = {
    // CRUD
    addEntity: addEntity,
    updateEntity: updateEntity,
    removeEntity: removeEntity,
    getEntity: getEntity,
    getAll: getAll,

    // Relationships
    addRelationship: addRelationship,
    removeRelationship: removeRelationship,
    getRelationship: getRelationship,
    getRelationshipsFor: getRelationshipsFor,
    getAllRelationships: getAllRelationships,

    // Queries
    findByType: findByType,
    findByAttribute: findByAttribute,
    search: search,
    findDuplicate: findDuplicate,
    getStats: getStats,

    // Bulk
    importEntities: importEntities,
    clear: clear,

    // Events
    on: on,
    off: off,

    // Serialization
    serialize: serialize,
    deserialize: deserialize,

    // Legacy bridge
    _syncToLegacy: _syncToLegacy,
    _syncFromLegacy: _syncFromLegacy,

    // Type system
    ENTITY_TYPES: ENTITY_TYPES,
    RELATIONSHIP_TYPES: RELATIONSHIP_TYPES
  };

})();
