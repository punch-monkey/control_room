// ================== psc_api.js ==================
// PSC (Persons with Significant Control) API Integration
// Uses Companies House API instead of local files

// ══════════════════════════════════════════════════════
// API CLIENT
// ══════════════════════════════════════════════════════

const PSC_API = {
  cache: new Map(),
  cacheTTL: 600000 // 10 minutes
};

const COMPANY_PROFILE_PREVIEW_STATE = {
  objectUrl: null,
  fileName: ""
};
const PSC_QUICK_PANEL_STATE = {
  open: false
};

function formatDateYYYYMMDD(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCompanyProfileFileName(companyNumber, companyName) {
  return buildCompaniesHousePdfFileName(companyNumber, companyName, "Company Profile");
}

function buildCompaniesHousePdfFileName(companyNumber, companyName, reportTitle) {
  const datePart = formatDateYYYYMMDD(new Date());
  const safeName = sanitizeFilenamePart(companyName || "Unknown Company");
  const safeNumber = sanitizeFilenamePart(companyNumber || "Unknown Number");
  const safeTitle = sanitizeFilenamePart(reportTitle || "Document");
  return `${datePart} - Companies House - ${safeName} - ${safeNumber} - ${safeTitle}.pdf`;
}

function ensureCompanyProfilePreviewPanel() {
  let panel = document.getElementById("company-profile-preview-panel");
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = "company-profile-preview-panel";
  panel.className = "company-profile-preview-panel";
  panel.innerHTML = `
    <div class="company-profile-preview-header">
      <div class="company-profile-preview-title">COMPANY PROFILE PREVIEW</div>
      <button id="company-profile-preview-close" class="company-profile-preview-close" type="button" aria-label="Close preview">&times;</button>
    </div>
    <div id="company-profile-preview-meta" class="company-profile-preview-meta"></div>
    <div class="company-profile-preview-body">
      <iframe id="company-profile-preview-frame" title="Company Profile PDF Preview"></iframe>
    </div>
    <div class="company-profile-preview-actions">
      <button id="company-profile-preview-download" class="btn-primary" type="button">Download PDF</button>
      <button id="company-profile-preview-cancel" class="btn-secondary" type="button">Close</button>
    </div>
  `;
  document.body.appendChild(panel);

  const closePanel = () => {
    panel.classList.remove("open");
  };

  panel.querySelector("#company-profile-preview-close")?.addEventListener("click", closePanel);
  panel.querySelector("#company-profile-preview-cancel")?.addEventListener("click", closePanel);
  panel.querySelector("#company-profile-preview-download")?.addEventListener("click", () => {
    if (!COMPANY_PROFILE_PREVIEW_STATE.objectUrl || !COMPANY_PROFILE_PREVIEW_STATE.fileName) return;
    const a = document.createElement("a");
    a.href = COMPANY_PROFILE_PREVIEW_STATE.objectUrl;
    a.download = COMPANY_PROFILE_PREVIEW_STATE.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(`Downloaded company profile: ${COMPANY_PROFILE_PREVIEW_STATE.fileName}`);
  });

  return panel;
}

function ensurePscQuickPanel() {
  let panel = document.getElementById("psc-quick-panel");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "psc-quick-panel";
  panel.className = "psc-quick-panel";
  panel.innerHTML = `
    <div class="psc-quick-header">
      <div class="psc-quick-title">PSC FOR COMPANY</div>
      <button id="psc-quick-close" class="psc-quick-close" type="button" aria-label="Close PSC panel">&times;</button>
    </div>
    <div id="psc-quick-meta" class="psc-quick-meta"></div>
    <div id="psc-quick-body" class="psc-quick-body"></div>
  `;
  document.body.appendChild(panel);
  panel.querySelector("#psc-quick-close")?.addEventListener("click", () => {
    panel.classList.remove("open");
    PSC_QUICK_PANEL_STATE.open = false;
  });
  return panel;
}

function openPscQuickPanel(companyNumber, companyName) {
  const panel = ensurePscQuickPanel();
  const meta = panel.querySelector("#psc-quick-meta");
  if (meta) meta.textContent = `${companyName || "Company"} (${companyNumber})`;
  panel.classList.add("open");
  PSC_QUICK_PANEL_STATE.open = true;
  return panel.querySelector("#psc-quick-body");
}

function showCompanyProfilePreview(pdfBlob, fileName, companyName, companyNumber) {
  const panel = ensureCompanyProfilePreviewPanel();
  const frame = panel.querySelector("#company-profile-preview-frame");
  const meta = panel.querySelector("#company-profile-preview-meta");
  if (!frame || !meta) return;

  if (COMPANY_PROFILE_PREVIEW_STATE.objectUrl) {
    URL.revokeObjectURL(COMPANY_PROFILE_PREVIEW_STATE.objectUrl);
    COMPANY_PROFILE_PREVIEW_STATE.objectUrl = null;
  }

  const objectUrl = URL.createObjectURL(pdfBlob);
  COMPANY_PROFILE_PREVIEW_STATE.objectUrl = objectUrl;
  COMPANY_PROFILE_PREVIEW_STATE.fileName = fileName;

  frame.src = objectUrl;
  meta.textContent = `${companyName} (${companyNumber})`;
  panel.classList.add("open");
}

// Get PSC for a company via API
async function getPSCForCompanyAPI(companyNumber) {
  if (!companyNumber) return [];
  
  const cacheKey = `psc_${companyNumber.toUpperCase()}`;
  const cached = PSC_API.cache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < PSC_API.cacheTTL)) {
    return cached.data;
  }
  
  try {
    const response = await fetchCH(`/company/${encodeURIComponent(companyNumber)}/persons-with-significant-control`);

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`No PSC data for company ${companyNumber}`);
        return [];
      }
      console.error("PSC API failed:", response.status);
      return [];
    }
    
    const data = await response.json();
    const items = data.items || [];
    
    // Transform to standard format
    const pscs = items.map(item => ({
      name: item.name || item.name_elements?.forename + ' ' + item.name_elements?.surname || 'Unknown',
      kind: item.kind || '',
      nationality: item.nationality || '',
      country_of_residence: item.country_of_residence || '',
      natures_of_control: item.natures_of_control || [],
      notified_on: item.notified_on || '',
      ceased_on: item.ceased_on || null,
      address: item.address || {},
      date_of_birth: item.date_of_birth || null,
      identification: item.identification || null
    }));
    
    // Cache results
    PSC_API.cache.set(cacheKey, {
      data: pscs,
      timestamp: Date.now()
    });
    
    // LRU cleanup
    if (PSC_API.cache.size > 100) {
      const firstKey = PSC_API.cache.keys().next().value;
      PSC_API.cache.delete(firstKey);
    }
    
    return pscs;
  } catch (err) {
    console.error("PSC API error:", err);
    return [];
  }
}

