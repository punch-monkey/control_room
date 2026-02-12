// ================== i2_workspace.js ==================
// Local i2 intelligence workspace using parsed spec artifacts.

(function () {
  const state = {
    templates: [],
    schema: null,
    matching: null,
    entities: []
  };
  let workspaceLoaded = false;
  let workspaceLoading = null;

  function esc(value) {
    const d = document.createElement("div");
    d.textContent = value == null ? "" : String(value);
    return d.innerHTML;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    const el = byId(id);
    if (el) el.textContent = text;
  }

  function pickTemplateSummary(t) {
    const entityNames = (t.entities || []).map((e) => e.type_name || e.type_id).filter(Boolean);
    const linkCount = (t.links || []).length;
    const columns = (t.referenced_columns || []).slice(0, 8);
    const colsMore = Math.max(0, (t.referenced_columns || []).length - columns.length);

    return (
      `<div><strong>${esc(t.file || "Template")}</strong></div>` +
      `<div><span class="popup-label">Source</span> ${esc(t.source_type || "Unknown")}</div>` +
      `<div><span class="popup-label">Entities</span> ${esc(entityNames.join(", ") || "None")}</div>` +
      `<div><span class="popup-label">Links</span> ${linkCount}</div>` +
      `<div><span class="popup-label">Actions</span> ${esc((t.actions || []).join(", ") || "None")}</div>` +
      `<div><span class="popup-label">Columns</span> ${esc(columns.join(", ") || "None")}${colsMore ? ` (+${colsMore})` : ""}</div>`
    );
  }

  function renderTemplateOptions() {
    const select = byId("i2-template-select");
    const details = byId("i2-template-details");
    if (!select || !details) return;

    if (!state.templates.length) {
      select.innerHTML = '<option value="">No templates found</option>';
      details.textContent = "No parsed import templates available.";
      return;
    }

    select.innerHTML = '<option value="">Select an import template...</option>';
    state.templates.forEach((t, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = t.file || `Template ${idx + 1}`;
      select.appendChild(opt);
    });

    select.addEventListener("change", () => {
      const idx = Number(select.value);
      if (!Number.isFinite(idx) || !state.templates[idx]) {
        details.textContent = "Select a template to inspect mappings.";
        return;
      }
      details.innerHTML = pickTemplateSummary(state.templates[idx]);
    });
  }

  function renderEntityResults(filter) {
    const wrap = byId("i2-entity-results");
    if (!wrap) return;

    if (!state.entities.length) {
      wrap.textContent = "Entity catalog not available.";
      return;
    }

    const q = String(filter || "").trim().toLowerCase();
    const hits = state.entities.filter((entity) => {
      if (!q) return true;
      const name = String(entity.entity_name || "").toLowerCase();
      const id = String(entity.entity_id || "").toLowerCase();
      if (name.includes(q) || id.includes(q)) return true;
      return (entity.properties || []).some((p) =>
        String(p.property_name || "").toLowerCase().includes(q) ||
        String(p.property_id || "").toLowerCase().includes(q)
      );
    }).slice(0, 8);

    if (!hits.length) {
      wrap.textContent = "No entity type matches.";
      return;
    }

    wrap.innerHTML = hits.map((e) => {
      const required = (e.properties || []).filter((p) => String(p.mandatory).toLowerCase() === "true").length;
      const propNames = (e.properties || []).slice(0, 6).map((p) => p.property_name || p.property_id);
      const more = Math.max(0, (e.properties || []).length - propNames.length);
      return (
        `<div class="i2-entity-card" data-i2-place-id="${esc(e.entity_id || "")}">` +
        `<div class="i2-entity-title">${esc(e.entity_name || e.entity_id)}</div>` +
        `<div class="i2-entity-meta">` +
        `<span>ID ${esc(e.entity_id || "")}</span>` +
        `<span>${(e.properties || []).length} props</span>` +
        `<span>${required} required</span>` +
        `</div>` +
        `<div class="i2-entity-props">${esc(propNames.join(", ") || "No properties")}${more ? ` (+${more})` : ""}</div>` +
        `</div>`
      );
    }).join("");

    wrap.querySelectorAll("[data-i2-place-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const entityId = card.getAttribute("data-i2-place-id");
        if (entityId && typeof window.startI2EntityPlacement === "function") {
          window.startI2EntityPlacement(entityId);
        }
      });
    });
  }

  function wireEntitySearch() {
    const input = byId("i2-entity-search");
    if (!input) return;
    input.addEventListener("input", () => renderEntityResults(input.value));
  }

  function updateStats() {
    setText("i2-template-count", String(state.templates.length || 0));
    setText("i2-entity-count", String(state.schema?.entity_type_count || state.entities.length || 0));
    setText("i2-link-count", String(state.schema?.link_type_count || 0));

    const matchFiles = Array.isArray(state.matching) ? state.matching.length : 0;
    const totalRules = Array.isArray(state.matching)
      ? state.matching.reduce((sum, item) => sum + (item.rule_count || 0), 0)
      : 0;
    setText("i2-rule-count", `${matchFiles}/${totalRules}`);
  }

  async function fetchJson(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
    return r.json();
  }

  async function initI2Workspace() {
    try {
      const [templates, schema, matching, entities] = await Promise.all([
        fetchJson("data/i2 Specs/parsed/import_specs_summary.json"),
        fetchJson("data/i2 Specs/parsed/schema_summary.json"),
        fetchJson("data/i2 Specs/parsed/matching_rules_summary.json"),
        fetchJson("data/i2 Specs/parsed/entity_catalog.json")
      ]);
      state.templates = Array.isArray(templates) ? templates : [];
      state.schema = schema || null;
      state.matching = Array.isArray(matching) ? matching : [];
      state.entities = Array.isArray(entities) ? entities : [];
    } catch (err) {
      console.warn("i2 workspace load failed:", err);
    }

    updateStats();
    renderTemplateOptions();
    wireEntitySearch();
    renderEntityResults("");
  }

  function ensureI2WorkspaceLoaded() {
    if (workspaceLoaded) return Promise.resolve(true);
    if (workspaceLoading) return workspaceLoading;
    workspaceLoading = initI2Workspace()
      .then(() => {
        workspaceLoaded = true;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        workspaceLoading = null;
      });
    return workspaceLoading;
  }

  function initLazyI2Workspace() {
    const details = byId("entities-i2-workspace");
    const templateSelect = byId("i2-template-select");
    const entitySearch = byId("i2-entity-search");

    const triggerLoad = () => {
      ensureI2WorkspaceLoaded();
    };

    if (details) {
      details.addEventListener("toggle", () => {
        if (details.open) triggerLoad();
      });
      if (details.open) triggerLoad();
    }
    templateSelect?.addEventListener("focus", triggerLoad, { once: true });
    entitySearch?.addEventListener("focus", triggerLoad, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLazyI2Workspace);
  } else {
    initLazyI2Workspace();
  }
})();
