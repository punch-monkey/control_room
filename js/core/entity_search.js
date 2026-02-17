// ================== entity_search.js ==================
// Unified search across all entity types in EntityStore
(function () {
  "use strict";

  // ── Search entities by query string with optional filters ──
  // Returns array of { entity, score, matchField }
  function searchEntities(query, filters) {
    if (!window.EntityStore) return [];
    filters = filters || {};

    var q = String(query || "").trim().toLowerCase();
    if (!q) return [];

    var all = window.EntityStore.getAll();
    var results = [];

    for (var i = 0; i < all.length; i++) {
      var entity = all[i];

      // Apply type filter
      if (filters.type && entity.type !== filters.type) continue;

      // Apply source filter
      if (filters.source && entity.source?.method !== filters.source) continue;

      // Score matches
      var score = 0;
      var matchField = "";

      // Label match (highest weight)
      var label = String(entity.label || "").toLowerCase();
      if (label === q) {
        score = 100;
        matchField = "label";
      } else if (label.startsWith(q)) {
        score = 80;
        matchField = "label";
      } else if (label.includes(q)) {
        score = 60;
        matchField = "label";
      }

      // Attribute matches
      var attrs = entity.attributes || {};
      var attrKeys = Object.keys(attrs);
      for (var j = 0; j < attrKeys.length; j++) {
        var val = String(attrs[attrKeys[j]] || "").toLowerCase();
        if (!val) continue;
        if (val === q) {
          var s = 90;
          if (s > score) { score = s; matchField = attrKeys[j]; }
        } else if (val.includes(q)) {
          var s2 = 50;
          if (s2 > score) { score = s2; matchField = attrKeys[j]; }
        }
      }

      // i2 entity data values
      if (entity.i2EntityData?.values) {
        var vals = entity.i2EntityData.values;
        for (var k = 0; k < vals.length; k++) {
          var pv = String(vals[k]?.value || "").toLowerCase();
          if (pv && pv.includes(q)) {
            var s3 = 45;
            if (s3 > score) { score = s3; matchField = "i2:" + (vals[k].propertyName || ""); }
          }
        }
      }

      // Type name match (low weight)
      var typeDef = window.EntityStore.ENTITY_TYPES[entity.type];
      if (typeDef && typeDef.label.toLowerCase().includes(q)) {
        if (score < 20) { score = 20; matchField = "type"; }
      }

      if (score > 0) {
        results.push({ entity: entity, score: score, matchField: matchField });
      }
    }

    // Sort by score descending
    results.sort(function (a, b) { return b.score - a.score; });

    // Apply limit
    var limit = filters.limit || 100;
    return results.slice(0, limit);
  }

  // ── Get counts by entity type ──
  function getEntityTypeCounts() {
    if (!window.EntityStore) return {};
    var all = window.EntityStore.getAll();
    var counts = {};
    for (var i = 0; i < all.length; i++) {
      var t = all[i].type || "unknown";
      counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }

  // ── Render search results into a container ──
  function renderSearchResults(results, container) {
    if (!container) return;
    if (!results.length) {
      container.innerHTML = '<div class="entity-search-empty">No entities found</div>';
      return;
    }

    var html = '<ul class="entity-search-results">';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var e = r.entity;
      var typeDef = window.EntityStore?.ENTITY_TYPES?.[e.type];
      var color = typeDef?.color || "#64748b";
      var typeLabel = typeDef?.label || e.type;

      html += '<li class="entity-search-result" data-entity-id="' + _esc(e.id) + '">';
      html += '<span class="entity-search-type" style="background:' + color + '">' + _esc(typeLabel) + '</span> ';
      html += '<span class="entity-search-label">' + _esc(e.label || "Unknown") + '</span>';
      if (r.matchField && r.matchField !== "label") {
        var matchVal = e.attributes?.[r.matchField] || "";
        if (matchVal) html += ' <span class="entity-search-match">' + _esc(r.matchField) + ': ' + _esc(String(matchVal).substring(0, 40)) + '</span>';
      }
      html += '</li>';
    }
    html += '</ul>';
    container.innerHTML = html;

    // Click handlers
    container.querySelectorAll(".entity-search-result").forEach(function (li) {
      li.addEventListener("click", function () {
        var entityId = li.getAttribute("data-entity-id");
        _focusEntity(entityId);
      });
    });
  }

  // ── Focus map on entity ──
  function _focusEntity(entityId) {
    if (!entityId) return;

    // Try EntityStore first
    if (window.EntityStore) {
      var entity = window.EntityStore.getEntity(entityId);
      if (entity) {
        if (entity.latLng && window._map) {
          window._map.setView(entity.latLng, Math.max(window._map.getZoom(), 15));
        }
        if (entity._marker) entity._marker.openPopup();
        // Open inspector
        if (typeof window.openEntityInspector === "function") {
          window.openEntityInspector(entityId);
        }
        return;
      }
    }

    // Fallback to legacy
    var legacy = (window._mapEntities || []).find(function (e) { return e.id === entityId; });
    if (legacy) {
      if (legacy.latLng && window._map) {
        window._map.setView(legacy.latLng, Math.max(window._map.getZoom(), 15));
      }
      if (legacy.marker) legacy.marker.openPopup();
    }
  }

  // ── Wire up search input ──
  function initEntitySearch() {
    var input = document.getElementById("entity-search-input");
    var resultsContainer = document.getElementById("entity-search-results");
    var typeFilter = document.getElementById("entity-search-type-filter");

    if (!input || !resultsContainer) return;

    var debounceTimer = null;
    input.addEventListener("input", function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var query = input.value;
        var filters = {};
        if (typeFilter && typeFilter.value) filters.type = typeFilter.value;
        var results = searchEntities(query, filters);
        renderSearchResults(results, resultsContainer);
      }, 200);
    });

    if (typeFilter) {
      typeFilter.addEventListener("change", function () {
        var query = input.value;
        var filters = {};
        if (typeFilter.value) filters.type = typeFilter.value;
        var results = searchEntities(query, filters);
        renderSearchResults(results, resultsContainer);
      });
    }
  }

  function _esc(str) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(str);
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(String(str || "")));
    return d.innerHTML;
  }

  // ── Public API ──
  window.EntitySearch = {
    search: searchEntities,
    getTypeCounts: getEntityTypeCounts,
    renderResults: renderSearchResults,
    init: initEntitySearch,
    focusEntity: _focusEntity
  };

})();