// Search for companies by officer name via API
async function searchCompaniesByOfficerAPI(officerName, limit = 50) {
  if (!officerName || officerName.trim().length < 3) return [];
  
  try {
    const response = await fetchCH(`/search/officers?q=${encodeURIComponent(officerName)}&items_per_page=${limit}`);
    
    if (!response.ok) {
      console.error("Officer search failed:", response.status);
      return [];
    }
    
    const data = await response.json();
    return data.items || [];
  } catch (err) {
    console.error("Officer search error:", err);
    return [];
  }
}

// Get officer appointments via API
async function getOfficerAppointmentsAPI(officerId) {
  if (!officerId) return [];
  
  const cacheKey = `appointments_${officerId}`;
  const cached = PSC_API.cache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < PSC_API.cacheTTL)) {
    return cached.data;
  }
  
  try {
    const response = await fetchCH(`/officers/${encodeURIComponent(officerId)}/appointments`);
    
    if (!response.ok) {
      console.error("Appointments API failed:", response.status);
      return [];
    }
    
    const data = await response.json();
    const items = data.items || [];
    
    PSC_API.cache.set(cacheKey, { data: items, timestamp: Date.now() });
    return items;
  } catch (err) {
    console.error("Appointments API error:", err);
    return [];
  }
}

// Get company filing history via API
async function getFilingHistoryAPI(companyNumber, limit = 100) {
  if (!companyNumber) return [];
  
  try {
    const response = await fetchCH(`/company/${encodeURIComponent(companyNumber)}/filing-history?items_per_page=${limit}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        console.log(`No filing history for company ${companyNumber}`);
        return [];
      }
      console.error("Filing history API failed:", response.status);
      return [];
    }
    
    const data = await response.json();
    return data.items || [];
  } catch (err) {
    console.error("Filing history API error:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════
// PDF GENERATION
// ══════════════════════════════════════════════════════

function downloadPSCReport(companyNumber, companyName, pscData) {
  if (!window.jspdf) {
    alert("PDF library not loaded. Please refresh the page.");
    return;
  }
  
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  let yPos = 20;
  const leftMargin = 20;
  const pageWidth = 190;
  
  // Title
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text("Persons with Significant Control", leftMargin, yPos);
  yPos += 10;
  
  // Company details
  doc.setFontSize(12);
  doc.setFont(undefined, 'normal');
  doc.text(`Company: ${companyName}`, leftMargin, yPos);
  yPos += 6;
  doc.text(`Company Number: ${companyNumber}`, leftMargin, yPos);
  yPos += 6;
  doc.text(`Report Generated: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`, leftMargin, yPos);
  yPos += 12;
  
  // Line separator
  doc.setDrawColor(100, 100, 100);
  doc.line(leftMargin, yPos, pageWidth, yPos);
  yPos += 10;
  
  if (!pscData || pscData.length === 0) {
    doc.setFontSize(11);
    doc.text("No PSC records found for this company.", leftMargin, yPos);
  } else {
    pscData.forEach((psc, index) => {
      // Check if we need a new page
      if (yPos > 250) {
        doc.addPage();
        yPos = 20;
      }
      
      // PSC Number
      doc.setFontSize(13);
      doc.setFont(undefined, 'bold');
      doc.text(`PSC #${index + 1}`, leftMargin, yPos);
      yPos += 8;
      
      // Name
      doc.setFontSize(11);
      doc.setFont(undefined, 'bold');
      doc.text(`Name:`, leftMargin, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(psc.name || 'Unknown', leftMargin + 40, yPos);
      yPos += 6;
      
      // Kind
      if (psc.kind) {
        doc.setFont(undefined, 'bold');
        doc.text(`Type:`, leftMargin, yPos);
        doc.setFont(undefined, 'normal');
        const kindText = psc.kind.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        doc.text(kindText, leftMargin + 40, yPos);
        yPos += 6;
      }
      
      // Nationality
      if (psc.nationality) {
        doc.setFont(undefined, 'bold');
        doc.text(`Nationality:`, leftMargin, yPos);
        doc.setFont(undefined, 'normal');
        doc.text(psc.nationality, leftMargin + 40, yPos);
        yPos += 6;
      }
      
      // Country of residence
      if (psc.country_of_residence) {
        doc.setFont(undefined, 'bold');
        doc.text(`Country:`, leftMargin, yPos);
        doc.setFont(undefined, 'normal');
        doc.text(psc.country_of_residence, leftMargin + 40, yPos);
        yPos += 6;
      }
      
      // Date notified
      if (psc.notified_on) {
        doc.setFont(undefined, 'bold');
        doc.text(`Notified:`, leftMargin, yPos);
        doc.setFont(undefined, 'normal');
        doc.text(psc.notified_on, leftMargin + 40, yPos);
        yPos += 6;
      }
      
      // Natures of control
      if (psc.natures_of_control && psc.natures_of_control.length > 0) {
        doc.setFont(undefined, 'bold');
        doc.text(`Control:`, leftMargin, yPos);
        yPos += 5;
        doc.setFont(undefined, 'normal');
        doc.setFontSize(9);
        psc.natures_of_control.forEach(nature => {
          const lines = doc.splitTextToSize(`• ${nature.replace(/-/g, ' ')}`, pageWidth - leftMargin - 10);
          lines.forEach(line => {
            if (yPos > 270) {
              doc.addPage();
              yPos = 20;
            }
            doc.text(line, leftMargin + 5, yPos);
            yPos += 4;
          });
        });
        doc.setFontSize(11);
        yPos += 3;
      }
      
      // Address
      if (psc.address && Object.keys(psc.address).length > 0) {
        doc.setFont(undefined, 'bold');
        doc.text(`Address:`, leftMargin, yPos);
        yPos += 5;
        doc.setFont(undefined, 'normal');
        doc.setFontSize(9);
        
        const addressParts = [];
        if (psc.address.address_line_1) addressParts.push(psc.address.address_line_1);
        if (psc.address.address_line_2) addressParts.push(psc.address.address_line_2);
        if (psc.address.locality) addressParts.push(psc.address.locality);
        if (psc.address.region) addressParts.push(psc.address.region);
        if (psc.address.postal_code) addressParts.push(psc.address.postal_code);
        if (psc.address.country) addressParts.push(psc.address.country);
        
        addressParts.forEach(part => {
          if (yPos > 270) {
            doc.addPage();
            yPos = 20;
          }
          doc.text(part, leftMargin + 5, yPos);
          yPos += 4;
        });
        doc.setFontSize(11);
      }
      
      yPos += 8;
      
      // Separator line between PSCs
      if (index < pscData.length - 1) {
        doc.setDrawColor(200, 200, 200);
        doc.line(leftMargin, yPos, pageWidth, yPos);
        yPos += 8;
      }
    });
  }
  
  // Footer on last page
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(
      `Control Room PSC Report - Page ${i} of ${pageCount}`,
      pageWidth / 2,
      285,
      { align: 'center' }
    );
  }
  
  // Download
  const fileName = buildCompaniesHousePdfFileName(companyNumber, companyName, "PSC Report");
  doc.save(fileName);
}

