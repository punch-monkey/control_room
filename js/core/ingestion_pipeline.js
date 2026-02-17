// ================== ingestion_pipeline.js ==================
// Universal intelligence ingestion — accept any file, extract entities,
// route into EntityStore with source provenance.
(function () {
  "use strict";

  // ── File type detection by extension ──
  const FILE_TYPES = {
    pdf:           { extensions: [".pdf"],  label: "PDF Document" },
    word:          { extensions: [".docx", ".doc"], label: "Word Document" },
    spreadsheet:   { extensions: [".xlsx", ".xls", ".ods"], label: "Spreadsheet" },
    csv:           { extensions: [".csv", ".tsv"], label: "Tabular Text" },
    json:          { extensions: [".json"], label: "JSON Data" },
    geojson:       { extensions: [".geojson"], label: "GeoJSON" },
    plaintext:     { extensions: [".txt", ".log", ".md", ".rtf"], label: "Plain Text" },
    markup:        { extensions: [".html", ".htm", ".xml"], label: "Markup" },
    image:         { extensions: [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"], label: "Image" },
    intel_report:  { extensions: [],  label: "Intelligence Report" }  // detected by content
  };

  // ── Regex patterns for entity extraction (reused from intel_import.js) ──
  const PATTERNS = {
    person:   /\b([A-Z][a-z]+)\s+([A-Z]{2,})\b/g,
    postcode: /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/gi,
    phone:    /\b(07\d{3}\s?\d{6})\b/g,
    vehicle:  /(?:VRM\s+)?([A-Z]{2}\d{2}\s?[A-Z]{3})\b/gi,
    email:    /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g,
    company:  /\b(\d{8})\b/g,
    pncId:    /PNCID\s*(\w+)/gi
  };

  // False positive person first names
  const PERSON_FP = new Set(["Over","Fort","Great","South","North","East","West","New","The","For","With","From"]);

  // ── Detect file type from filename ──
  function detectFileType(filename) {
    var name = String(filename || "").toLowerCase();
    var ext = name.substring(name.lastIndexOf("."));
    for (var key in FILE_TYPES) {
      if (FILE_TYPES[key].extensions.indexOf(ext) >= 0) return key;
    }
    return "plaintext";
  }

  // ── Extract text content from file based on type ──
  async function extractContent(file) {
    var type = detectFileType(file.name);
    var result = { type: type, text: "", rows: null, features: null, rawData: null };

    switch (type) {
      case "pdf":
        result.text = await _extractPdfText(file);
        break;
      case "word":
        result.text = await _extractWordText(file);
        break;
      case "spreadsheet":
        result.rows = await _extractSpreadsheetRows(file);
        break;
      case "csv":
        result.rows = await _extractCsvRows(file);
        break;
      case "json":
        var jsonData = await _readFileAsText(file);
        var parsed = JSON.parse(jsonData);
        if (parsed.type === "FeatureCollection" && Array.isArray(parsed.features)) {
          result.type = "geojson";
          result.features = parsed.features;
        } else if (Array.isArray(parsed)) {
          result.rows = parsed;
        } else if (parsed.rows && Array.isArray(parsed.rows)) {
          result.rows = parsed.rows;
        } else {
          result.rawData = parsed;
          result.text = jsonData;
        }
        break;
      case "geojson":
        var gjText = await _readFileAsText(file);
        var gj = JSON.parse(gjText);
        result.features = gj.features || [];
        break;
      case "plaintext":
      case "markup":
        result.text = await _readFileAsText(file);
        // Check if it's an IR-format intel report
        if (_isIntelReport(result.text)) {
          result.type = "intel_report";
        }
        break;
      case "image":
        result.text = "[Image file: " + file.name + "]";
        break;
    }

    return result;
  }

  // ── Master ingest function ──
  // Takes a File object, extracts content, creates a document entity,
  // extracts entities from text, and returns stats.
  async function ingestFile(file, options) {
    options = options || {};
    var mapCenter = options.mapCenter || (window._map ? window._map.getCenter() : { lat: 54.5, lng: -3.5 });

    // 1. Create document entity
    var docId = null;
    if (window.EntityStore) {
      docId = window.EntityStore.addEntity({
        type: "document",
        label: file.name,
        attributes: {
          filename: file.name,
          fileSize: file.size,
          mimeType: file.type || "",
          ingestedAt: new Date().toISOString()
        },
        latLng: null
      });
    }

    // 2. Extract content
    var content;
    try {
      content = await extractContent(file);
    } catch (err) {
      console.error("[Ingestion] Content extraction failed:", err);
      return { success: false, error: err.message, documentId: docId, entities: 0 };
    }

    // 3. Route to appropriate handler
    var stats = { documentId: docId, filename: file.name, type: content.type, entities: 0, relationships: 0 };

    if (content.type === "intel_report" && typeof window.IntelImport?.importReport === "function") {
      // Delegate IR-format to existing intel_import.js
      await window.IntelImport.importReport(content.text);
      stats.type = "intel_report";
      stats.entities = -1; // handled externally
      return stats;
    }

    if (content.text) {
      var extracted = extractEntitiesFromText(content.text, docId);
      stats.entities += extracted.count;
      stats.relationships += extracted.relationships;
    }

    if (content.rows) {
      var rowStats = await _ingestRows(content.rows, docId, mapCenter);
      stats.entities += rowStats.entities;
    }

    if (content.features) {
      var geoStats = _ingestGeoJsonFeatures(content.features, docId);
      stats.entities += geoStats.entities;
    }

    // Update document entity with stats
    if (docId && window.EntityStore) {
      window.EntityStore.updateEntity(docId, {
        attributes: Object.assign(window.EntityStore.getEntity(docId)?.attributes || {}, {
          extractedEntities: stats.entities,
          extractedRelationships: stats.relationships,
          contentType: content.type
        })
      });
    }

    stats.success = true;
    return stats;
  }

  // ── Extract entities from free text ──
  function extractEntitiesFromText(text, documentId) {
    if (!text || !window.EntityStore) return { count: 0, relationships: 0 };

    var count = 0;
    var relationships = 0;
    var mapCenter = window._map ? window._map.getCenter() : { lat: 54.5, lng: -3.5 };
    var entityIndex = 0;

    var source = documentId ? { documentId: documentId, method: "regex", confidence: "medium" } : null;

    // Persons
    var personRe = /\b([A-Z][a-z]+)\s+([A-Z]{2,})\b/g;
    var seen = {};
    var match;
    while ((match = personRe.exec(text)) !== null) {
      if (PERSON_FP.has(match[1])) continue;
      var fullName = match[1] + " " + match[2];
      if (seen[fullName]) continue;
      seen[fullName] = true;

      // Try to find DOB nearby
      var dobRe = new RegExp(match[2] + "[\\s\\S]{0,60}DOB\\s+(\\d{2}\\/\\d{2}\\/\\d{4})", "i");
      var dobM = text.match(dobRe);

      var latLng = _offsetFromCenter(mapCenter, entityIndex++);
      window.EntityStore.addEntity({
        type: "person",
        label: fullName,
        latLng: latLng,
        attributes: { dob: dobM ? dobM[1] : "", firstName: match[1], surname: match[2] },
        source: source ? Object.assign({}, source, { excerpt: _getExcerpt(text, match.index) }) : null
      });
      count++;
    }

    // Phone numbers
    var phoneRe = /\b(07\d{3}\s?\d{6})\b/g;
    seen = {};
    while ((match = phoneRe.exec(text)) !== null) {
      var number = match[1].replace(/\s/g, "");
      if (seen[number]) continue;
      seen[number] = true;
      var latLng2 = _offsetFromCenter(mapCenter, entityIndex++);
      window.EntityStore.addEntity({
        type: "phone",
        label: number,
        latLng: latLng2,
        attributes: { number: number },
        source: source ? Object.assign({}, source, { excerpt: _getExcerpt(text, match.index) }) : null
      });
      count++;
    }

    // Vehicles
    var vrmRe = /VRM\s+([A-Z]{2}\d{2}\s?[A-Z]{3})/gi;
    seen = {};
    while ((match = vrmRe.exec(text)) !== null) {
      var vrm = match[1].replace(/\s/g, "").toUpperCase();
      if (seen[vrm]) continue;
      seen[vrm] = true;
      var latLng3 = _offsetFromCenter(mapCenter, entityIndex++);
      window.EntityStore.addEntity({
        type: "vehicle",
        label: "Vehicle " + vrm,
        latLng: latLng3,
        attributes: { vrm: vrm },
        source: source ? Object.assign({}, source, { excerpt: _getExcerpt(text, match.index) }) : null
      });
      count++;
    }

    // Email addresses
    var emailRe = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
    seen = {};
    while ((match = emailRe.exec(text)) !== null) {
      var email = match[1].toLowerCase();
      if (seen[email]) continue;
      seen[email] = true;
      window.EntityStore.addEntity({
        type: "email",
        label: email,
        latLng: null,
        attributes: { address: email },
        source: source ? Object.assign({}, source, { excerpt: _getExcerpt(text, match.index) }) : null
      });
      count++;
    }

    // Postcodes → location entities
    var pcRe = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/gi;
    seen = {};
    while ((match = pcRe.exec(text)) !== null) {
      var pc = match[1].toUpperCase().replace(/\s+/g, "");
      if (seen[pc]) continue;
      seen[pc] = true;

      // Determine context
      var before = text.substring(Math.max(0, match.index - 60), match.index).toLowerCase();
      var context = "other";
      if (/lives?\s+at|resid/i.test(before)) context = "home";
      if (/offence|burgl|robbery|theft/i.test(before)) context = "offence";

      // Try to geocode via postcode files
      var formatted = match[1].toUpperCase().replace(/\s+/g, "");
      window.EntityStore.addEntity({
        type: "location",
        label: match[1].toUpperCase(),
        latLng: null, // Will be geocoded later if possible
        attributes: { postcode: formatted, context: context },
        source: source ? Object.assign({}, source, { excerpt: _getExcerpt(text, match.index) }) : null
      });
      count++;
    }

    return { count: count, relationships: relationships };
  }

  // ── Ingest tabular rows ──
  async function _ingestRows(rows, docId, mapCenter) {
    if (!Array.isArray(rows) || !rows.length || !window.EntityStore) return { entities: 0 };

    // Detect columns
    var headers = Object.keys(rows[0] || {});
    var latCol = _findColumn(headers, ["lat", "latitude", "y"]);
    var lngCol = _findColumn(headers, ["lng", "lon", "longitude", "x"]);
    var nameCol = _findColumn(headers, ["name", "label", "title", "company_name", "companyname", "full_name"]);
    var typeCol = _findColumn(headers, ["type", "entity_type", "category"]);

    var count = 0;
    var limit = Math.min(rows.length, 2000);

    for (var i = 0; i < limit; i++) {
      var row = rows[i];
      var lat = latCol ? parseFloat(row[latCol]) : NaN;
      var lng = lngCol ? parseFloat(row[lngCol]) : NaN;
      var latLng = (Number.isFinite(lat) && Number.isFinite(lng)) ? [lat, lng] : _offsetFromCenter(mapCenter, count);
      var label = nameCol ? String(row[nameCol] || "") : "Row " + (i + 1);
      var type = typeCol ? _mapRowTypeToEntityType(String(row[typeCol] || "")) : "location";

      var attrs = {};
      headers.forEach(function (h) {
        if (h !== latCol && h !== lngCol && row[h] != null && row[h] !== "") {
          attrs[h] = String(row[h]);
        }
      });

      window.EntityStore.addEntity({
        type: type,
        label: label.substring(0, 120),
        latLng: latLng,
        attributes: attrs,
        source: docId ? { documentId: docId, method: "tabular_row", confidence: "high" } : null
      });
      count++;
    }

    return { entities: count };
  }

  // ── Ingest GeoJSON features ──
  function _ingestGeoJsonFeatures(features, docId) {
    if (!Array.isArray(features) || !window.EntityStore) return { entities: 0 };

    var count = 0;
    var limit = Math.min(features.length, 2000);

    for (var i = 0; i < limit; i++) {
      var f = features[i];
      if (!f.geometry?.coordinates) continue;

      var coords = f.geometry.coordinates;
      var latLng = f.geometry.type === "Point" ? [coords[1], coords[0]] : null;
      var props = f.properties || {};
      var label = props.name || props.Name || props.NAME || props.label || props.title || "Feature " + (i + 1);

      var attrs = {};
      Object.keys(props).forEach(function (k) {
        if (props[k] != null) attrs[k] = String(props[k]);
      });

      window.EntityStore.addEntity({
        type: "location",
        label: String(label).substring(0, 120),
        latLng: latLng,
        attributes: attrs,
        source: docId ? { documentId: docId, method: "geojson_feature", confidence: "high" } : null
      });
      count++;
    }

    return { entities: count };
  }

  // ── Content extraction helpers ──

  async function _extractPdfText(file) {
    if (!window.pdfjsLib) return "[PDF parsing unavailable]";
    var arrayBuffer = await file.arrayBuffer();
    var pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    var pages = [];
    for (var i = 1; i <= Math.min(pdf.numPages, 50); i++) {
      var page = await pdf.getPage(i);
      var tc = await page.getTextContent();
      pages.push(tc.items.map(function (item) { return item.str; }).join(" "));
    }
    return pages.join("\n\n");
  }

  async function _extractWordText(file) {
    if (!window.mammoth) return "[Word parsing unavailable]";
    var arrayBuffer = await file.arrayBuffer();
    var result = await window.mammoth.extractRawText({ arrayBuffer: arrayBuffer });
    return result.value || "";
  }

  async function _extractSpreadsheetRows(file) {
    if (!window.XLSX) return [];
    var arrayBuffer = await file.arrayBuffer();
    var workbook = window.XLSX.read(arrayBuffer, { type: "array" });
    var firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
  }

  async function _extractCsvRows(file) {
    if (!window.XLSX) {
      // Fallback: manual CSV parse
      var text = await _readFileAsText(file);
      return _parseCsvManual(text);
    }
    var arrayBuffer = await file.arrayBuffer();
    var workbook = window.XLSX.read(arrayBuffer, { type: "array" });
    var firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
  }

  function _parseCsvManual(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return [];
    var headers = lines[0].split(",").map(function (h) { return h.trim().replace(/^["']|["']$/g, ""); });
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var vals = lines[i].split(",");
      var row = {};
      headers.forEach(function (h, j) { row[h] = (vals[j] || "").trim().replace(/^["']|["']$/g, ""); });
      rows.push(row);
    }
    return rows;
  }

  function _readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  }

  function _isIntelReport(text) {
    if (!text || typeof text !== "string") return false;
    var lines = text.trim().split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 3) return false;
    return /^IR\d+/i.test(lines[0].trim()) && /^OP\s+/i.test(lines[1].trim());
  }

  // ── Utility helpers ──

  function _findColumn(headers, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i].toLowerCase();
      for (var j = 0; j < headers.length; j++) {
        if (headers[j].toLowerCase().trim() === c) return headers[j];
      }
    }
    return null;
  }

  function _mapRowTypeToEntityType(typeStr) {
    var t = typeStr.toLowerCase();
    if (t.includes("person") || t.includes("people") || t.includes("officer")) return "person";
    if (t.includes("vehicle") || t.includes("car")) return "vehicle";
    if (t.includes("organi") || t.includes("company")) return "organisation";
    if (t.includes("phone") || t.includes("mobile")) return "phone";
    if (t.includes("email")) return "email";
    if (t.includes("vessel") || t.includes("ship")) return "vessel";
    if (t.includes("aircraft") || t.includes("flight")) return "aircraft";
    if (t.includes("port") || t.includes("harbor")) return "port";
    if (t.includes("event")) return "event";
    return "location";
  }

  function _offsetFromCenter(center, index) {
    var lat = typeof center.lat === "function" ? center.lat() : (center.lat || 54.5);
    var lng = typeof center.lng === "function" ? center.lng() : (center.lng || -3.5);
    var angle = index * 0.62;
    var radius = 0.03 + (index % 7) * 0.01;
    return [lat + Math.sin(angle) * radius, lng + Math.cos(angle) * radius];
  }

  function _getExcerpt(text, index) {
    var start = Math.max(0, index - 40);
    var end = Math.min(text.length, index + 80);
    return text.substring(start, end).replace(/\s+/g, " ").trim();
  }

  // ── Public API ──
  window.IngestionPipeline = {
    ingestFile: ingestFile,
    extractContent: extractContent,
    extractEntitiesFromText: extractEntitiesFromText,
    detectFileType: detectFileType,
    FILE_TYPES: FILE_TYPES,
    PATTERNS: PATTERNS
  };

})();
