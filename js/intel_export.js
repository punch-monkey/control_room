// ================== intel_export.js ==================
// i2 Analyst's Notebook ANX export + 3x5x2 Intelligence Report generator (NCA Standard)

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════
  // i2 ANX (Analyst's Notebook XML) EXPORT
  // ═══════════════════════════════════════════════════

  // ANX is i2's XML chart format. This generates a valid XML file
  // that can be imported into Analyst's Notebook.
  function exportI2ANX() {
    const entities = window._mapEntities || [];
    const connections = window._mapConnections || [];

    if (!entities.length) {
      if (typeof showToast === "function") showToast("No entities to export", "error");
      return;
    }

    const timestamp = new Date().toISOString();
    const entityById = {};
    entities.forEach(e => { entityById[e.id] = e; });

    // Build XML
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<Chart xmlns="urn:i2:anb" SchemaVersion="3.0" TimeZone="UTC">\n`;
    xml += `  <Summary>\n`;
    xml += `    <Description>Control Room Export - ${escXml(timestamp)}</Description>\n`;
    xml += `    <DateTimeCreated>${timestamp}</DateTimeCreated>\n`;
    xml += `    <Notes>Exported from Control Room intelligence dashboard. Contains ${entities.length} entities and ${connections.length} connections.</Notes>\n`;
    xml += `  </Summary>\n`;

    // Chart Items (Entities)
    xml += `  <ChartItemCollection>\n`;
    entities.forEach((e, idx) => {
      const i2Type = mapToI2EntityType(e);
      const attrs = buildI2Attributes(e);
      xml += `    <ChartItem Id="${escXml(e.id)}" Label="${escXml(e.label)}">\n`;
      xml += `      <End>\n`;
      xml += `        <Entity EntityTypeId="${escXml(i2Type)}" Identity="${escXml(e.id)}">\n`;
      xml += `          <Icon IconStyle="Standard" />\n`;
      if (attrs.length) {
        xml += `          <CardCollection>\n`;
        xml += `            <Card>\n`;
        attrs.forEach(a => {
          xml += `              <Attribute AttributeClassId="${escXml(a.classId)}" Value="${escXml(a.value)}" />\n`;
        });
        xml += `            </Card>\n`;
        xml += `          </CardCollection>\n`;
      }
      xml += `        </Entity>\n`;
      xml += `      </End>\n`;
      // Position for visual layout
      xml += `      <Location>\n`;
      xml += `        <Point X="${(idx % 10) * 150}" Y="${Math.floor(idx / 10) * 120}" />\n`;
      xml += `      </Location>\n`;
      xml += `    </ChartItem>\n`;
    });

    // Links (Connections)
    connections.forEach(c => {
      const fromEntity = entityById[c.from];
      const toEntity = entityById[c.to];
      if (!fromEntity || !toEntity) return;

      xml += `    <ChartItem Id="${escXml(c.id)}" Label="${escXml(c.label || "")}">\n`;
      xml += `      <Link End1Id="${escXml(c.from)}" End2Id="${escXml(c.to)}" LinkTypeId="${escXml(mapToI2LinkType(c.type))}">\n`;
      if (c.label) {
        xml += `        <LinkStrength Value="Confirmed" />\n`;
        xml += `        <Attribute AttributeClassId="LinkLabel" Value="${escXml(c.label)}" />\n`;
      }
      xml += `      </Link>\n`;
      xml += `    </ChartItem>\n`;
    });

    xml += `  </ChartItemCollection>\n`;

    // Entity Types Definition
    xml += `  <EntityTypeCollection>\n`;
    const usedTypes = new Set(entities.map(e => mapToI2EntityType(e)));
    usedTypes.forEach(t => {
      xml += `    <EntityType Id="${escXml(t)}" Name="${escXml(t)}" />\n`;
    });
    xml += `  </EntityTypeCollection>\n`;

    // Link Types Definition
    xml += `  <LinkTypeCollection>\n`;
    const usedLinkTypes = new Set(connections.map(c => mapToI2LinkType(c.type)));
    usedLinkTypes.forEach(t => {
      xml += `    <LinkType Id="${escXml(t)}" Name="${escXml(t)}" />\n`;
    });
    xml += `  </LinkTypeCollection>\n`;

    // Attribute Classes
    xml += `  <AttributeClassCollection>\n`;
    const attrClasses = new Set();
    entities.forEach(e => {
      buildI2Attributes(e).forEach(a => attrClasses.add(a.classId));
    });
    attrClasses.add("LinkLabel");
    attrClasses.forEach(c => {
      xml += `    <AttributeClass Id="${escXml(c)}" Name="${escXml(c)}" Type="Text" />\n`;
    });
    xml += `  </AttributeClassCollection>\n`;

    xml += `</Chart>\n`;

    // Download
    downloadFile(xml, `control_room_i2_export_${Date.now()}.anx`, "application/xml");
    if (window.CRDashboard) window.CRDashboard.logActivity("i2 ANX exported", `${entities.length} entities, ${connections.length} links`, "export");
    if (typeof showToast === "function") showToast(`Exported ${entities.length} entities to i2 ANX format`, "success");
  }

  function mapToI2EntityType(entity) {
    const i2 = entity.i2EntityData;
    if (i2?.entityType) return i2.entityType;
    const cat = (entity.iconData?.category || "").toLowerCase();
    const map = {
      people: "Person", buildings: "Location", financial: "Organisation",
      vehicles: "Vehicle", aviation: "Aircraft", military: "Operation",
      communication: "Communication Entity", real_estate: "Location"
    };
    return map[cat] || "Entity";
  }

  function mapToI2LinkType(type) {
    const map = {
      officer: "Officer Appointment", psc: "Significant Control",
      manual: "Association", default: "Connection"
    };
    return map[type] || map.default;
  }

  function buildI2Attributes(entity) {
    const attrs = [];
    if (entity.label) attrs.push({ classId: "Label", value: entity.label });
    if (entity.address) attrs.push({ classId: "Address", value: entity.address });
    if (entity.notes) attrs.push({ classId: "Notes", value: entity.notes });
    if (entity.latLng) {
      attrs.push({ classId: "Latitude", value: String(entity.latLng[0]) });
      attrs.push({ classId: "Longitude", value: String(entity.latLng[1]) });
    }
    // i2 entity fields
    const values = entity.i2EntityData?.values || {};
    Object.entries(values).forEach(([k, v]) => {
      if (v && String(v).trim()) attrs.push({ classId: k.replace(/\s+/g, "_"), value: String(v) });
    });
    return attrs;
  }

  // ═══════════════════════════════════════════════════
  // 3x5x2 INTELLIGENCE REPORT (NCA Standard)
  // ═══════════════════════════════════════════════════

  // The 3x5x2 system is the current NCA/College of Policing standard:
  // Source Evaluation (A-C), Intelligence Assessment (1-5), Handling Code (P/C)

  const SOURCE_GRADES = {
    A: "Reliable — No doubt about authenticity, trustworthiness, competence, or track record of reliability",
    B: "Untested — Source has not yet been tested or not tested against this type of intelligence",
    C: "Not reliable — Doubts exist about the reliability, trustworthiness, or competence of the source"
  };

  const INTEL_GRADES = {
    1: "Known to be true without reservation",
    2: "Known personally to the source but not otherwise corroborated",
    3: "Not known personally to the source but corroborated by other information",
    4: "Cannot be judged — insufficient information to evaluate",
    5: "Suspected to be false, based on unreliable information or an unreliable source"
  };

  const HANDLING_CODES = {
    P: "Permits dissemination — May be shared with other agencies and partners in line with local policy",
    C: "Confidential — Do not disseminate; refer to originator before any onward sharing"
  };

  // Intel source types — includes restricted LE/FI systems (data entry only, no API)
  const INTEL_SOURCE_TYPES = {
    primary:    { label: "Primary Source",        desc: "Direct intelligence from the reporting officer or agent", restricted: false },
    supplementary: { label: "Supplementary Intel",  desc: "Corroborating or additional intelligence from other sources", restricted: false },
    sar:        { label: "SAR (Suspicious Activity Report)", desc: "Filed under Part 7 of POCA 2002 / S21A of the Terrorism Act 2000", restricted: true },
    experian:   { label: "Experian / Credit Reference", desc: "Credit history, address links, associates — Experian, Equifax, TransUnion", restricted: true },
    connexus:   { label: "GB Connexus",            desc: "NCA gateway intelligence sharing platform", restricted: true },
    pnc:        { label: "PNC (Police National Computer)", desc: "Criminal records, wanted/missing, vehicle checks, disqualified drivers", restricted: true },
    pnd:        { label: "PND (Police National Database)", desc: "Intelligence reports, custody records, crime reports across forces", restricted: true },
    elmer:      { label: "ELMER/DAML",             desc: "Defence Against Money Laundering — SARs database held by UKFIU", restricted: true },
    companies_house: { label: "Companies House",   desc: "Public company filings, officers, PSC data", restricted: false },
    land_registry:   { label: "HM Land Registry",  desc: "Property ownership, price paid, title deeds", restricted: false },
    open_source: { label: "Open Source (OSINT)",   desc: "Publicly available information — social media, media, web", restricted: false },
    other:      { label: "Other",                  desc: "Specify source in notes field", restricted: false }
  };

  let _intelEntries = [];

  function generate3x5x2Report() {
    _intelEntries = [];
    const modal = document.createElement("div");
    modal.className = "intel-report-overlay";
    modal.id = "intel-report-modal";

    const entities = window._mapEntities || [];
    const connections = window._mapConnections || [];

    modal.innerHTML = `
      <div class="intel-report-dialog">
        <div class="intel-report-header">
          <span class="intel-report-title">3x5x2 INTELLIGENCE REPORT</span>
          <span class="intel-report-subtitle">NCA / College of Policing Standard</span>
          <button class="intel-report-close" id="intel-report-close">&times;</button>
        </div>
        <div class="intel-report-body">
          <div class="intel-report-section">
            <label>Report Reference</label>
            <input type="text" id="ir-reference" placeholder="e.g. INT/2026/0214/001" value="INT/${new Date().getFullYear()}/${String(new Date().getMonth()+1).padStart(2,'0')}${String(new Date().getDate()).padStart(2,'0')}/${String(Math.floor(Math.random()*999)+1).padStart(3,'0')}" />
          </div>

          <div class="intel-report-section">
            <label>Reporting Officer</label>
            <input type="text" id="ir-officer" placeholder="Rank / Name / Collar Number" />
          </div>

          <div class="intel-report-section">
            <label>Date/Time of Report</label>
            <input type="datetime-local" id="ir-datetime" value="${new Date().toISOString().slice(0,16)}" />
          </div>

          <div class="intel-report-row-3">
            <div class="intel-report-section">
              <label>Source Evaluation (A-C)</label>
              <select id="ir-source-grade">
                ${Object.entries(SOURCE_GRADES).map(([k, v]) => `<option value="${k}" title="${esc(v)}">${k} — ${v.split("—")[0].trim()}</option>`).join("")}
              </select>
            </div>
            <div class="intel-report-section">
              <label>Intelligence Assessment (1-5)</label>
              <select id="ir-intel-grade">
                ${Object.entries(INTEL_GRADES).map(([k, v]) => `<option value="${k}">${k} — ${v.split("—")[0].trim()}</option>`).join("")}
              </select>
            </div>
            <div class="intel-report-section">
              <label>Handling Code (P/C)</label>
              <select id="ir-handling-code">
                ${Object.entries(HANDLING_CODES).map(([k, v]) => `<option value="${k}">${k} — ${v.split("—")[0].trim()}</option>`).join("")}
              </select>
            </div>
          </div>

          <div class="intel-report-section">
            <label>Subject / Target</label>
            <input type="text" id="ir-subject" placeholder="Person, organisation, or subject of intelligence" />
          </div>

          <div class="intel-report-section">
            <label>Risk Assessment</label>
            <select id="ir-risk">
              <option value="low">Low — No threat to life or operations</option>
              <option value="medium">Medium — Potential operational risk</option>
              <option value="high">High — Significant risk to life, operations, or sources</option>
              <option value="critical">Critical — Immediate threat to life</option>
            </select>
          </div>

          <div class="intel-report-divider">INTELLIGENCE ENTRIES</div>

          <div class="intel-entries-toolbar">
            <select id="ir-new-entry-type">
              ${Object.entries(INTEL_SOURCE_TYPES).map(([k, v]) => `<option value="${k}" ${v.restricted ? 'class="ir-restricted"' : ''}>${v.label}${v.restricted ? " [RESTRICTED]" : ""}</option>`).join("")}
            </select>
            <button class="btn-primary btn-sm" id="ir-add-entry" type="button">+ Add Entry</button>
          </div>

          <div id="ir-entries-list" class="ir-entries-list">
            <div class="ir-entries-empty">No entries yet. Add a primary source entry to begin.</div>
          </div>

          <div class="intel-report-section">
            <label>Entities Referenced (${entities.length} on map)</label>
            <div class="ir-entity-chips" id="ir-entity-chips">
              ${entities.slice(0, 30).map(e => `<span class="ir-chip" data-eid="${e.id}">${esc(e.label.slice(0,25))}</span>`).join("")}
            </div>
          </div>

          <div class="intel-report-section">
            <label>Sanitisation Notes</label>
            <textarea id="ir-sanitisation" rows="2" placeholder="Any redactions or sanitisation applied..."></textarea>
          </div>

          <div class="intel-report-actions">
            <button class="btn-primary" id="ir-generate-pdf">Generate PDF Report</button>
            <button class="btn-secondary" id="ir-export-json">Export as JSON</button>
            <button class="btn-secondary" id="ir-copy-text">Copy as Text</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById("intel-report-close")?.addEventListener("click", () => modal.remove());

    // Add entry button
    document.getElementById("ir-add-entry")?.addEventListener("click", () => {
      const typeKey = document.getElementById("ir-new-entry-type")?.value || "primary";
      addIntelEntry(typeKey);
    });

    // Generate PDF
    document.getElementById("ir-generate-pdf")?.addEventListener("click", () => {
      collectIntelEntryData();
      const reportData = collectReportData();
      generateReportPDF(reportData);
      modal.remove();
    });

    // Export JSON
    document.getElementById("ir-export-json")?.addEventListener("click", () => {
      collectIntelEntryData();
      const reportData = collectReportData();
      downloadFile(JSON.stringify(reportData, null, 2), `3x5x2_report_${Date.now()}.json`, "application/json");
      modal.remove();
    });

    // Copy text
    document.getElementById("ir-copy-text")?.addEventListener("click", () => {
      collectIntelEntryData();
      const reportData = collectReportData();
      const text = formatReportAsText(reportData);
      navigator.clipboard?.writeText(text);
      if (typeof showToast === "function") showToast("Report copied to clipboard", "success");
    });

    // Auto-add a primary source entry
    addIntelEntry("primary");
  }

  function addIntelEntry(typeKey) {
    const sourceType = INTEL_SOURCE_TYPES[typeKey] || INTEL_SOURCE_TYPES.primary;
    const entryId = `ir-entry-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const entry = { id: entryId, type: typeKey, sourceType };
    _intelEntries.push(entry);
    renderIntelEntries();
  }

  function removeIntelEntry(entryId) {
    _intelEntries = _intelEntries.filter(e => e.id !== entryId);
    renderIntelEntries();
  }

  function renderIntelEntries() {
    const container = document.getElementById("ir-entries-list");
    if (!container) return;
    if (!_intelEntries.length) {
      container.innerHTML = '<div class="ir-entries-empty">No entries yet. Add a primary source entry to begin.</div>';
      return;
    }
    container.innerHTML = _intelEntries.map((entry, idx) => {
      const st = entry.sourceType;
      const restrictedBadge = st.restricted ? '<span class="ir-restricted-badge">RESTRICTED</span>' : '';
      return `<div class="ir-entry-card" data-entry-id="${entry.id}">
        <div class="ir-entry-header">
          <span class="ir-entry-number">${idx + 1}</span>
          <span class="ir-entry-type-label">${esc(st.label)}</span>
          ${restrictedBadge}
          <button class="ir-entry-remove" data-remove-id="${entry.id}" type="button" title="Remove entry">&times;</button>
        </div>
        <div class="ir-entry-desc">${esc(st.desc)}</div>
        <div class="ir-entry-fields">
          <label>Source Reference / Log Number</label>
          <input type="text" class="ir-entry-ref" placeholder="${getRefPlaceholder(entry.type)}" />
          <label>Date of Intelligence</label>
          <input type="datetime-local" class="ir-entry-date" value="${new Date().toISOString().slice(0,16)}" />
          <label>Intelligence Summary</label>
          <textarea class="ir-entry-text" rows="3" placeholder="${getTextPlaceholder(entry.type)}"></textarea>
          ${st.restricted ? `<div class="ir-entry-restricted-note">This source system is not publicly accessible. Data must be entered manually from an authorised terminal.</div>` : ''}
        </div>
      </div>`;
    }).join("");

    // Wire remove buttons
    container.querySelectorAll("[data-remove-id]").forEach(btn => {
      btn.addEventListener("click", () => removeIntelEntry(btn.dataset.removeId));
    });
  }

  function getRefPlaceholder(type) {
    const placeholders = {
      primary: "e.g. Source reference or handler code",
      supplementary: "e.g. Cross-reference number",
      sar: "e.g. SAR URN / UKFIU reference",
      experian: "e.g. Experian search reference / batch ID",
      connexus: "e.g. Connexus log reference",
      pnc: "e.g. PNC ID / CRO number",
      pnd: "e.g. PND reference / intelligence log number",
      elmer: "e.g. DAML reference / SAR number",
      companies_house: "e.g. Company number",
      land_registry: "e.g. Title number",
      open_source: "e.g. URL or media reference",
      other: "Reference number"
    };
    return placeholders[type] || "Reference";
  }

  function getTextPlaceholder(type) {
    const placeholders = {
      primary: "Primary intelligence narrative...",
      supplementary: "Corroborating or supplementary intelligence...",
      sar: "SAR summary — filing reason, subjects, financial activity...",
      experian: "Credit search results — addresses linked, financial associations...",
      connexus: "Connexus intelligence summary — linked records, partner contributions...",
      pnc: "PNC check results — convictions, bail conditions, markers...",
      pnd: "PND intelligence — linked reports, custody, crime records...",
      elmer: "DAML/ELMER results — consent status, linked SARs...",
      companies_house: "Company details — officers, filing history, PSC data...",
      land_registry: "Property details — ownership, price paid, title info...",
      open_source: "Open source findings — social media, press, public records...",
      other: "Intelligence text..."
    };
    return placeholders[type] || "Intelligence text...";
  }

  function collectIntelEntryData() {
    const container = document.getElementById("ir-entries-list");
    if (!container) return;
    const cards = container.querySelectorAll(".ir-entry-card");
    cards.forEach((card, idx) => {
      if (_intelEntries[idx]) {
        _intelEntries[idx].reference = card.querySelector(".ir-entry-ref")?.value || "";
        _intelEntries[idx].date = card.querySelector(".ir-entry-date")?.value || "";
        _intelEntries[idx].text = card.querySelector(".ir-entry-text")?.value || "";
      }
    });
  }

  function collectReportData() {
    return {
      reference: document.getElementById("ir-reference")?.value || "",
      officer: document.getElementById("ir-officer")?.value || "",
      datetime: document.getElementById("ir-datetime")?.value || "",
      sourceGrade: document.getElementById("ir-source-grade")?.value || "B",
      intelGrade: document.getElementById("ir-intel-grade")?.value || "4",
      handlingCode: document.getElementById("ir-handling-code")?.value || "P",
      subject: document.getElementById("ir-subject")?.value || "",
      sanitisation: document.getElementById("ir-sanitisation")?.value || "",
      risk: document.getElementById("ir-risk")?.value || "low",
      entries: _intelEntries.map(e => ({
        type: e.type,
        label: e.sourceType.label,
        restricted: e.sourceType.restricted,
        reference: e.reference || "",
        date: e.date || "",
        text: e.text || ""
      })),
      // Legacy compat — first entry text as primary
      text: _intelEntries[0]?.text || "",
      entityCount: window._mapEntities?.length || 0,
      connectionCount: window._mapConnections?.length || 0,
      gradeLabel: `${document.getElementById("ir-source-grade")?.value || "B"}${document.getElementById("ir-intel-grade")?.value || "4"}${document.getElementById("ir-handling-code")?.value || "P"}`
    };
  }

  function formatReportAsText(r) {
    const entriesText = (r.entries || []).map((e, i) => {
      return `
  ENTRY ${i + 1}: ${e.label}${e.restricted ? " [RESTRICTED]" : ""}
  Reference: ${e.reference || "N/A"}
  Date:      ${e.date || "N/A"}
  ${e.text || "No detail provided."}`;
    }).join("\n  ───────────────────────────────────────────\n");

    return `═══════════════════════════════════════════════
3x5x2 INTELLIGENCE REPORT (NCA Standard)
═══════════════════════════════════════════════
Reference:       ${r.reference}
Classification:  ${r.gradeLabel} (Source: ${r.sourceGrade}, Intel: ${r.intelGrade}, Handling: ${r.handlingCode})
Date/Time:       ${r.datetime}
Officer:         ${r.officer}
Risk Level:      ${r.risk.toUpperCase()}

───────────────────────────────────────────────
SUBJECT: ${r.subject}
───────────────────────────────────────────────

SOURCE EVALUATION: ${r.sourceGrade} — ${SOURCE_GRADES[r.sourceGrade] || "Unknown"}
INTEL ASSESSMENT:  ${r.intelGrade} — ${INTEL_GRADES[r.intelGrade] || "Unknown"}
HANDLING CODE:     ${r.handlingCode} — ${HANDLING_CODES[r.handlingCode] || "Unknown"}

───────────────────────────────────────────────
INTELLIGENCE ENTRIES (${(r.entries || []).length}):
${entriesText || "  No entries."}

───────────────────────────────────────────────
ENTITIES: ${r.entityCount} mapped | CONNECTIONS: ${r.connectionCount}
SANITISATION: ${r.sanitisation || "None"}

───────────────────────────────────────────────
Generated by Control Room — ${new Date().toISOString()}
═══════════════════════════════════════════════`;
  }

  function generateReportPDF(r) {
    if (typeof jspdf === "undefined" && typeof window.jspdf === "undefined") {
      if (typeof showToast === "function") showToast("jsPDF not loaded", "error");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth = 210;
    const margin = 20;
    const textWidth = pageWidth - 2 * margin;
    let y = margin;

    // Header
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, pageWidth, 40, "F");
    doc.setTextColor(45, 212, 191);
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text("3x5x2 INTELLIGENCE REPORT", margin, 18);
    doc.setFontSize(10);
    doc.setTextColor(148, 163, 184);
    doc.text(`Reference: ${r.reference}`, margin, 28);
    doc.text(`Classification: ${r.gradeLabel}`, margin, 34);
    doc.text(`Generated: ${new Date().toISOString()}`, pageWidth - margin - 60, 34);

    y = 50;

    // Grading strip
    doc.setFillColor(30, 41, 55);
    doc.rect(margin, y, textWidth, 24, "F");
    doc.setTextColor(251, 191, 36);
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(`Source: ${r.sourceGrade}`, margin + 4, y + 8);
    doc.text(`Intelligence: ${r.intelGrade}`, margin + 45, y + 8);
    doc.text(`Handling: ${r.handlingCode}`, margin + 100, y + 8);
    const riskColors = { low: [34, 197, 94], medium: [245, 158, 11], high: [239, 68, 68], critical: [220, 38, 38] };
    const rc = riskColors[r.risk] || riskColors.low;
    doc.setTextColor(rc[0], rc[1], rc[2]);
    doc.text(`Risk: ${r.risk.toUpperCase()}`, margin + 4, y + 18);
    doc.setTextColor(148, 163, 184);
    doc.text(`Officer: ${r.officer}`, margin + 45, y + 18);
    doc.text(`Date: ${r.datetime}`, margin + 100, y + 18);
    y += 32;

    // Subject
    doc.setTextColor(226, 232, 240);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("SUBJECT", margin, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(241, 245, 249);
    const subjectLines = doc.splitTextToSize(r.subject || "Not specified", textWidth);
    doc.text(subjectLines, margin, y);
    y += subjectLines.length * 5 + 8;

    // Intelligence entries
    const entries = r.entries || [];
    if (entries.length) {
      doc.setTextColor(226, 232, 240);
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text(`INTELLIGENCE ENTRIES (${entries.length})`, margin, y);
      y += 8;

      entries.forEach((entry, idx) => {
        if (y > 250) { doc.addPage(); y = margin; }

        // Entry header bar
        doc.setFillColor(25, 35, 50);
        doc.rect(margin, y - 3, textWidth, 12, "F");
        doc.setTextColor(103, 232, 249);
        doc.setFontSize(9);
        doc.setFont("helvetica", "bold");
        doc.text(`ENTRY ${idx + 1}: ${entry.label || "Unknown"}${entry.restricted ? " [RESTRICTED]" : ""}`, margin + 4, y + 4);
        if (entry.reference) {
          doc.setTextColor(148, 163, 184);
          doc.setFont("helvetica", "normal");
          doc.text(`Ref: ${entry.reference}`, margin + textWidth - 50, y + 4);
        }
        y += 14;

        if (entry.date) {
          doc.setTextColor(148, 163, 184);
          doc.setFontSize(8);
          doc.text(`Date: ${entry.date}`, margin + 4, y);
          y += 5;
        }

        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(203, 213, 225);
        const entryLines = doc.splitTextToSize(entry.text || "No detail provided.", textWidth - 8);
        entryLines.forEach(line => {
          if (y > 270) { doc.addPage(); y = margin; }
          doc.text(line, margin + 4, y);
          y += 4.5;
        });
        y += 6;
      });
    } else {
      doc.setTextColor(226, 232, 240);
      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.text("INTELLIGENCE", margin, y);
      y += 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(203, 213, 225);
      const intelLines = doc.splitTextToSize(r.text || "No intelligence text provided.", textWidth);
      intelLines.forEach(line => {
        if (y > 270) { doc.addPage(); y = margin; }
        doc.text(line, margin, y);
        y += 4.5;
      });
    }
    y += 8;

    // Grading explanations
    if (y > 240) { doc.addPage(); y = margin; }
    doc.setFillColor(30, 41, 55);
    doc.rect(margin, y, textWidth, 30, "F");
    doc.setTextColor(148, 163, 184);
    doc.setFontSize(8);
    doc.text(`Source ${r.sourceGrade}: ${SOURCE_GRADES[r.sourceGrade] || ""}`, margin + 4, y + 6);
    doc.text(`Intel ${r.intelGrade}: ${INTEL_GRADES[r.intelGrade] || ""}`, margin + 4, y + 14);
    doc.text(`Handling ${r.handlingCode}: ${HANDLING_CODES[r.handlingCode] || ""}`, margin + 4, y + 22);
    y += 38;

    // Summary
    if (y > 260) { doc.addPage(); y = margin; }
    doc.setTextColor(100, 116, 139);
    doc.setFontSize(8);
    doc.text(`Entities: ${r.entityCount} | Connections: ${r.connectionCount} | Sanitisation: ${r.sanitisation || "None"}`, margin, y);
    y += 10;
    doc.text("Generated by Control Room Intelligence Dashboard", margin, y);

    // Save
    doc.save(`3x5x2_${r.reference.replace(/[/\\]/g, "_")}_${Date.now()}.pdf`);
    if (window.CRDashboard) window.CRDashboard.logActivity("3x5x2 report generated", r.reference, "export");
    if (typeof showToast === "function") showToast("3x5x2 report PDF generated", "success");
  }

  // ═══════════════════════════════════════════════════
  // EXCEL STRUCTURED EXPORT
  // ═══════════════════════════════════════════════════

  function exportStructuredExcel() {
    if (typeof XLSX === "undefined") {
      if (typeof showToast === "function") showToast("XLSX library not loaded", "error");
      return;
    }

    const entities = window._mapEntities || [];
    const connections = window._mapConnections || [];
    const wb = XLSX.utils.book_new();

    // Cover sheet
    const coverData = [
      ["CONTROL ROOM — Intelligence Export"],
      ["Generated", new Date().toISOString()],
      ["Entities", entities.length],
      ["Connections", connections.length],
      [""],
      ["This workbook contains:"],
      ["1. Entity Register — All mapped entities with i2 attributes"],
      ["2. Link Matrix — All connections between entities"],
      ["3. Timeline — Chronological events extracted from entity data"],
      ["4. Geographic Summary — Entity distribution by region"]
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(coverData), "Cover");

    // Entity Register
    const entityRows = entities.map(e => ({
      ID: e.id,
      Label: e.label,
      Type: e.i2EntityData?.entityType || "",
      Category: e.iconData?.category || "",
      Address: e.address,
      Latitude: e.latLng?.[0],
      Longitude: e.latLng?.[1],
      Notes: e.notes,
      ...flattenI2Values(e.i2EntityData?.values)
    }));
    if (entityRows.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entityRows), "Entity Register");
    }

    // Link Matrix
    const linkRows = connections.map(c => {
      const from = entities.find(e => e.id === c.from);
      const to = entities.find(e => e.id === c.to);
      return {
        LinkID: c.id,
        FromID: c.from,
        FromLabel: from?.label || "",
        ToID: c.to,
        ToLabel: to?.label || "",
        LinkType: c.type,
        LinkLabel: c.label,
        Strength: "Confirmed"
      };
    });
    if (linkRows.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linkRows), "Link Matrix");
    }

    XLSX.writeFile(wb, `control_room_intel_export_${Date.now()}.xlsx`);
    if (window.CRDashboard) window.CRDashboard.logActivity("Excel intel report exported", `${entities.length} entities`, "export");
    if (typeof showToast === "function") showToast("Structured Excel report exported", "success");
  }

  function flattenI2Values(values) {
    if (!values || typeof values !== "object") return {};
    const flat = {};
    Object.entries(values).forEach(([k, v]) => {
      if (v && String(v).trim()) flat[`i2_${k.replace(/\s+/g, "_")}`] = String(v);
    });
    return flat;
  }

  // ═══════════════════════════════════════════════════
  // ADDITIONAL DATA SOURCES
  // ═══════════════════════════════════════════════════

  // Land Registry Price Paid (free CSV from gov.uk)
  async function searchLandRegistry(postcode) {
    if (!postcode) return [];
    try {
      const clean = postcode.replace(/\s+/g, "").toUpperCase();
      const url = `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${encodeURIComponent(postcode)}&_pageSize=20&_sort=-transactionDate`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      const results = (data.result?.items || []).map(item => ({
        price: item.pricePaid,
        date: item.transactionDate,
        address: [item.propertyAddress?.paon, item.propertyAddress?.street, item.propertyAddress?.town].filter(Boolean).join(", "),
        postcode: item.propertyAddress?.postcode,
        type: item.propertyType?.replace("http://landregistry.data.gov.uk/def/common/", ""),
        newBuild: item.newBuild === "true"
      }));
      if (window.CRDashboard) window.CRDashboard.addSearchHistory("land_registry", postcode, results.length);
      return results;
    } catch (err) {
      console.warn("Land Registry search failed:", err);
      return [];
    }
  }

  // Insolvency Service — Disqualified Directors
  async function searchDisqualifiedDirectors(name) {
    if (!name || name.length < 3) return [];
    try {
      const apiKey = window.CH_API_KEY || "";
      if (!apiKey) return [];
      const url = `https://api.company-information.service.gov.uk/search/disqualified-officers?q=${encodeURIComponent(name)}&items_per_page=20`;
      const resp = await fetch(url, { headers: { Authorization: "Basic " + btoa(apiKey + ":") } });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.items || []).map(item => ({
        name: item.title,
        dateOfBirth: item.date_of_birth ? `${item.date_of_birth.month}/${item.date_of_birth.year}` : "",
        address: item.address ? [item.address.address_line_1, item.address.locality, item.address.postal_code].filter(Boolean).join(", ") : "",
        disqualifiedFrom: item.disqualified_from,
        disqualifiedUntil: item.disqualified_until,
        snippet: item.snippet || ""
      }));
    } catch (err) {
      console.warn("Disqualified directors search failed:", err);
      return [];
    }
  }

  // Charity Commission (basic search)
  async function searchCharities(name) {
    if (!name || name.length < 3) return [];
    try {
      const url = `https://api.charitycommission.gov.uk/register/api/allcharitydetailsV2/0/${encodeURIComponent(name)}/1/10`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data || []).map(item => ({
        name: item.CharityName || item.charity_name,
        number: item.RegisteredCharityNumber || item.charity_number,
        status: item.CharityRegistrationStatus || "Unknown",
        activities: item.ActivitiesForGrantMaking || ""
      }));
    } catch (err) {
      console.warn("Charity Commission search failed:", err);
      return [];
    }
  }

  // ── Helpers ──
  function escXml(str) {
    return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Exports ──
  window.exportI2ANX = exportI2ANX;
  window.generate3x5x2Report = generate3x5x2Report;
  window.generate5x5x5Report = generate3x5x2Report; // backward compat alias
  window.exportStructuredExcel = exportStructuredExcel;
  window.searchLandRegistry = searchLandRegistry;
  window.searchDisqualifiedDirectors = searchDisqualifiedDirectors;
  window.searchCharities = searchCharities;
})();