// Download filing history as PDF
async function downloadFilingHistory(companyNumber, companyName) {
  if (!window.jspdf) {
    alert("PDF library not loaded. Please refresh the page.");
    return;
  }
  
  setStatus(`Fetching filing history for ${companyName}...`);
  
  const filings = await getFilingHistoryAPI(companyNumber, 100);
  
  if (filings.length === 0) {
    alert('No filing history found for this company');
    setStatus('No filing history');
    return;
  }
  
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  let yPos = 20;
  const leftMargin = 20;
  const pageWidth = 190;
  
  // Title
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text("Filing History", leftMargin, yPos);
  yPos += 10;
  
  // Company details
  doc.setFontSize(12);
  doc.setFont(undefined, 'normal');
  doc.text(`Company: ${companyName}`, leftMargin, yPos);
  yPos += 6;
  doc.text(`Company Number: ${companyNumber}`, leftMargin, yPos);
  yPos += 6;
  doc.text(`Total Filings: ${filings.length}`, leftMargin, yPos);
  yPos += 6;
  doc.text(`Report Generated: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`, leftMargin, yPos);
  yPos += 12;
  
  // Line separator
  doc.setDrawColor(100, 100, 100);
  doc.line(leftMargin, yPos, pageWidth, yPos);
  yPos += 10;
  
  filings.forEach((filing, index) => {
    // Check if we need a new page
    if (yPos > 250) {
      doc.addPage();
      yPos = 20;
    }
    
    // Filing number
    doc.setFontSize(11);
    doc.setFont(undefined, 'bold');
    doc.text(`#${index + 1}`, leftMargin, yPos);
    yPos += 6;
    
    // Date
    if (filing.date) {
      doc.setFont(undefined, 'bold');
      doc.text(`Date:`, leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(filing.date, leftMargin + 40, yPos);
      yPos += 5;
    }
    
    // Description
    if (filing.description) {
      doc.setFont(undefined, 'bold');
      doc.text(`Type:`, leftMargin + 5, yPos);
      yPos += 5;
      doc.setFont(undefined, 'normal');
      doc.setFontSize(9);
      const descLines = doc.splitTextToSize(filing.description, pageWidth - leftMargin - 10);
      descLines.forEach(line => {
        if (yPos > 270) {
          doc.addPage();
          yPos = 20;
        }
        doc.text(line, leftMargin + 10, yPos);
        yPos += 4;
      });
      doc.setFontSize(11);
      yPos += 2;
    }
    
    // Category
    if (filing.category) {
      doc.setFont(undefined, 'bold');
      doc.text(`Category:`, leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(filing.category.replace(/-/g, ' '), leftMargin + 40, yPos);
      yPos += 5;
    }
    
    // Type
    if (filing.type) {
      doc.setFont(undefined, 'bold');
      doc.text(`Form:`, leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(filing.type.toUpperCase(), leftMargin + 40, yPos);
      yPos += 5;
    }
    
    yPos += 5;
    
    // Separator line between filings
    if (index < filings.length - 1) {
      doc.setDrawColor(200, 200, 200);
      doc.line(leftMargin, yPos, pageWidth, yPos);
      yPos += 6;
    }
  });
  
  // Footer on all pages
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(
      `Control Room Filing History Report - Page ${i} of ${pageCount}`,
      pageWidth / 2,
      285,
      { align: 'center' }
    );
  }
  
  // Download
  const fileName = buildCompaniesHousePdfFileName(companyNumber, companyName, "Filing History");
  doc.save(fileName);
  
  setStatus(`Downloaded filing history for ${companyName}`);
}

// Download comprehensive company profile as PDF
async function downloadCompanyProfile(companyNumber, companyName) {
  if (!window.jspdf) {
    alert("PDF library not loaded. Please refresh the page.");
    return;
  }
  
  setStatus(`Fetching comprehensive company data for ${companyName}...`);
  
  // Fetch all company data in parallel
  const [profile, pscData, filingHistory] = await Promise.all([
    getCompanyProfile(companyNumber),
    getPSCForCompanyAPI(companyNumber),
    getFilingHistoryAPI(companyNumber, 20)
  ]);
  
  if (!profile) {
    alert('Could not fetch company profile');
    setStatus('Failed to fetch profile');
    return;
  }
  
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  let yPos = 20;
  const leftMargin = 20;
  const pageWidth = 190;
  
  // Helper to check page break
  const checkPageBreak = (needed = 15) => {
    if (yPos > 270 - needed) {
      doc.addPage();
      yPos = 20;
      return true;
    }
    return false;
  };
  
  const addSection = (title) => {
    checkPageBreak(20);
    doc.setFontSize(13);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(60, 60, 180);
    doc.text(title, leftMargin, yPos);
    doc.setTextColor(0);
    yPos += 8;
  };
  
  // ═══ HEADER ═══
  doc.setFontSize(20);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(40, 40, 140);
  doc.text("COMPREHENSIVE COMPANY PROFILE", leftMargin, yPos);
  doc.setTextColor(0);
  yPos += 12;
  
  // Company Name
  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  const nameLines = doc.splitTextToSize(companyName, pageWidth - 20);
  nameLines.forEach(line => {
    doc.text(line, leftMargin, yPos);
    yPos += 8;
  });
  yPos += 3;
  
  // Company Number
  doc.setFontSize(12);
  doc.setFont(undefined, 'normal');
  doc.text(`Company Number: ${companyNumber}`, leftMargin, yPos);
  yPos += 8;
  
  // Report date
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(`Report Generated: ${new Date().toLocaleDateString('en-GB')} at ${new Date().toLocaleTimeString('en-GB')}`, leftMargin, yPos);
  doc.setTextColor(0);
  yPos += 10;
  
  // Separator
  doc.setDrawColor(100, 100, 100);
  doc.line(leftMargin, yPos, pageWidth, yPos);
  yPos += 12;
  
  // ═══ COMPANY STATUS ═══
  addSection("COMPANY STATUS");
  doc.setFontSize(11);
  doc.setFont(undefined, 'normal');
  
  const statusData = [
    ['Status:', profile.company_status || 'Unknown'],
    ['Type:', profile.type || 'N/A'],
    ['Incorporated:', profile.date_of_creation || 'N/A'],
  ];
  
  if (profile.date_of_cessation) {
    statusData.push(['Ceased:', profile.date_of_cessation]);
  }
  if (profile.jurisdiction) {
    statusData.push(['Jurisdiction:', profile.jurisdiction]);
  }
  if (profile.has_been_liquidated) {
    statusData.push(['Liquidated:', 'Yes']);
  }
  if (profile.has_charges) {
    statusData.push(['Has Charges:', 'Yes']);
  }
  if (profile.has_insolvency_history) {
    statusData.push(['Insolvency History:', 'Yes']);
  }
  
  statusData.forEach(([label, value]) => {
    doc.setFont(undefined, 'bold');
    doc.text(label, leftMargin + 5, yPos);
    doc.setFont(undefined, 'normal');
    doc.text(value, leftMargin + 50, yPos);
    yPos += 6;
  });
  yPos += 5;
  
  // ═══ REGISTERED OFFICE ADDRESS ═══
  if (profile.registered_office_address) {
    addSection("REGISTERED OFFICE ADDRESS");
    doc.setFont(undefined, 'normal');
    
    const addr = profile.registered_office_address;
    const addrParts = [];
    if (addr.care_of) addrParts.push(`C/O ${addr.care_of}`);
    if (addr.po_box) addrParts.push(`PO Box ${addr.po_box}`);
    if (addr.address_line_1) addrParts.push(addr.address_line_1);
    if (addr.address_line_2) addrParts.push(addr.address_line_2);
    if (addr.locality) addrParts.push(addr.locality);
    if (addr.region) addrParts.push(addr.region);
    if (addr.postal_code) addrParts.push(addr.postal_code);
    if (addr.country) addrParts.push(addr.country);
    
    addrParts.forEach(part => {
      doc.text(part, leftMargin + 5, yPos);
      yPos += 5;
    });
    yPos += 5;
  }
  
  // ═══ NATURE OF BUSINESS (SIC) ═══
  if (profile.sic_codes && profile.sic_codes.length > 0) {
    addSection("NATURE OF BUSINESS (SIC CODES)");
    doc.setFont(undefined, 'normal');
    doc.setFontSize(10);
    
    profile.sic_codes.forEach((sic, idx) => {
      checkPageBreak();
      doc.setFont(undefined, 'bold');
      doc.text(`${idx + 1}.`, leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      const sicLines = doc.splitTextToSize(sic, pageWidth - 35);
      sicLines.forEach((line, lineIdx) => {
        doc.text(line, leftMargin + (lineIdx === 0 ? 12 : 15), yPos);
        yPos += 4;
      });
      yPos += 2;
    });
    doc.setFontSize(11);
    yPos += 5;
  }
  
  // ═══ ACCOUNTS ═══
  if (profile.accounts) {
    addSection("ACCOUNTS INFORMATION");
    doc.setFont(undefined, 'normal');
    
    const acc = profile.accounts;
    if (acc.next_due) {
      doc.setFont(undefined, 'bold');
      doc.text('Next Due:', leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(acc.next_due, leftMargin + 50, yPos);
      yPos += 6;
    }
    if (acc.overdue) {
      doc.setTextColor(200, 0, 0);
      doc.setFont(undefined, 'bold');
      doc.text('*** ACCOUNTS OVERDUE ***', leftMargin + 5, yPos);
      doc.setTextColor(0);
      doc.setFont(undefined, 'normal');
      yPos += 6;
    }
    if (acc.last_accounts) {
      doc.setFont(undefined, 'bold');
      doc.text('Last Accounts:', leftMargin + 5, yPos);
      yPos += 6;
      doc.setFont(undefined, 'normal');
      doc.text(`Made up to: ${acc.last_accounts.made_up_to || 'N/A'}`, leftMargin + 10, yPos);
      yPos += 5;
      if (acc.last_accounts.type) {
        doc.text(`Type: ${acc.last_accounts.type}`, leftMargin + 10, yPos);
        yPos += 5;
      }
    }
    if (acc.accounting_reference_date) {
      doc.setFont(undefined, 'bold');
      doc.text('Accounting Reference Date:', leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(`${acc.accounting_reference_date.day}/${acc.accounting_reference_date.month}`, leftMargin + 65, yPos);
      yPos += 6;
    }
    yPos += 5;
  }
  
  // ═══ CONFIRMATION STATEMENT ═══
  if (profile.confirmation_statement) {
    addSection("CONFIRMATION STATEMENT");
    doc.setFont(undefined, 'normal');
    
    const cs = profile.confirmation_statement;
    if (cs.next_due) {
      doc.setFont(undefined, 'bold');
      doc.text('Next Due:', leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(cs.next_due, leftMargin + 50, yPos);
      yPos += 6;
    }
    if (cs.overdue) {
      doc.setTextColor(200, 0, 0);
      doc.setFont(undefined, 'bold');
      doc.text('*** CONFIRMATION STATEMENT OVERDUE ***', leftMargin + 5, yPos);
      doc.setTextColor(0);
      doc.setFont(undefined, 'normal');
      yPos += 6;
    }
    if (cs.last_made_up_to) {
      doc.setFont(undefined, 'bold');
      doc.text('Last Made Up To:', leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(cs.last_made_up_to, leftMargin + 50, yPos);
      yPos += 6;
    }
    yPos += 5;
  }
  
  // ═══ PREVIOUS NAMES ═══
  if (profile.previous_company_names && profile.previous_company_names.length > 0) {
    addSection("PREVIOUS COMPANY NAMES");
    doc.setFont(undefined, 'normal');
    doc.setFontSize(10);
    
    profile.previous_company_names.forEach((prev, idx) => {
      checkPageBreak();
      doc.setFont(undefined, 'bold');
      doc.text(`${idx + 1}.`, leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      doc.text(prev.name, leftMargin + 12, yPos);
      yPos += 5;
      if (prev.ceased_on) {
        doc.setFontSize(9);
        doc.setTextColor(100);
        doc.text(`(Changed on ${prev.ceased_on})`, leftMargin + 15, yPos);
        doc.setTextColor(0);
        doc.setFontSize(10);
        yPos += 5;
      }
    });
    doc.setFontSize(11);
    yPos += 5;
  }
  
  // ═══ PERSONS WITH SIGNIFICANT CONTROL ═══
  if (pscData && pscData.length > 0) {
    addSection("PERSONS WITH SIGNIFICANT CONTROL (PSC)");
    doc.setFontSize(10);
    
    pscData.slice(0, 10).forEach((psc, idx) => {
      checkPageBreak(25);
      doc.setFont(undefined, 'bold');
      doc.text(`${idx + 1}. ${psc.name}`, leftMargin + 5, yPos);
      yPos += 5;
      doc.setFont(undefined, 'normal');
      doc.setFontSize(9);
      
      if (psc.kind) {
        doc.text(`Type: ${formatPSCKind(psc.kind)}`, leftMargin + 10, yPos);
        yPos += 4;
      }
      if (psc.nationality) {
        doc.text(`Nationality: ${psc.nationality}`, leftMargin + 10, yPos);
        yPos += 4;
      }
      if (psc.notified_on) {
        doc.text(`Notified: ${psc.notified_on}`, leftMargin + 10, yPos);
        yPos += 4;
      }
      if (psc.natures_of_control && psc.natures_of_control.length > 0) {
        doc.text(`Control: ${psc.natures_of_control.slice(0, 2).join(', ')}`, leftMargin + 10, yPos);
        yPos += 4;
      }
      doc.setFontSize(10);
      yPos += 3;
    });
    
    if (pscData.length > 10) {
      doc.setFontSize(9);
      doc.setTextColor(100);
      doc.text(`... and ${pscData.length - 10} more PSC record(s)`, leftMargin + 5, yPos);
      doc.setTextColor(0);
      doc.setFontSize(10);
      yPos += 5;
    }
    doc.setFontSize(11);
    yPos += 5;
  }
  
  // ═══ RECENT FILING HISTORY ═══
  if (filingHistory && filingHistory.length > 0) {
    addSection("RECENT FILING HISTORY (Last 20)");
    doc.setFontSize(9);
    
    filingHistory.forEach((filing, idx) => {
      checkPageBreak(12);
      doc.setFont(undefined, 'bold');
      doc.text(`${filing.date || 'N/A'}`, leftMargin + 5, yPos);
      doc.setFont(undefined, 'normal');
      const desc = filing.description || filing.type || 'Unknown filing';
      const descLines = doc.splitTextToSize(desc, pageWidth - 50);
      doc.text(descLines[0], leftMargin + 30, yPos);
      yPos += 4;
      if (descLines.length > 1) {
        descLines.slice(1).forEach(line => {
          doc.text(line, leftMargin + 30, yPos);
          yPos += 3;
        });
      }
      yPos += 2;
    });
    doc.setFontSize(11);
    yPos += 5;
  }
  
  // ═══ FOOTER ═══
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(120);
    
    // Page number
    doc.text(
      `Page ${i} of ${pageCount}`,
      pageWidth / 2,
      285,
      { align: 'center' }
    );
    
    // Watermark
    doc.text(
      `Control Room - Comprehensive Company Profile`,
      leftMargin,
      285
    );
    
    doc.text(
      `${companyNumber}`,
      pageWidth - 10,
      285,
      { align: 'right' }
    );
  }
  
  // Preview first, then allow manual download.
  const fileName = buildCompanyProfileFileName(companyNumber, companyName);
  const pdfBlob = doc.output("blob");
  showCompanyProfilePreview(pdfBlob, fileName, companyName, companyNumber);
  setStatus(`Preview ready for ${companyName}. Use the right panel to download.`);
}

// Get officers for a company via API
async function getOfficersForCompanyAPI(companyNumber) {
  if (!companyNumber) return [];

  const cacheKey = `officers_${companyNumber.toUpperCase()}`;
  const cached = PSC_API.cache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < PSC_API.cacheTTL)) {
    return cached.data;
  }

  try {
    const response = await fetchCH(`/company/${encodeURIComponent(companyNumber)}/officers?items_per_page=100`);
    if (!response.ok) {
      if (response.status === 404) return [];
      console.error("Officers API failed:", response.status);
      return [];
    }
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    PSC_API.cache.set(cacheKey, { data: items, timestamp: Date.now() });
    return items;
  } catch (err) {
    console.error("Officers API error:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════
// UI FUNCTIONS
// ══════════════════════════════════════════════════════

function formatPSCKind(kind) {
  if (!kind) return '';
  return kind
    .replace(/-/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

function normalizePersonName(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatCountryWithFlag(value) {
  if (typeof window !== "undefined" && typeof window.formatCountryWithFlag === "function") {
    return window.formatCountryWithFlag(value);
  }
  return String(value || "").trim();
}

function tokenSetFromName(name) {
  return new Set(
    normalizePersonName(name)
      .split(" ")
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
  );
}

function namesLikelyMatch(left, right) {
  const a = normalizePersonName(left);
  const b = normalizePersonName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aTokens = tokenSetFromName(a);
  const bTokens = tokenSetFromName(b);
  if (!aTokens.size || !bTokens.size) return false;
  let overlap = 0;
  aTokens.forEach((t) => { if (bTokens.has(t)) overlap += 1; });
  return overlap >= 2;
}

function formatOfficerRole(role) {
  const raw = String(role || "").trim().toLowerCase();
  if (!raw) return "";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatPscNature(nature) {
  return String(nature || "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function formatPartialDobForDisplay(dob) {
  if (!dob || typeof dob !== "object") return "";
  const year = dob.year ? String(dob.year) : "";
  const month = dob.month ? String(dob.month).padStart(2, "0") : "";
  const day = dob.day ? String(dob.day).padStart(2, "0") : "XX";
  if (year && month) return `${day}/${month}/${year}`;
  if (year) return `XX/XX/${year}`;
  return "";
}

async function lookupCompanyOfficerRole(companyNumber, personName) {
  const company = String(companyNumber || "").trim();
  const person = normalizePersonName(personName);
  if (!company || !person) return "";
  try {
    const officers = await getOfficersForCompanyAPI(company);
    const hit = officers.find((o) => normalizePersonName(o?.name) === person);
    return formatOfficerRole(hit?.officer_role || "");
  } catch (err) {
    console.warn("Officer role lookup failed:", err);
    return "";
  }
}

async function lookupCompanyOfficerMatch(companyNumber, personName) {
  const company = String(companyNumber || "").trim();
  const person = String(personName || "").trim();
  if (!company || !person) return null;
  try {
    const officers = await getOfficersForCompanyAPI(company);
    const exact = officers.find((o) => normalizePersonName(o?.name) === normalizePersonName(person));
    const hit = exact || officers.find((o) => namesLikelyMatch(o?.name, person));
    if (!hit) return null;
    return {
      officerId: extractOfficerId(hit),
      officerRole: formatOfficerRole(hit?.officer_role || ""),
      officer: hit
    };
  } catch (err) {
    console.warn("Officer match lookup failed:", err);
    return null;
  }
}

function buildPscRelationshipDetail(psc) {
  const parts = [];
  const natures = Array.isArray(psc?.natures_of_control) ? psc.natures_of_control.filter(Boolean) : [];
  if (natures.length) parts.push(`Control: ${natures.map(formatPscNature).join("; ")}`);
  if (psc?.nationality) parts.push(`Nationality: ${psc.nationality}`);
  if (psc?.country_of_residence) parts.push(`Residence: ${psc.country_of_residence}`);
  if (psc?.notified_on) parts.push(`Notified: ${psc.notified_on}`);
  const dob = formatPartialDobForDisplay(psc?.date_of_birth);
  if (dob) parts.push(`DOB: ${dob}`);
  return parts.join(" | ");
}

function derivePscRelationshipLabel(psc, officerRole = "") {
  if (officerRole) return officerRole;
  if (psc?.kind && String(psc.kind).includes("corporate")) return "Corporate PSC";
  return "PSC";
}

function pscCanMap(psc) {
  const addr = psc?.address || {};
  return !!String(addr.postal_code || "").trim();
}

function toOfficerAddressFromPSC(psc) {
  const addr = psc?.address || {};
  return {
    address_line_1: addr.address_line_1 || "",
    address_line_2: addr.address_line_2 || "",
    locality: addr.locality || "",
    region: addr.region || "",
    postal_code: addr.postal_code || "",
    country: addr.country || ""
  };
}

function officerCanMap(officer) {
  const addr = officer?.address || {};
  return !!String(addr.postal_code || "").trim();
}

function extractOfficerId(officer) {
  const path = String(officer?.links?.officer?.appointments || "").trim();
  const match = path.match(/\/officers\/([^/]+)\/appointments/i);
  return match ? match[1] : "";
}

function toOfficerAddress(officer) {
  const addr = officer?.address || {};
  return {
    address_line_1: addr.address_line_1 || "",
    address_line_2: addr.address_line_2 || "",
    locality: addr.locality || "",
    region: addr.region || "",
    postal_code: addr.postal_code || "",
    country: addr.country || ""
  };
}

async function addPSCToMap(psc, companyNumber, companyName) {
  if (!pscCanMap(psc)) {
    alert("PSC record has no postcode/address suitable for mapping.");
    return;
  }
  const addFn = window.addPersonToMap;
  if (typeof addFn !== "function") {
    alert("Map add function is unavailable. Refresh and try again.");
    return;
  }
  const personName = String(psc?.name || "PSC");
  const officerAddress = toOfficerAddressFromPSC(psc);
  try {
    const officerMatch = await lookupCompanyOfficerMatch(companyNumber, personName);
    const relationship = derivePscRelationshipLabel(psc, officerMatch?.officerRole || "");
    const relationshipDetail = buildPscRelationshipDetail(psc);
    const companyEntity = typeof window.getCompanyEntityByNumber === "function"
      ? window.getCompanyEntityByNumber(companyNumber)
      : null;
    await addFn(personName, officerAddress, [companyName || `Company #${companyNumber}`], {
      companyNumber,
      companyName: companyName || "",
      relationship,
      relationshipDetail,
      pscData: psc,
      officerId: officerMatch?.officerId || "",
      anchorLatLng: companyEntity?.latLng || null
    });
    setStatus(`Added PSC to map: ${personName}`);
  } catch (err) {
    console.error("Add PSC to map failed:", err);
    alert("Could not add PSC to map.");
  }
}

async function addOfficerToMap(officer, companyNumber, companyName) {
  if (!officerCanMap(officer)) {
    alert("Officer record has no postcode/address suitable for mapping.");
    return;
  }
  const addFn = window.addPersonToMap;
  if (typeof addFn !== "function") {
    alert("Map add function is unavailable. Refresh and try again.");
    return;
  }
  const officerName = String(officer?.name || officer?.title || "Officer");
  const officerAddress = toOfficerAddress(officer);
  const relationship = formatOfficerRole(officer?.officer_role || "") || "Officer";
  const relationshipDetailParts = [];
  if (officer?.appointed_on) relationshipDetailParts.push(`Appointed: ${officer.appointed_on}`);
  if (officer?.resigned_on) relationshipDetailParts.push(`Resigned: ${officer.resigned_on}`);
  const dob = formatPartialDobForDisplay(officer?.date_of_birth);
  if (dob) relationshipDetailParts.push(`DOB: ${dob}`);
  if (officer?.nationality) relationshipDetailParts.push(`Nationality: ${officer.nationality}`);
  if (officer?.country_of_residence) relationshipDetailParts.push(`Residence: ${officer.country_of_residence}`);
  const relationshipDetail = relationshipDetailParts.join(" | ");
  const companyEntity = typeof window.getCompanyEntityByNumber === "function"
    ? window.getCompanyEntityByNumber(companyNumber)
    : null;
  try {
    await addFn(officerName, officerAddress, [companyName || `Company #${companyNumber}`], {
      companyNumber,
      companyName: companyName || "",
      relationship,
      relationshipDetail,
      officerId: extractOfficerId(officer),
      dob: officer?.date_of_birth || "",
      nationality: officer?.nationality || "",
      countryOfResidence: officer?.country_of_residence || "",
      officerRole: relationship,
      anchorLatLng: companyEntity?.latLng || null
    });
    setStatus(`Added officer to map: ${officerName}`);
  } catch (err) {
    console.error("Add officer to map failed:", err);
    alert("Could not add officer to map.");
  }
}

function renderPSCCard(psc, companyNumber, companyName) {
  const card = document.createElement('div');
  card.className = 'psc-card';
  
  const isIndividual = psc.kind && (psc.kind.includes('individual') || psc.kind.includes('person'));
  const isCorporate = !isIndividual;
  
  const kindClass = isIndividual ? 'psc-tag-individual' : 'psc-tag-corporate';
  const kindText = formatPSCKind(psc.kind);
  
  let html = `
    <div class="psc-card-header">
      <div class="psc-name">${escapeHtml(psc.name)}</div>
      ${kindText ? `<span class="popup-tag ${kindClass}">${escapeHtml(kindText)}</span>` : ''}
    </div>
  `;
  
  if (psc.nationality || psc.country_of_residence) {
    const nat = formatCountryWithFlag(psc.nationality || "");
    const cor = formatCountryWithFlag(psc.country_of_residence || "");
    html += `<div class="psc-detail psc-detail-flags">`;
    if (nat) html += `<span class="psc-flag-chip"><span class="psc-label">Nationality</span> ${escapeHtml(nat)}</span> `;
    if (cor) html += `<span class="psc-flag-chip"><span class="psc-label">Residence</span> ${escapeHtml(cor)}</span>`;
    html += `</div>`;
  }
  
  if (psc.notified_on) {
    html += `<div class="psc-detail"><span class="psc-label">Notified:</span> ${escapeHtml(psc.notified_on)}</div>`;
  }
  
  if (psc.natures_of_control && psc.natures_of_control.length > 0) {
    html += `<div class="psc-natures">`;
    psc.natures_of_control.slice(0, 3).forEach(nature => {
      html += `<span class="psc-nature-tag">${escapeHtml(nature.replace(/-/g, ' '))}</span>`;
    });
    if (psc.natures_of_control.length > 3) {
      html += `<span class="psc-nature-tag">+${psc.natures_of_control.length - 3} more</span>`;
    }
    html += `</div>`;
  }

  html += `<div class="popup-btn-row">`;
  if (pscCanMap(psc)) {
    html += `<button class="popup-psc-btn psc-add-map-btn" type="button">Add PSC to Map</button>`;
  } else {
    html += `<button class="popup-psc-btn" type="button" disabled title="No postcode available">Add PSC to Map</button>`;
  }
  html += `</div>`;
  
  card.innerHTML = html;
  const addBtn = card.querySelector(".psc-add-map-btn");
  if (addBtn) {
    addBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      addPSCToMap(psc, companyNumber, companyName);
    });
  }
  return card;
}

function renderOfficerCard(officer, companyNumber, companyName) {
  const card = document.createElement("div");
  card.className = "psc-card";

  const officerName = String(officer?.name || officer?.title || "Officer");
  const officerRole = formatOfficerRole(officer?.officer_role || "") || "Officer";
  const dob = formatPartialDobForDisplay(officer?.date_of_birth);

  let html = `
    <div class="psc-card-header">
      <div class="psc-name">${escapeHtml(officerName)}</div>
      <span class="popup-tag psc-tag-individual">${escapeHtml(officerRole)}</span>
    </div>
  `;

  if (dob || officer?.nationality || officer?.country_of_residence) {
    const nat = formatCountryWithFlag(officer?.nationality || "");
    const cor = formatCountryWithFlag(officer?.country_of_residence || "");
    html += `<div class="psc-detail psc-detail-flags">`;
    if (dob) html += `<span class="psc-label">DOB:</span> ${escapeHtml(dob)} `;
    if (nat) html += `<span class="psc-flag-chip"><span class="psc-label">Nationality</span> ${escapeHtml(nat)}</span> `;
    if (cor) html += `<span class="psc-flag-chip"><span class="psc-label">Residence</span> ${escapeHtml(cor)}</span>`;
    html += `</div>`;
  }
  if (officer?.appointed_on) {
    html += `<div class="psc-detail"><span class="psc-label">Appointed:</span> ${escapeHtml(officer.appointed_on)}</div>`;
  }
  if (officer?.resigned_on) {
    html += `<div class="psc-detail"><span class="psc-label">Resigned:</span> ${escapeHtml(officer.resigned_on)}</div>`;
  }

  html += `<div class="popup-btn-row">`;
  if (officerCanMap(officer)) {
    html += `<button class="popup-psc-btn officer-add-map-btn" type="button">Add Officer to Map</button>`;
  } else {
    html += `<button class="popup-psc-btn" type="button" disabled title="No postcode available">Add Officer to Map</button>`;
  }
  html += `</div>`;

  card.innerHTML = html;
  const addBtn = card.querySelector(".officer-add-map-btn");
  if (addBtn) {
    addBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      addOfficerToMap(officer, companyNumber, companyName);
    });
  }
  return card;
}

function displayPSCResults(container, pscData, companyNumber, companyName) {
  container.innerHTML = '';
  
  if (!pscData || pscData.length === 0) {
    container.innerHTML = '<div class="ch-result-count">No PSC records found</div>';
    return;
  }
  
  // Header with download button
  const header = document.createElement('div');
  header.className = 'psc-results-header';
  header.innerHTML = `
    <div class="ch-result-count">${pscData.length} PSC record${pscData.length === 1 ? '' : 's'}</div>
    <button class="btn-download-pdf" onclick="downloadPSCReport('${escapeHtml(companyNumber)}', '${escapeHtml(companyName)}', window._currentPSCData)">
      📄 Download PDF
    </button>
  `;
  container.appendChild(header);
  
  // Store data globally for PDF download
  window._currentPSCData = pscData;
  
  // PSC cards
  pscData.forEach(psc => {
    container.appendChild(renderPSCCard(psc, companyNumber, companyName));
  });
}

function displayCompanyPeopleResults(container, pscData, officerData, companyNumber, companyName) {
  container.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "psc-results-header";
  summary.innerHTML = `
    <div class="ch-result-count">
      ${pscData.length} PSC${pscData.length === 1 ? "" : "s"} | ${officerData.length} Officer${officerData.length === 1 ? "" : "s"}
    </div>
    <button class="btn-download-pdf" onclick="downloadPSCReport('${escapeHtml(companyNumber)}', '${escapeHtml(companyName)}', window._currentPSCData)">
      Download PSC PDF
    </button>
  `;
  container.appendChild(summary);
  window._currentPSCData = pscData;

  const pscSection = document.createElement("div");
  pscSection.innerHTML = `<div class="ch-result-count" style="margin-top:8px;">PSC</div>`;
  if (pscData.length) {
    pscData.forEach((psc) => pscSection.appendChild(renderPSCCard(psc, companyNumber, companyName)));
  } else {
    const empty = document.createElement("div");
    empty.className = "ch-result-count";
    empty.textContent = "No PSC records found";
    pscSection.appendChild(empty);
  }
  container.appendChild(pscSection);

  const officerSection = document.createElement("div");
  officerSection.innerHTML = `<div class="ch-result-count" style="margin-top:12px;">Officers</div>`;
  if (officerData.length) {
    officerData.forEach((officer) => officerSection.appendChild(renderOfficerCard(officer, companyNumber, companyName)));
  } else {
    const empty = document.createElement("div");
    empty.className = "ch-result-count";
    empty.textContent = "No officer records found";
    officerSection.appendChild(empty);
  }
  container.appendChild(officerSection);
}

// View PSC for company (called from popup or elsewhere)
async function viewCompanyPSC(companyNumber, companyName = '') {
  const resultsDiv = openPscQuickPanel(companyNumber, companyName) || document.getElementById("psc_results");
  const fallbackResultsDiv = document.getElementById("psc_results");
  resultsDiv.innerHTML = '<div class="ch-loading">Loading PSC and officer data from API...</div>';
  if (fallbackResultsDiv && fallbackResultsDiv !== resultsDiv) {
    fallbackResultsDiv.innerHTML = '<div class="ch-loading">Loading PSC and officer data from API...</div>';
  }
  showPscProgress();
  setPscProgress("Fetching PSC and officer records...", 50);
  setStatus(`Loading people for company #${companyNumber}...`);

  const [pscRecords, officerRecords] = await Promise.all([
    getPSCForCompanyAPI(companyNumber),
    getOfficersForCompanyAPI(companyNumber)
  ]);
  
  hidePscProgress();
  
  // Get company name if not provided
  if (!companyName && pscRecords.length === 0) {
    companyName = `Company #${companyNumber}`;
  }
  
  displayCompanyPeopleResults(resultsDiv, pscRecords, officerRecords, companyNumber, companyName);
  if (fallbackResultsDiv && fallbackResultsDiv !== resultsDiv) {
    displayCompanyPeopleResults(fallbackResultsDiv, pscRecords, officerRecords, companyNumber, companyName);
  }
  setStatus(
    `${pscRecords.length} PSC record${pscRecords.length === 1 ? "" : "s"}, ` +
    `${officerRecords.length} officer record${officerRecords.length === 1 ? "" : "s"} for #${companyNumber}`
  );
}
