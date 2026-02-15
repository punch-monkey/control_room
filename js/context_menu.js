// ================== context_menu.js ==================
// Right-click context menus for map, entities, and results

(function () {
  "use strict";

  let _activeMenu = null;

  function createContextMenu(x, y, items) {
    destroyContextMenu();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";

    items.forEach(item => {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        menu.appendChild(sep);
        return;
      }
      const row = document.createElement("button");
      row.className = "ctx-item" + (item.danger ? " ctx-danger" : "");
      if (item.disabled) row.disabled = true;
      row.innerHTML = `<span class="ctx-icon">${item.icon || ""}</span><span class="ctx-label">${item.label}</span>` +
        (item.shortcut ? `<span class="ctx-shortcut">${item.shortcut}</span>` : "");
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        destroyContextMenu();
        if (item.action) item.action();
      });
      menu.appendChild(row);
    });

    document.body.appendChild(menu);
    _activeMenu = menu;

    // Keep menu on screen
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + "px";
      if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + "px";
    });
  }

  function destroyContextMenu() {
    if (_activeMenu) {
      _activeMenu.remove();
      _activeMenu = null;
    }
  }

  // Close on any outside click or scroll
  document.addEventListener("click", destroyContextMenu);
  document.addEventListener("scroll", destroyContextMenu, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") destroyContextMenu(); });

  // ── Map Context Menu ──
  function initMapContextMenu() {
    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    mapEl.addEventListener("contextmenu", (e) => {
      // Check if clicking on an entity marker
      const entityMarker = e.target.closest(".leaflet-marker-icon, .leaflet-marker-pane");
      if (entityMarker) return; // Entity context menu handles it

      e.preventDefault();
      const latlng = window._map?.mouseEventToLatLng(e);
      if (!latlng) return;

      createContextMenu(e.clientX, e.clientY, [
        {
          icon: "&#128204;", label: "Place Entity Here",
          action: () => { if (typeof showEntityPlacementDialog === "function") showEntityPlacementDialog(latlng); }
        },
        {
          icon: "&#128269;", label: "Search Companies Near Here",
          action: () => {
            const pc = document.getElementById("ch_postcode");
            if (pc) {
              // Reverse geocode to postcode
              fetch(`https://api.postcodes.io/postcodes?lon=${latlng.lng}&lat=${latlng.lat}&limit=1`)
                .then(r => r.json())
                .then(data => {
                  if (data.result?.[0]?.postcode) {
                    pc.value = data.result[0].postcode;
                    document.querySelector('[data-tab="search"]')?.click();
                    document.getElementById("ch_search")?.click();
                  }
                })
                .catch(() => {});
            }
          }
        },
        { separator: true },
        {
          icon: "&#127760;", label: "What's Here? (Coordinates)",
          action: () => {
            const msg = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
            navigator.clipboard?.writeText(msg);
            if (typeof showToast === "function") showToast(`Copied: ${msg}`, "info");
          }
        },
        {
          icon: "&#128207;", label: "Measure Distance From Here",
          action: () => {
            window._measureStart = latlng;
            if (typeof showToast === "function") showToast("Click another point to measure distance", "info");
          }
        },
        { separator: true },
        {
          icon: "&#128247;", label: "Export Map View as PNG",
          action: exportMapAsPng
        },
        {
          icon: "&#128190;", label: "Save Workspace",
          shortcut: "Ctrl+S",
          action: () => { if (window.CRDashboard) window.CRDashboard.saveWorkspace("quicksave"); }
        }
      ]);
    });

    // Measure distance on click after right-click "Measure"
    window._map?.on("click", (e) => {
      if (window._measureStart) {
        const from = window._measureStart;
        const to = e.latlng;
        const dist = haversineDistance(from.lat, from.lng, to.lat, to.lng);
        const line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
          color: "#f59e0b", weight: 2, dashArray: "6,4", opacity: 0.8
        }).addTo(window._map);
        const midLat = (from.lat + to.lat) / 2;
        const midLng = (from.lng + to.lng) / 2;
        const label = dist < 1 ? `${(dist * 1000).toFixed(0)}m` : `${dist.toFixed(2)}km`;
        L.popup({ closeButton: true, autoClose: false })
          .setLatLng([midLat, midLng])
          .setContent(`<div style="font-size:13px;font-weight:600;color:#f59e0b">${label}</div>`)
          .openOn(window._map);
        // Remove after 30s
        setTimeout(() => { window._map?.removeLayer(line); }, 30000);
        window._measureStart = null;
        if (window.CRDashboard) window.CRDashboard.logActivity("Measured distance", label, "general");
      }
    });
  }

  // ── Entity Context Menu ──
  function showEntityContextMenu(e, entityId) {
    e.preventDefault();
    e.stopPropagation();
    const entity = (window._mapEntities || []).find(en => en.id === entityId);
    if (!entity) return;

    createContextMenu(e.clientX, e.clientY, [
      {
        icon: "&#128279;", label: "Draw Connection From",
        action: () => { if (typeof drawConnectionFrom === "function") drawConnectionFrom(entityId); }
      },
      {
        icon: "&#9998;", label: "Edit Entity",
        action: () => { if (typeof editEntity === "function") editEntity(entityId); }
      },
      {
        icon: "&#127760;", label: "Show in Network Graph",
        action: () => {
          if (window.CRDashboard) window.CRDashboard.toggleBottomPanel("graph");
          // Select in graph after a brief delay for render
          setTimeout(() => {
            const container = document.getElementById("network-graph-container");
            if (container?._network) {
              container._network.selectNodes([entityId]);
            }
          }, 300);
        }
      },
      { separator: true },
      {
        icon: "&#128269;", label: "Search Related Companies",
        disabled: !entity.label,
        action: () => {
          const nameInput = document.getElementById("ch_name");
          if (nameInput) {
            nameInput.value = entity.label;
            document.querySelector('[data-tab="search"]')?.click();
            document.getElementById("ch_search")?.click();
          }
        }
      },
      {
        icon: "&#128100;", label: "Search PSC/Officers",
        action: () => {
          const pscName = document.getElementById("psc_name");
          if (pscName) {
            pscName.value = entity.label;
            document.querySelector('[data-tab="search"]')?.click();
            const block = document.getElementById("people-ops-block");
            if (block) block.open = true;
            document.getElementById("psc_search")?.click();
          }
        }
      },
      { separator: true },
      {
        icon: "&#128203;", label: "Copy Entity Data",
        action: () => {
          const data = {
            label: entity.label, address: entity.address, notes: entity.notes,
            coords: entity.latLng, i2: entity.i2EntityData
          };
          navigator.clipboard?.writeText(JSON.stringify(data, null, 2));
          if (typeof showToast === "function") showToast("Entity data copied to clipboard", "info");
        }
      },
      {
        icon: "&#128465;", label: "Remove Entity",
        danger: true,
        action: () => { if (typeof removeEntity === "function") removeEntity(entityId); }
      }
    ]);
  }

  // ── Result Item Context Menu ──
  function showResultContextMenu(e, companyData) {
    e.preventDefault();
    createContextMenu(e.clientX, e.clientY, [
      {
        icon: "&#128204;", label: "Plot on Map",
        action: () => {
          // Trigger the normal click behavior
          const item = e.target.closest(".ch-result-item");
          if (item) item.click();
        }
      },
      {
        icon: "&#128100;", label: "View PSC Data",
        action: () => {
          const num = companyData.CompanyNumber || companyData.company_number;
          if (num) {
            const pscComp = document.getElementById("psc_company");
            if (pscComp) pscComp.value = num;
            const block = document.getElementById("people-ops-block");
            if (block) block.open = true;
            document.getElementById("psc_search")?.click();
          }
        }
      },
      {
        icon: "&#128203;", label: "Copy Company Number",
        action: () => {
          const num = companyData.CompanyNumber || companyData.company_number || "";
          navigator.clipboard?.writeText(num);
          if (typeof showToast === "function") showToast(`Copied: ${num}`, "info");
        }
      },
      { separator: true },
      {
        icon: "&#128196;", label: "Add to 3x5x2 Report",
        action: () => {
          if (window._3x5x2Entities) {
            window._3x5x2Entities.push(companyData);
            if (typeof showToast === "function") showToast("Added to intelligence report", "success");
          }
        }
      }
    ]);
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function exportMapAsPng() {
    // Use leaflet-image or canvas approach
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;
    // For tile-based maps, we need to use html2canvas or similar
    // Fallback: screenshot instruction
    if (typeof showToast === "function") {
      showToast("Use Print Screen or Snipping Tool for map capture", "info");
    }
  }

  // ── Init ──
  function init() {
    initMapContextMenu();

    // Expose for entity markers to call
    window.showEntityContextMenu = showEntityContextMenu;
    window.showResultContextMenu = showResultContextMenu;
    window._3x5x2Entities = [];
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
