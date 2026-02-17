// ================== network_graph.js ==================
// Force-directed network graph (link analysis) using vis-network

(function () {
  "use strict";

  let _network = null;
  let _graphData = { nodes: null, edges: null };
  let _selectedNodeId = null;
  let _highlightedNodes = new Set();

  // Color palette for entity types
  const TYPE_COLORS = {
    company: { bg: "#6366f1", border: "#818cf8", font: "#e0e7ff" },
    person: { bg: "#8b5cf6", border: "#a78bfa", font: "#ede9fe" },
    officer: { bg: "#c084fc", border: "#d8b4fe", font: "#faf5ff" },
    vehicle: { bg: "#f59e0b", border: "#fbbf24", font: "#fef3c7" },
    aircraft: { bg: "#38bdf8", border: "#7dd3fc", font: "#e0f2fe" },
    location: { bg: "#22c55e", border: "#4ade80", font: "#dcfce7" },
    financial: { bg: "#ef4444", border: "#f87171", font: "#fee2e2" },
    default: { bg: "#64748b", border: "#94a3b8", font: "#e2e8f0" }
  };

  const EDGE_COLORS = {
    officer: "#a78bfa",
    psc: "#fbbf24",
    manual: "#22c55e",
    default: "#64748b",
    // Typed relationship colours (from EntityStore.RELATIONSHIP_TYPES)
    resides_at: "#22c55e",
    works_at: "#6366f1",
    directs: "#a78bfa",
    controls: "#f59e0b",
    owns_vehicle: "#f59e0b",
    uses_phone: "#a855f7",
    uses_email: "#ec4899",
    associated_with: "#64748b",
    registered_at: "#6366f1",
    berthed_at: "#14b8a6",
    located_at: "#22c55e",
    mentions: "#94a3b8",
    linked_to: "#64748b",
    secretary_of: "#818cf8",
    shareholder_of: "#fbbf24",
    beneficial_owner_of: "#f59e0b",
    psc_of: "#fbbf24",
    flew_on: "#38bdf8",
    travelled_to: "#06b6d4"
  };

  function inferEntityType(entity) {
    if (!entity) return "default";
    const i2Type = (entity.i2EntityData?.entityType || "").toLowerCase();
    if (i2Type.includes("person") || i2Type.includes("officer")) return "person";
    if (i2Type.includes("organisation") || i2Type.includes("company")) return "company";
    if (i2Type.includes("vehicle")) return "vehicle";
    if (i2Type.includes("aircraft")) return "aircraft";
    if (i2Type.includes("location")) return "location";
    if (i2Type.includes("financial")) return "financial";
    const cat = (entity.iconData?.category || "").toLowerCase();
    if (cat === "people") return "person";
    if (cat === "buildings" || cat === "real_estate") return "location";
    if (cat === "financial") return "financial";
    if (cat === "vehicles") return "vehicle";
    if (cat === "aviation") return "aircraft";
    return "default";
  }

  // Shape mapping for EntityStore types
  const TYPE_SHAPES = {
    person: "dot", organisation: "box", company: "box", vehicle: "triangle",
    aircraft: "triangle", location: "diamond", phone: "square", email: "square",
    vessel: "triangle", port: "diamond", event: "star", document: "square", default: "dot"
  };

  function _mapStoreTypeToGraphType(type) {
    if (type === "organisation") return "company";
    if (type === "vessel" || type === "aircraft") return "aircraft";
    if (type === "phone" || type === "email" || type === "document") return "default";
    return type;
  }

  function buildStoreNodeTooltip(entity) {
    const lines = [`<b>${escHtml(entity.label || "Unknown")}</b>`];
    const typeDef = window.EntityStore?.ENTITY_TYPES?.[entity.type];
    if (typeDef) lines.push(`Type: ${escHtml(typeDef.label)}`);
    const attrs = entity.attributes || {};
    if (attrs.address) lines.push(`Address: ${escHtml(attrs.address)}`);
    if (attrs.dob) lines.push(`DOB: ${escHtml(attrs.dob)}`);
    if (attrs.vrm) lines.push(`VRM: ${escHtml(attrs.vrm)}`);
    if (attrs.companyNumber) lines.push(`Company #: ${escHtml(attrs.companyNumber)}`);
    const rels = window.EntityStore ? window.EntityStore.getRelationshipsFor(entity.id) : [];
    if (rels.length) lines.push(`Relationships: ${rels.length}`);
    return lines.join("<br>");
  }

  function buildGraphData() {
    // Prefer EntityStore if available and populated
    const useStore = window.EntityStore && window.EntityStore.getAll().length > 0;

    let nodes, edges;

    if (useStore) {
      const storeEntities = window.EntityStore.getAll();
      const storeRels = window.EntityStore.getAllRelationships();
      const entityById = {};
      storeEntities.forEach(e => { entityById[e.id] = e; });

      nodes = storeEntities.map(e => {
        const type = e.type || "default";
        const graphType = _mapStoreTypeToGraphType(type);
        const colors = TYPE_COLORS[graphType] || TYPE_COLORS.default;
        const label = (e.label || "Unknown").slice(0, 30);
        return {
          id: e.id, label,
          title: buildStoreNodeTooltip(e),
          color: { background: colors.bg, border: colors.border, highlight: { background: colors.border, border: "#fff" } },
          font: { color: colors.font, size: 11, face: "Bahnschrift, Segoe UI, sans-serif" },
          shape: TYPE_SHAPES[type] || TYPE_SHAPES.default,
          size: type === "organisation" ? 18 : 14,
          borderWidth: 2, _entityType: type, _entityRef: e.id
        };
      });

      // Build edges from EntityStore relationships
      const storeEdges = storeRels.map(r => {
        if (!entityById[r.fromId] || !entityById[r.toId]) return null;
        const relType = window.EntityStore.RELATIONSHIP_TYPES[r.type];
        const color = EDGE_COLORS[r.type] || relType?.color || EDGE_COLORS.default;
        const displayLabel = r.label || (relType?.label || r.type || "").replace(/_/g, " ");
        return {
          id: r.id, from: r.fromId, to: r.toId,
          label: displayLabel.slice(0, 20),
          color: { color, highlight: "#fff", opacity: 0.8 },
          font: { color: "#94a3b8", size: 9, strokeWidth: 2, strokeColor: "#0f172a", face: "Bahnschrift, sans-serif" },
          width: 2, smooth: { type: "continuous", roundness: 0.2 },
          arrows: { to: { enabled: true, scaleFactor: 0.5 } },
          _connectionType: r.type
        };
      }).filter(Boolean);

      // Also include legacy connections not in store
      const storeEdgeIds = new Set(storeEdges.map(e => e.id));
      const legacyEdges = (window._mapConnections || []).filter(c => !storeEdgeIds.has(c.id)).map(c => {
        const color = EDGE_COLORS[c.type] || EDGE_COLORS.default;
        const fromId = c.metadata?.fromId || resolveEntityByLatLng(c.fromLatLng, storeEntities);
        const toId = c.metadata?.toId || resolveEntityByLatLng(c.toLatLng, storeEntities);
        if (!fromId || !toId || !entityById[fromId] || !entityById[toId]) return null;
        return {
          id: c.id, from: fromId, to: toId,
          label: (c.label || "").slice(0, 20),
          color: { color, highlight: "#fff", opacity: 0.8 },
          font: { color: "#94a3b8", size: 9, strokeWidth: 2, strokeColor: "#0f172a", face: "Bahnschrift, sans-serif" },
          width: 2, smooth: { type: "continuous", roundness: 0.2 },
          arrows: { to: { enabled: true, scaleFactor: 0.5 } },
          _connectionType: c.type
        };
      }).filter(Boolean);

      edges = storeEdges.concat(legacyEdges);
    } else {
      // Legacy path — read from window._mapEntities / _mapConnections
      const entities = window._mapEntities || [];
      const connections = window._mapConnections || [];
      const entityById = {};
      entities.forEach(e => { entityById[e.id] = e; });

      nodes = entities.map(e => {
        const type = inferEntityType(e);
        const colors = TYPE_COLORS[type] || TYPE_COLORS.default;
        const label = (e.label || "Unknown").slice(0, 30);
        return {
          id: e.id, label,
          title: buildNodeTooltip(e),
          color: { background: colors.bg, border: colors.border, highlight: { background: colors.border, border: "#fff" } },
          font: { color: colors.font, size: 11, face: "Bahnschrift, Segoe UI, sans-serif" },
          shape: type === "company" ? "box" : type === "location" ? "diamond" : "dot",
          size: type === "company" ? 18 : 14,
          borderWidth: 2, _entityType: type, _entityRef: e.id
        };
      });

      edges = connections.map(c => {
        const color = EDGE_COLORS[c.type] || EDGE_COLORS.default;
        const fromId = c.metadata?.fromId || resolveEntityByLatLng(c.fromLatLng, entities);
        const toId = c.metadata?.toId || resolveEntityByLatLng(c.toLatLng, entities);
        if (!fromId || !toId || !entityById[fromId] || !entityById[toId]) return null;
        return {
          id: c.id, from: fromId, to: toId,
          label: (c.label || "").slice(0, 20),
          color: { color, highlight: "#fff", opacity: 0.8 },
          font: { color: "#94a3b8", size: 9, strokeWidth: 2, strokeColor: "#0f172a", face: "Bahnschrift, sans-serif" },
          width: 2, smooth: { type: "continuous", roundness: 0.2 },
          arrows: { to: { enabled: true, scaleFactor: 0.5 } },
          _connectionType: c.type
        };
      }).filter(Boolean);
    }

    return { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
  }

  function resolveEntityByLatLng(latLng, entities) {
    if (!latLng || !entities.length) return null;
    const [lat, lng] = Array.isArray(latLng) ? latLng : [latLng.lat, latLng.lng];
    let bestId = null, bestDist = Infinity;
    entities.forEach(e => {
      if (!e.latLng) return;
      const d = Math.abs(e.latLng[0] - lat) + Math.abs(e.latLng[1] - lng);
      if (d < bestDist) { bestDist = d; bestId = e.id; }
    });
    return bestDist < 0.001 ? bestId : null;
  }

  function buildNodeTooltip(entity) {
    const lines = [`<b>${escHtml(entity.label || "Unknown")}</b>`];
    if (entity.address) lines.push(`Address: ${escHtml(entity.address)}`);
    if (entity.notes) lines.push(`Notes: ${escHtml(entity.notes).slice(0, 100)}`);
    if (entity.i2EntityData?.entityType) lines.push(`Type: ${escHtml(entity.i2EntityData.entityType)}`);
    const connCount = (window._mapConnections || []).filter(c =>
      (c.metadata?.fromId === entity.id || c.metadata?.toId === entity.id)
    ).length;
    if (connCount) lines.push(`Connections: ${connCount}`);
    return lines.join("<br>");
  }

  function initNetworkGraph() {
    const container = document.getElementById("network-graph-container");
    if (!container) return;

    if (typeof vis === "undefined") {
      container.innerHTML = '<div class="graph-loading">Loading vis-network library...</div>';
      return;
    }

    _graphData = buildGraphData();

    const options = {
      autoResize: true,
      physics: {
        enabled: true,
        solver: "forceAtlas2Based",
        forceAtlas2Based: {
          gravitationalConstant: -40,
          centralGravity: 0.008,
          springLength: 120,
          springConstant: 0.04,
          damping: 0.4
        },
        stabilization: { iterations: 150, updateInterval: 25 }
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        zoomView: true,
        dragView: true,
        multiselect: true,
        navigationButtons: false,
        keyboard: { enabled: false }
      },
      layout: { improvedLayout: true },
      edges: { smooth: { type: "continuous" } },
      nodes: { shadow: { enabled: true, color: "rgba(0,0,0,0.4)", size: 6 } }
    };

    _network = new vis.Network(container, _graphData, options);

    // Click node → highlight on map
    _network.on("selectNode", (params) => {
      if (!params.nodes.length) return;
      const nodeId = params.nodes[0];
      _selectedNodeId = nodeId;
      const entity = (window._mapEntities || []).find(e => e.id === nodeId);
      if (entity && entity.marker && window._map) {
        window._map.setView(entity.latLng, Math.max(window._map.getZoom(), 13));
        entity.marker.openPopup();
      }
      highlightNeighborhood(nodeId);
    });

    _network.on("deselectNode", () => {
      _selectedNodeId = null;
      resetHighlights();
    });

    // Double-click → zoom to fit all connections
    _network.on("doubleClick", (params) => {
      if (params.nodes.length) {
        const nodeId = params.nodes[0];
        const connectedNodes = _network.getConnectedNodes(nodeId);
        _network.fit({ nodes: [nodeId, ...connectedNodes], animation: true });
      }
    });

    // Hover
    _network.on("hoverNode", (params) => {
      container.style.cursor = "pointer";
    });
    _network.on("blurNode", () => {
      container.style.cursor = "default";
    });

    // Add toolbar buttons
    renderGraphToolbar();
  }

  function highlightNeighborhood(nodeId) {
    const connectedNodes = _network.getConnectedNodes(nodeId);
    const connectedEdges = _network.getConnectedEdges(nodeId);
    _highlightedNodes = new Set([nodeId, ...connectedNodes]);

    // Dim non-connected nodes
    _graphData.nodes.forEach(node => {
      if (_highlightedNodes.has(node.id)) {
        _graphData.nodes.update({ id: node.id, opacity: 1.0 });
      } else {
        _graphData.nodes.update({ id: node.id, opacity: 0.15 });
      }
    });
    _graphData.edges.forEach(edge => {
      const isConnected = connectedEdges.includes(edge.id);
      _graphData.edges.update({ id: edge.id, width: isConnected ? 4 : 1, color: isConnected ? undefined : { opacity: 0.1 } });
    });
  }

  function resetHighlights() {
    _highlightedNodes.clear();
    _graphData.nodes.forEach(node => {
      _graphData.nodes.update({ id: node.id, opacity: 1.0 });
    });
    _graphData.edges.forEach(edge => {
      _graphData.edges.update({ id: edge.id, width: 2, color: undefined });
    });
  }

  function refreshNetworkGraph() {
    const container = document.getElementById("network-graph-container");
    if (!container) return;
    if (!_network) {
      initNetworkGraph();
      return;
    }

    const newData = buildGraphData();

    // Efficiently update only changed data
    _graphData.nodes.clear();
    _graphData.edges.clear();
    newData.nodes.forEach(n => _graphData.nodes.add(n));
    newData.edges.forEach(e => _graphData.edges.add(e));

    _network.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } });
    updateGraphStats();
  }

  function updateGraphStats() {
    const statsEl = document.getElementById("graph-stats");
    if (!statsEl) return;
    const nodeCount = _graphData.nodes?.length || 0;
    const edgeCount = _graphData.edges?.length || 0;
    // Find most connected node
    let maxConn = 0, hubLabel = "None";
    (window._mapEntities || []).forEach(e => {
      const conns = (window._mapConnections || []).filter(c => c.from === e.id || c.to === e.id).length;
      if (conns > maxConn) { maxConn = conns; hubLabel = e.label; }
    });
    statsEl.innerHTML = `<span>Nodes: <strong>${nodeCount}</strong></span>
      <span>Edges: <strong>${edgeCount}</strong></span>
      <span>Hub: <strong>${escHtml(hubLabel.slice(0, 20))}</strong> (${maxConn})</span>`;
  }

  function renderGraphToolbar() {
    const toolbar = document.getElementById("graph-toolbar");
    if (!toolbar) return;
    toolbar.innerHTML = `
      <button class="graph-tool-btn" id="graph-fit-btn" title="Fit all nodes">Fit</button>
      <button class="graph-tool-btn" id="graph-physics-btn" title="Toggle physics">Physics</button>
      <button class="graph-tool-btn" id="graph-hierarchy-btn" title="Hierarchical layout">Hierarchy</button>
      <button class="graph-tool-btn" id="graph-circular-btn" title="Circular layout">Circular</button>
      <button class="graph-tool-btn" id="graph-export-png" title="Export as PNG">PNG</button>
    `;
    let physicsOn = true;
    document.getElementById("graph-fit-btn")?.addEventListener("click", () => {
      _network?.fit({ animation: { duration: 500 } });
    });
    document.getElementById("graph-physics-btn")?.addEventListener("click", () => {
      physicsOn = !physicsOn;
      _network?.setOptions({ physics: { enabled: physicsOn } });
    });
    document.getElementById("graph-hierarchy-btn")?.addEventListener("click", () => {
      _network?.setOptions({
        layout: { hierarchical: { enabled: true, direction: "UD", sortMethod: "hubsize", nodeSpacing: 150 } },
        physics: { enabled: false }
      });
      physicsOn = false;
    });
    document.getElementById("graph-circular-btn")?.addEventListener("click", () => {
      _network?.setOptions({
        layout: { hierarchical: false },
        physics: { enabled: true, solver: "forceAtlas2Based" }
      });
      physicsOn = true;
    });
    document.getElementById("graph-export-png")?.addEventListener("click", () => {
      if (!_network) return;
      const canvas = document.querySelector("#network-graph-container canvas");
      if (canvas) {
        const link = document.createElement("a");
        link.download = `control_room_graph_${Date.now()}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
        if (window.CRDashboard) window.CRDashboard.logActivity("Graph exported as PNG", "", "export");
      }
    });
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Exports ──
  window.refreshNetworkGraph = refreshNetworkGraph;
  window.initNetworkGraph = initNetworkGraph;
})();
