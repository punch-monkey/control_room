// -------------------------------------------------------
// Document Converter — standardised filename & description
// -------------------------------------------------------
(function () {
  "use strict";

  // Originator detection patterns (order matters — first match wins)
  const ORIGINATOR_PATTERNS = [
    { re: /EXPERIAN\s+CREDIT\s+REPORT/i, name: "Experian" },
    { re: /EQUIFAX\s+CREDIT\s+REPORT/i, name: "Equifax" },
    { re: /GB\s*CONNEXUS/i, name: "GB Connexus" },
    { re: /COMPANIES\s+HOUSE/i, name: "Companies House" },
    { re: /DVLA\s+VEHICLE/i, name: "DVLA" },
    { re: /POLICE\s+NATIONAL\s+COMPUTER|PNC\s+NOMINAL/i, name: "PNC" },
    { re: /POLICE\s+NATIONAL\s+DATABASE|PND\s+INTELLIGENCE/i, name: "PND" },
    { re: /^IR\d+\s*\n/m, name: "Intelligence Report" },
    { re: /LAND\s+REGISTRY/i, name: "Land Registry" },
    { re: /CHARITY\s+COMMISSION/i, name: "Charity Commission" },
    { re: /HMRC/i, name: "HMRC" },
    { re: /ATLAS\s*CM/i, name: "Atlas CM" },
    { re: /GBG/i, name: "GBG" },
    { re: /CIFAS/i, name: "CIFAS" },
    { re: /NATIONAL\s+CRIME\s+AGENCY|NCA/i, name: "NCA" },
  ];

  // Extract text content from a File object
  async function extractText(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "txt") {
      return await file.text();
    }
    if (ext === "pdf") {
      // Use pdf.js if available, otherwise fallback to filename-only parsing
      if (window.pdfjsLib) {
        try {
          const buf = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
          let text = "";
          const maxPages = Math.min(pdf.numPages, 5); // first 5 pages enough for metadata
          for (let i = 1; i <= maxPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            text += tc.items.map((it) => it.str).join(" ") + "\n";
          }
          return text;
        } catch (e) {
          console.warn("PDF text extraction failed:", e);
        }
      }
      // Fallback: use filename hints
      return file.name;
    }
    return await file.text();
  }

  // Detect originator from text content
  function detectOriginator(text, filename) {
    for (const p of ORIGINATOR_PATTERNS) {
      if (p.re.test(text)) return p.name;
    }
    // Fallback: guess from filename
    const fn = filename.toLowerCase();
    if (fn.includes("experian")) return "Experian";
    if (fn.includes("equifax")) return "Equifax";
    if (fn.includes("connexus") || fn.includes("gbconnexus")) return "GB Connexus";
    if (fn.includes("companies_house") || fn.includes("companies house")) return "Companies House";
    if (fn.includes("dvla")) return "DVLA";
    if (fn.includes("pnc")) return "PNC";
    if (fn.includes("pnd")) return "PND";
    if (fn.includes("atlas")) return "Atlas CM";
    if (fn.includes("gbg")) return "GBG";
    return "Unknown Source";
  }

  // Extract subject name from text
  function extractSubjectName(text) {
    // Try structured field patterns first
    const patterns = [
      /(?:Subject\s+Name|Full\s+Name|Registered\s+Keeper|^Name)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/m,
      /(?:Nominal)\s+([A-Z][a-z]+\s+[A-Z]+)/m,
      /Name\s+([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/m,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    // Try intel report format: "1. Firstname SURNAME"
    const intelM = text.match(/^\d+\.\s+([A-Z][a-z]+)\s+([A-Z]{2,})/m);
    if (intelM) {
      return intelM[1] + " " + intelM[2].charAt(0) + intelM[2].slice(1).toLowerCase();
    }
    return null;
  }

  // Extract a date from the text (report generation date, incident date, etc.)
  function extractDate(text) {
    // Try "Report Generated DD Month YYYY" or "DD/MM/YYYY" at start
    const patterns = [
      /Report\s+Generated\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
      /Incident\s+Date\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
      /Incorporation\s+Date\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
    ];
    const months = {
      january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
      july: "07", august: "08", september: "09", october: "10", november: "11", december: "12"
    };
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        const dd = m[1].padStart(2, "0");
        const mm = months[m[2].toLowerCase()];
        return m[3] + mm + dd;
      }
    }
    // Try DD/MM/YYYY on its own line (intel report header)
    const slashM = text.match(/^(\d{2})\/(\d{2})\/(\d{4})\s*$/m);
    if (slashM) return slashM[3] + slashM[2] + slashM[1];
    // Fallback: today
    const now = new Date();
    return now.getFullYear().toString() +
      (now.getMonth() + 1).toString().padStart(2, "0") +
      now.getDate().toString().padStart(2, "0");
  }

  // Extract "who it concerns" — name + key identifiers (address, VRM, company, PNC ID)
  function extractConcerns(text, originator) {
    const name = extractSubjectName(text) || "Unknown Subject";
    const parts = [name];

    // Try to get a key identifier depending on source type
    if (originator === "DVLA") {
      const vrm = text.match(/Registration\s+Mark\s+([A-Z0-9]{2,4}\s+[A-Z0-9]{3})/i);
      const make = text.match(/Make\s+([A-Za-z-]+)/);
      const model = text.match(/Model\s+([A-Za-z0-9 ]+)/);
      if (vrm) parts.push(vrm[1].trim());
      if (make && model) parts.push(make[1].trim() + " " + model[1].trim());
    } else if (originator === "Companies House") {
      const co = text.match(/Company\s+Name\s+([^\n]+)/i);
      const num = text.match(/Company\s+Number\s+(\d+)/i);
      if (co) parts.push(co[1].trim());
      if (num) parts.push(num[1].trim());
    } else if (originator === "PNC") {
      const pnc = text.match(/PNC\s+ID\s+(PNCID\d+)/i);
      if (pnc) parts.push(pnc[1]);
    } else if (originator === "PND") {
      const loc = text.match(/Location\s+([^\n]+)/i);
      if (loc) parts.push(loc[1].trim());
      // Also get linked nominal
      const linked = text.match(/Linked\s+Nominal\s+([^\n]+)/i);
      if (linked) parts[0] = name + " and " + linked[1].trim();
    } else if (originator === "Intelligence Report") {
      const op = text.match(/^(OP\s+\S+)/m);
      const ir = text.match(/^(IR\d+)/m);
      if (op) parts.push(op[1].trim());
      if (ir) parts.push(ir[1].trim());
    } else {
      // Credit reports / identity: add address
      const addr = text.match(/(?:Current\s+)?Address\s+(\d+[^\n]{5,60})/i);
      if (addr) parts.push(addr[1].trim());
    }

    return parts.join(", ");
  }

  // Generate description (< 100 chars)
  function generateDescription(text, originator) {
    const descs = {
      "Experian": () => {
        const accts = (text.match(/Credit\s+Account\s+\d+/gi) || []).length;
        const ccj = /None\s+recorded/i.test(text) ? "no CCJs" : "has CCJs";
        return `Experian credit report${accts ? " with " + accts + " accounts" : ""}, address history, ${ccj}`;
      },
      "Equifax": () => {
        const score = text.match(/Equifax\s+Score\s+(\d+)/i);
        const accts = (text.match(/CAIS\s+Account\s+\d+/gi) || []).length;
        return `Equifax credit report${score ? " score " + score[1] : ""}${accts ? ", " + accts + " CAIS accounts" : ""}, address history`;
      },
      "GB Connexus": () => {
        const conf = text.match(/Identity\s+Confidence\s+(\d+%)/i);
        const linked = text.match(/Linked\s+Name\s+([^\n]+)/i);
        return `GB Connexus identity intel${conf ? " " + conf[1] + " confidence" : ""}${linked ? ", linked to " + linked[1].trim() : ""}`;
      },
      "Companies House": () => {
        const co = text.match(/Company\s+Name\s+([^\n]+)/i);
        const sic = text.match(/SIC.*?(\d{5})/);
        return `Company record${co ? " " + co[1].trim() : ""}${sic ? " SIC " + sic[1] : ""}`;
      },
      "DVLA": () => {
        const make = text.match(/Make\s+([^\n]+)/i);
        const model = text.match(/Model\s+([^\n]+)/i);
        const colour = text.match(/Colour\s+([^\n]+)/i);
        return `DVLA vehicle keeper record${colour ? " " + colour[1].trim().toLowerCase() : ""} ${make ? make[1].trim() : ""} ${model ? model[1].trim() : ""}`.trim();
      },
      "PNC": () => {
        const cro = text.match(/CRO\s+Number\s+([^\n]+)/i);
        const assoc = text.match(/Associated.*?Name\s+([^\n]+)/i);
        return `PNC nominal record${cro ? " " + cro[1].trim() : ""}${assoc ? ", associate " + assoc[1].trim() : ""}`;
      },
      "PND": () => {
        const type = text.match(/Incident\s+Type\s+([^\n]+)/i);
        const witness = text.match(/Witness\s+Name\s+([^\n]+)/i);
        return `PND intel report${type ? " " + type[1].trim().toLowerCase() : ""}${witness ? ", witness " + witness[1].trim() : ""}`;
      },
      "Intelligence Report": () => {
        const prov = text.match(/Provenance\s*[-–—]\s*(.+)/i);
        const entries = (text.match(/^\d+\.\s/gm) || []).length;
        return `Intel report${entries ? " " + entries + " entries" : ""}${prov ? ", " + prov[1].trim().substring(0, 50) : ""}`;
      },
    };

    const fn = descs[originator];
    let desc = fn ? fn() : `${originator} document`;
    // Enforce < 100 chars
    if (desc.length > 99) desc = desc.substring(0, 96) + "...";
    return desc;
  }

  // Main conversion function — takes a File, returns metadata
  async function analyseFile(file) {
    const text = await extractText(file);
    const originator = detectOriginator(text, file.name);
    const dateStr = extractDate(text);
    const concerns = extractConcerns(text, originator);
    const description = generateDescription(text, originator);
    const ext = "." + file.name.split(".").pop().toLowerCase();
    const newName = `${dateStr} - ${originator} - ${concerns}${ext}`;

    return {
      originalName: file.name,
      convertedName: newName,
      originator,
      date: dateStr,
      concerns,
      description,
      extension: ext,
      file,
    };
  }

  // Trigger download of a file with a new name
  function downloadRenamed(file, newName) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = newName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Download description as a .desc.txt sidecar
  function downloadDescription(newName, description) {
    const baseName = newName.replace(/\.[^.]+$/, "");
    const blob = new Blob([description], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = baseName + ".desc.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // -------------------------------------------------------
  // UI: Document Converter Panel
  // -------------------------------------------------------
  let converterResults = [];

  function initDocConverter() {
    const btn = document.getElementById("doc-converter-btn");
    const input = document.getElementById("doc-converter-input");
    const results = document.getElementById("doc-converter-results");
    if (!btn || !input) return;

    btn.addEventListener("click", () => input.click());

    input.addEventListener("change", async () => {
      const files = Array.from(input.files);
      if (!files.length) return;
      results.innerHTML = '<div class="dc-loading">Analysing files...</div>';
      converterResults = [];

      for (const file of files) {
        try {
          const meta = await analyseFile(file);
          converterResults.push(meta);
        } catch (e) {
          console.warn("Failed to analyse:", file.name, e);
          converterResults.push({
            originalName: file.name,
            convertedName: file.name,
            originator: "Unknown",
            date: "",
            concerns: "",
            description: "Could not parse file",
            extension: "",
            file,
            error: true,
          });
        }
      }

      renderResults(results);
      input.value = "";
    });

    // Download all button
    const dlAll = document.getElementById("doc-converter-dl-all");
    if (dlAll) {
      dlAll.addEventListener("click", () => {
        for (const r of converterResults) {
          downloadRenamed(r.file, r.convertedName);
          downloadDescription(r.convertedName, r.description);
        }
      });
    }
  }

  function renderResults(container) {
    if (!converterResults.length) {
      container.innerHTML = '<div class="dc-empty">Drop files or click Browse to convert</div>';
      return;
    }

    const html = converterResults.map((r, i) => `
      <div class="dc-result${r.error ? " dc-error" : ""}">
        <div class="dc-original" title="${escHtml(r.originalName)}">
          <span class="dc-label">Original:</span> ${escHtml(r.originalName)}
        </div>
        <div class="dc-arrow">&#8595;</div>
        <div class="dc-converted" title="${escHtml(r.convertedName)}">
          <span class="dc-label">Converted:</span> ${escHtml(r.convertedName)}
        </div>
        <div class="dc-desc">
          <span class="dc-label">Description:</span> ${escHtml(r.description)}
        </div>
        <div class="dc-meta">
          <span class="dc-badge dc-badge-orig">${escHtml(r.originator)}</span>
          <span class="dc-badge dc-badge-date">${escHtml(r.date)}</span>
        </div>
        <div class="dc-actions">
          <button class="dc-dl-btn" data-idx="${i}" title="Download renamed file">Download</button>
          <button class="dc-dl-desc-btn" data-idx="${i}" title="Download description sidecar">Desc .txt</button>
        </div>
      </div>
    `).join("");

    container.innerHTML = html;

    // Wire up individual download buttons
    container.querySelectorAll(".dc-dl-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = converterResults[+btn.dataset.idx];
        if (r) downloadRenamed(r.file, r.convertedName);
      });
    });
    container.querySelectorAll(".dc-dl-desc-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = converterResults[+btn.dataset.idx];
        if (r) downloadDescription(r.convertedName, r.description);
      });
    });
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s || "";
    return d.innerHTML;
  }

  // Init on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDocConverter);
  } else {
    initDocConverter();
  }

  // Expose for external use
  window.DocConverter = { analyseFile, downloadRenamed, downloadDescription };
})();
