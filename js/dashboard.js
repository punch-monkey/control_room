// ================== dashboard.js ==================
// Activity log, search history, workspace persistence, KPI system

(function () {
  "use strict";

  // ── Activity Log ──
  const MAX_LOG_ENTRIES = 500;
  const _activityLog = [];

  function logActivity(action, detail = "", category = "general") {
    const entry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      action,
      detail: String(detail).slice(0, 300),
      category // general, search, entity, connection, layer, export, alert
    };
    _activityLog.unshift(entry);
    if (_activityLog.length > MAX_LOG_ENTRIES) _activityLog.length = MAX_LOG_ENTRIES;
    renderActivityLog();
    updateKPIs();
    return entry;
  }

  function renderActivityLog() {
    const container = document.getElementById("activity-log-list");
    if (!container) return;
    const visible = _activityLog.slice(0, 80);
    if (!visible.length) {
      container.innerHTML = '<div class="activity-empty">No activity yet. Start searching or placing entities.</div>';
      return;
    }
    const catIcons = {
      search: "&#128269;", entity: "&#128204;", connection: "&#128279;",
      layer: "&#127760;", export: "&#128230;", alert: "&#9888;&#65039;", general: "&#9654;"
    };
    container.innerHTML = visible.map(e => {
      const time = new Date(e.ts);
      const hh = String(time.getHours()).padStart(2, "0");
      const mm = String(time.getMinutes()).padStart(2, "0");
      const ss = String(time.getSeconds()).padStart(2, "0");
      const icon = catIcons[e.category] || catIcons.general;
      return `<div class="activity-entry activity-cat-${e.category}" title="${new Date(e.ts).toLocaleString()}">
        <span class="activity-time">${hh}:${mm}:${ss}</span>
        <span class="activity-icon">${icon}</span>
        <span class="activity-action">${escapeHtml(e.action)}</span>
        ${e.detail ? `<span class="activity-detail">${escapeHtml(e.detail)}</span>` : ""}
      </div>`;
    }).join("");
  }

  // ── Search History ──
  const MAX_HISTORY = 50;
  let _searchHistory = [];

  function addSearchHistory(type, query, resultCount = 0, metadata = {}) {
    const entry = {
      id: `sh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      type, // company, officer, psc, dvla, flight, tfl, rail
      query: String(query).slice(0, 200),
      resultCount,
      bookmarked: false,
      metadata
    };
    _searchHistory.unshift(entry);
    if (_searchHistory.length > MAX_HISTORY) _searchHistory.length = MAX_HISTORY;
    renderSearchHistory();
    saveSearchHistoryToStorage();
    logActivity(`${type.toUpperCase()} search`, query, "search");
    return entry;
  }

  function toggleBookmark(historyId) {
    const entry = _searchHistory.find(e => e.id === historyId);
    if (entry) {
      entry.bookmarked = !entry.bookmarked;
      renderSearchHistory();
      saveSearchHistoryToStorage();
    }
  }

  function replaySearch(historyId) {
    const entry = _searchHistory.find(e => e.id === historyId);
    if (!entry) return;
    switch (entry.type) {
      case "company": {
        const nameInput = document.getElementById("ch_name");
        const numInput = document.getElementById("ch_number");
        if (entry.metadata.name && nameInput) nameInput.value = entry.metadata.name;
        if (entry.metadata.number && numInput) numInput.value = entry.metadata.number;
        document.getElementById("ch_search")?.click();
        break;
      }
      case "officer":
      case "psc": {
        const pscName = document.getElementById("psc_name");
        const pscComp = document.getElementById("psc_company");
        if (entry.metadata.personName && pscName) pscName.value = entry.metadata.personName;
        if (entry.metadata.companyNumber && pscComp) pscComp.value = entry.metadata.companyNumber;
        document.getElementById("psc_search")?.click();
        break;
      }
      case "dvla": {
        const vrmInput = document.getElementById("dvla-vrm-input");
        if (vrmInput) vrmInput.value = entry.query;
        document.getElementById("dvla-lookup-btn")?.click();
        break;
      }
    }
    logActivity("Replayed search", entry.query, "search");
  }

  function renderSearchHistory() {
    const container = document.getElementById("search-history-list");
    if (!container) return;
    const bookmarked = _searchHistory.filter(e => e.bookmarked);
    const recent = _searchHistory.filter(e => !e.bookmarked).slice(0, 20);
    if (!bookmarked.length && !recent.length) {
      container.innerHTML = '<div class="activity-empty">No search history yet.</div>';
      return;
    }
    let html = "";
    if (bookmarked.length) {
      html += '<div class="sh-section-label">BOOKMARKED</div>';
      html += bookmarked.map(renderHistoryEntry).join("");
    }
    if (recent.length) {
      html += '<div class="sh-section-label">RECENT</div>';
      html += recent.map(renderHistoryEntry).join("");
    }
    container.innerHTML = html;
    container.querySelectorAll("[data-sh-replay]").forEach(btn => {
      btn.addEventListener("click", () => replaySearch(btn.dataset.shReplay));
    });
    container.querySelectorAll("[data-sh-bookmark]").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleBookmark(btn.dataset.shBookmark);
      });
    });
  }

  function renderHistoryEntry(e) {
    const time = new Date(e.ts);
    const hhmm = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
    const typeColors = {
      company: "#a78bfa", officer: "#c4b5fd", psc: "#fbbf24",
      dvla: "#f59e0b", flight: "#38bdf8", tfl: "#f43f5e", rail: "#22c55e"
    };
    const color = typeColors[e.type] || "#94a3b8";
    return `<div class="sh-entry" data-sh-replay="${e.id}">
      <span class="sh-type" style="color:${color}">${e.type.toUpperCase()}</span>
      <span class="sh-query">${escapeHtml(e.query)}</span>
      <span class="sh-count">${e.resultCount} results</span>
      <span class="sh-time">${hhmm}</span>
      <button class="sh-bookmark-btn ${e.bookmarked ? "bookmarked" : ""}" data-sh-bookmark="${e.id}" title="${e.bookmarked ? "Remove bookmark" : "Bookmark"}">${e.bookmarked ? "&#9733;" : "&#9734;"}</button>
    </div>`;
  }

  function saveSearchHistoryToStorage() {
    try {
      const slim = _searchHistory.map(({ id, ts, type, query, resultCount, bookmarked, metadata }) =>
        ({ id, ts, type, query, resultCount, bookmarked, metadata }));
      localStorage.setItem("cr_search_history", JSON.stringify(slim));
    } catch (_) { /* quota */ }
  }

  function loadSearchHistoryFromStorage() {
    try {
      const raw = localStorage.getItem("cr_search_history");
      if (raw) {
        _searchHistory = JSON.parse(raw).slice(0, MAX_HISTORY);
        renderSearchHistory();
      }
    } catch (_) { /* parse error */ }
  }

  // ── Workspace Persistence ──
  function saveWorkspace(name = "default") {
    const entities = (window._mapEntities || []).map(e => ({
      id: e.id, label: e.label, address: e.address, notes: e.notes,
      latLng: e.latLng, iconData: e.iconData, i2EntityData: e.i2EntityData
    }));
    const connections = (window._mapConnections || []).map(c => ({
      id: c.id, from: c.from, to: c.to, label: c.label, type: c.type, metadata: c.metadata
    }));
    const activeLayers = [];
    document.querySelectorAll(".layer-cb:checked").forEach(cb => activeLayers.push(cb.dataset.layer));
    const activeBase = document.querySelector(".bl-pill.active")?.dataset?.base || "Dark";
    const mapCenter = window._map?.getCenter();
    const mapZoom = window._map?.getZoom();

    // EntityStore serialization (v3)
    let entityStoreData = null;
    if (window.EntityStore && window.EntityStore.getAll().length > 0) {
      entityStoreData = window.EntityStore.serialize();
    }

    const workspace = {
      version: 3,
      name,
      savedAt: Date.now(),
      entities,
      connections,
      entityStore: entityStoreData,
      activeLayers,
      activeBase,
      mapView: mapCenter ? { lat: mapCenter.lat, lng: mapCenter.lng, zoom: mapZoom } : null,
      searchHistory: _searchHistory.filter(s => s.bookmarked)
    };

    try {
      localStorage.setItem(`cr_workspace_${name}`, JSON.stringify(workspace));
      logActivity("Workspace saved", name, "export");
      if (typeof showToast === "function") showToast(`Workspace "${name}" saved`, "success");
      renderWorkspaceList();
      return true;
    } catch (err) {
      if (typeof showToast === "function") showToast("Save failed: storage full", "error");
      return false;
    }
  }

  function loadWorkspace(name = "default") {
    try {
      const raw = localStorage.getItem(`cr_workspace_${name}`);
      if (!raw) {
        if (typeof showToast === "function") showToast(`No workspace "${name}" found`, "error");
        return false;
      }
      const ws = JSON.parse(raw);
      // Restore map view
      if (ws.mapView && window._map) {
        window._map.setView([ws.mapView.lat, ws.mapView.lng], ws.mapView.zoom);
      }
      // Restore base layer
      if (ws.activeBase) {
        document.querySelector(`.bl-pill[data-base="${ws.activeBase}"]`)?.click();
      }
      // Restore EntityStore (v3) or legacy entities
      if (ws.entityStore && window.EntityStore) {
        window.EntityStore.deserialize(ws.entityStore);
      } else if (ws.entities?.length && typeof placeEntity === "function") {
        ws.entities.forEach(e => {
          placeEntity(e.latLng, e.iconData, e.label, e.address, e.notes, e.i2EntityData);
        });
      }
      // Restore layers
      if (ws.activeLayers) {
        document.querySelectorAll(".layer-cb").forEach(cb => {
          const shouldBeOn = ws.activeLayers.includes(cb.dataset.layer);
          if (cb.checked !== shouldBeOn) cb.click();
        });
      }
      logActivity("Workspace loaded", name, "general");
      if (typeof showToast === "function") showToast(`Workspace "${name}" loaded (${ws.entities?.length || 0} entities)`, "success");
      return true;
    } catch (err) {
      console.error("Load workspace error:", err);
      return false;
    }
  }

  function deleteWorkspace(name) {
    localStorage.removeItem(`cr_workspace_${name}`);
    renderWorkspaceList();
    logActivity("Workspace deleted", name, "general");
  }

  function listWorkspaces() {
    const names = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith("cr_workspace_")) {
        const name = key.replace("cr_workspace_", "");
        try {
          const ws = JSON.parse(localStorage.getItem(key));
          names.push({ name, savedAt: ws.savedAt, entityCount: ws.entities?.length || 0 });
        } catch (_) { }
      }
    }
    return names.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  function renderWorkspaceList() {
    const container = document.getElementById("workspace-list");
    if (!container) return;
    const workspaces = listWorkspaces();
    if (!workspaces.length) {
      container.innerHTML = '<div class="activity-empty">No saved workspaces. Use Save to preserve your current session.</div>';
      return;
    }
    container.innerHTML = workspaces.map(ws => {
      const date = ws.savedAt ? new Date(ws.savedAt).toLocaleString() : "Unknown";
      return `<div class="ws-entry">
        <div class="ws-info">
          <span class="ws-name">${escapeHtml(ws.name)}</span>
          <span class="ws-meta">${ws.entityCount} entities &middot; ${date}</span>
        </div>
        <div class="ws-actions">
          <button class="ws-load-btn" data-ws-load="${escapeAttr(ws.name)}" title="Load workspace">Load</button>
          <button class="ws-delete-btn" data-ws-delete="${escapeAttr(ws.name)}" title="Delete workspace">&times;</button>
        </div>
      </div>`;
    }).join("");
    container.querySelectorAll("[data-ws-load]").forEach(btn => {
      btn.addEventListener("click", () => loadWorkspace(btn.dataset.wsLoad));
    });
    container.querySelectorAll("[data-ws-delete]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (confirm(`Delete workspace "${btn.dataset.wsDelete}"?`)) deleteWorkspace(btn.dataset.wsDelete);
      });
    });
  }

  // ── KPI Dashboard ──
  function updateKPIs() {
    const entities = window._mapEntities?.length || 0;
    const connections = window._mapConnections?.length || 0;
    const activeLayers = document.querySelectorAll(".layer-cb:checked").length;
    const searches = _searchHistory.length;
    const alerts = _activityLog.filter(e => e.category === "alert").length;

    setKPI("kpi-entities", entities);
    setKPI("kpi-connections", connections);
    setKPI("kpi-layers", activeLayers);
    setKPI("kpi-searches", searches);
    setKPI("kpi-alerts", alerts);

    // Session duration
    const elapsed = Date.now() - _sessionStart;
    const mins = Math.floor(elapsed / 60000);
    const hrs = Math.floor(mins / 60);
    const dispMins = mins % 60;
    const sessionEl = document.getElementById("kpi-session");
    if (sessionEl) sessionEl.textContent = hrs > 0 ? `${hrs}h ${dispMins}m` : `${dispMins}m`;

  }

  function setKPI(id, value) {
    const el = document.getElementById(id);
    if (el) {
      const prev = parseInt(el.textContent) || 0;
      el.textContent = String(value);
      if (value > prev && prev > 0) {
        el.classList.add("kpi-flash");
        setTimeout(() => el.classList.remove("kpi-flash"), 600);
      }
    }
  }

  const _sessionStart = Date.now();

  // ── Auto-save timer ──
  let _autoSaveTimer = null;
  function startAutoSave(intervalMs = 120000) {
    if (_autoSaveTimer) clearInterval(_autoSaveTimer);
    _autoSaveTimer = setInterval(() => {
      if ((window._mapEntities?.length || 0) > 0) {
        saveWorkspace("_autosave");
      }
    }, intervalMs);
  }

  // ── Keyboard Shortcuts ──
  const _shortcuts = {};

  function registerShortcut(combo, description, handler) {
    _shortcuts[combo] = { description, handler };
  }

  function initKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (isEditingInput(e.target)) return;

      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push("ctrl");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      parts.push(e.key.toLowerCase());
      const combo = parts.join("+");

      const shortcut = _shortcuts[combo];
      if (shortcut) {
        e.preventDefault();
        e.stopPropagation();
        shortcut.handler();
      }
    });

    // Register default shortcuts
    registerShortcut("ctrl+f", "Focus search", () => {
      const panel = document.getElementById("control-panel");
      if (panel?.classList.contains("collapsed")) document.getElementById("cp-toggle")?.click();
      document.querySelector('[data-tab="search"]')?.click();
      document.getElementById("ch_name")?.focus();
    });
    registerShortcut("ctrl+e", "Place entity", () => {
      document.querySelector('[data-tab="entities"]')?.click();
      document.getElementById("quick-entity-place")?.click();
    });
    registerShortcut("ctrl+l", "Toggle layers", () => {
      document.querySelector('[data-tab="layers"]')?.click();
    });
    registerShortcut("ctrl+g", "Toggle network graph", () => {
      toggleBottomPanel("graph");
    });
    registerShortcut("ctrl+t", "Toggle timeline", () => {
      toggleBottomPanel("timeline");
    });
    registerShortcut("ctrl+h", "Toggle activity log", () => {
      toggleBottomPanel("activity");
    });
    registerShortcut("ctrl+s", "Save workspace", () => {
      saveWorkspace("quicksave");
    });
    registerShortcut("ctrl+shift+s", "Save workspace as...", () => {
      const name = prompt("Workspace name:");
      if (name) saveWorkspace(name.trim());
    });
    registerShortcut("ctrl+shift+l", "Load last workspace", () => {
      loadWorkspace("quicksave");
    });
    registerShortcut("escape", "Cancel / close panels", () => {
      if (typeof cancelConnectionDrawing === "function") cancelConnectionDrawing();
      closeBottomPanel();
    });
    registerShortcut("ctrl+shift+x", "Export i2 ANX", () => {
      if (typeof window.exportI2ANX === "function") window.exportI2ANX();
    });
    registerShortcut("ctrl+shift+r", "Generate 3x5x2 report", () => {
      if (typeof window.generate3x5x2Report === "function") window.generate3x5x2Report();
    });
    registerShortcut("f1", "Show keyboard shortcuts", () => {
      showShortcutsOverlay();
    });
  }

  function showShortcutsOverlay() {
    let overlay = document.getElementById("shortcuts-overlay");
    if (overlay) { overlay.remove(); return; }

    overlay = document.createElement("div");
    overlay.id = "shortcuts-overlay";
    overlay.className = "shortcuts-overlay";
    let html = '<div class="shortcuts-dialog"><div class="shortcuts-header"><span>Keyboard Shortcuts</span><button class="shortcuts-close" onclick="this.closest(\'.shortcuts-overlay\').remove()">&times;</button></div><div class="shortcuts-body">';
    Object.entries(_shortcuts).forEach(([combo, { description }]) => {
      const keys = combo.split("+").map(k => `<kbd>${k.charAt(0).toUpperCase() + k.slice(1)}</kbd>`).join(" + ");
      html += `<div class="shortcut-row"><span class="shortcut-keys">${keys}</span><span class="shortcut-desc">${escapeHtml(description)}</span></div>`;
    });
    html += '</div></div>';
    overlay.innerHTML = html;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function isEditingInput(target) {
    if (!target || !target.tagName) return false;
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
  }

  // ── Bottom Panel Management ──
  let _activeBottomPanel = null;

  function toggleBottomPanel(panelId) {
    const panel = document.getElementById("bottom-panel");
    if (!panel) return;

    const allTabs = panel.querySelectorAll(".bp-tab-pane");
    const allBtns = panel.querySelectorAll(".bp-tab-btn");

    if (_activeBottomPanel === panelId) {
      closeBottomPanel();
      return;
    }

    panel.classList.add("open");
    _activeBottomPanel = panelId;

    allTabs.forEach(t => t.classList.toggle("active", t.dataset.bpTab === panelId));
    allBtns.forEach(b => b.classList.toggle("active", b.dataset.bpTarget === panelId));

    // Resize map for bottom panel
    document.getElementById("map")?.classList.add("bp-open");

    // Trigger renders
    if (panelId === "graph" && typeof window.refreshNetworkGraph === "function") {
      window.refreshNetworkGraph();
    }
    if (panelId === "timeline" && typeof window.refreshTimeline === "function") {
      window.refreshTimeline();
    }
    if (panelId === "activity") renderActivityLog();

    // Resize map
    setTimeout(() => window._map?.invalidateSize(), 50);
  }

  function closeBottomPanel() {
    const panel = document.getElementById("bottom-panel");
    if (!panel) return;
    panel.classList.remove("open");
    _activeBottomPanel = null;
    panel.querySelectorAll(".bp-tab-btn").forEach(b => b.classList.remove("active"));
    document.getElementById("map")?.classList.remove("bp-open");
    setTimeout(() => window._map?.invalidateSize(), 50);
  }

  // ── Helpers ──
  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }
  function escapeAttr(str) {
    return String(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── Init ──
  function initDashboard() {
    loadSearchHistoryFromStorage();
    renderWorkspaceList();
    initKeyboardShortcuts();
    startAutoSave();
    updateKPIs();

    // Wire up bottom panel tabs
    document.querySelectorAll(".bp-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => toggleBottomPanel(btn.dataset.bpTarget));
    });
    document.getElementById("bp-close-btn")?.addEventListener("click", closeBottomPanel);

    // Wire up workspace buttons
    document.getElementById("ws-save-btn")?.addEventListener("click", () => {
      const nameInput = document.getElementById("ws-name-input");
      const name = nameInput?.value?.trim() || "default";
      saveWorkspace(name);
    });
    document.getElementById("ws-quicksave-btn")?.addEventListener("click", () => saveWorkspace("quicksave"));
    document.getElementById("ws-quickload-btn")?.addEventListener("click", () => loadWorkspace("quicksave"));

    // KPI refresh every 10s
    setInterval(updateKPIs, 10000);

    logActivity("Session started", `Control Room v2 initialized`, "general");
  }

  // Wait for DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDashboard);
  } else {
    initDashboard();
  }

  // ── Exports ──
  window.CRDashboard = {
    logActivity,
    addSearchHistory,
    saveWorkspace,
    loadWorkspace,
    listWorkspaces,
    updateKPIs,
    toggleBottomPanel,
    closeBottomPanel,
    registerShortcut,
    showShortcutsOverlay
  };
})();
