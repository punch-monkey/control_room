// ================== ch_api.js ==================
// Companies House Live API Integration (ADDITIVE MODULE)
// Calls CH API directly with Basic Auth (API key from js/api_keys.js)

// ── Shared fetch helper for Companies House API ──
// ─────────────────────────────────────────────
// ⚠️ INSECURE DIRECT BROWSER VERSION
// This exposes your API key in DevTools.
// Do NOT use in production.
// ─────────────────────────────────────────────

// Direct Companies House fetch
function fetchCH(path) {
  const baseUrl = "https://api.company-information.service.gov.uk";

  if (!window.CH_API_KEY) {
    console.error("CH API key not set.");
    return Promise.reject(new Error("CH_API_KEY not configured"));
  }

  return fetch(baseUrl + path, {
    headers: {
      "Authorization": "Basic " + btoa(window.CH_API_KEY + ":"),
      "Accept": "application/json"
    }
  });
}


// ── API Client ──

const CH_API = {
  cache: {
    search: new Map(),
    company: new Map()
  },
  cacheTTL: {
    search: 120000,   // 2 minutes
    company: 600000   // 10 minutes
  }
};


// ─────────────────────────────────────────────
// Search companies
// ─────────────────────────────────────────────

async function searchCompaniesAPI(query, limit = 20) {

  if (!query || query.trim().length < 2) return [];

  const cacheKey = `${query.trim().toLowerCase()}_${limit}`;
  const cached = CH_API.cache.search.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < CH_API.cacheTTL.search)) {
    return cached.data;
  }

  try {
    const response = await fetchCH(
      `/search/companies?q=${encodeURIComponent(query)}&items_per_page=${limit}`
    );

    if (!response.ok) {
      console.error("CH API search failed:", response.status);
      return [];
    }

    const data = await response.json();
    const items = data.items || [];

    CH_API.cache.search.set(cacheKey, {
      data: items,
      timestamp: Date.now()
    });

    // Prevent unbounded cache growth
    if (CH_API.cache.search.size > 50) {
      const firstKey = CH_API.cache.search.keys().next().value;
      CH_API.cache.search.delete(firstKey);
    }

    return items;

  } catch (err) {
    console.error("CH API search error:", err);
    return [];
  }
}


// ─────────────────────────────────────────────
// Get company profile
// ─────────────────────────────────────────────

async function getCompanyProfile(companyNumber) {

  if (!companyNumber) return null;

  const cacheKey = companyNumber.trim().toUpperCase();
  const cached = CH_API.cache.company.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < CH_API.cacheTTL.company)) {
    return cached.data;
  }

  try {
    const response = await fetchCH(
      `/company/${encodeURIComponent(companyNumber)}`
    );

    if (!response.ok) {
      console.error("CH API company fetch failed:", response.status);
      return null;
    }

    const data = await response.json();

    CH_API.cache.company.set(cacheKey, {
      data: data,
      timestamp: Date.now()
    });

    if (CH_API.cache.company.size > 100) {
      const firstKey = CH_API.cache.company.keys().next().value;
      CH_API.cache.company.delete(firstKey);
    }

    return data;

  } catch (err) {
    console.error("CH API company error:", err);
    return null;
  }
}


// ── UI Integration ──

let suggestionsDebounceTimer = null;

function debounceSearch(fn, delay) {
  return function(...args) {
    clearTimeout(suggestionsDebounceTimer);
    suggestionsDebounceTimer = setTimeout(() => fn(...args), delay);
  };
}

// Display search suggestions
function displaySuggestions(suggestions) {
  const dropdown = document.getElementById("ch_api_suggestions");
  if (!dropdown) return;

  dropdown.innerHTML = "";

  if (!suggestions || suggestions.length === 0) {
    dropdown.classList.remove("active");
    return;
  }

  suggestions.forEach(item => {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    
    const title = item.title || item.company_name || "Unknown Company";
    const number = item.company_number || "";
    const address = item.address_snippet || formatAddress(item.address);
    
    div.innerHTML = `
      <div class="suggestion-title">${escapeHtml(title)}</div>
      <div class="suggestion-detail">${escapeHtml(number)} • ${escapeHtml(address)}</div>
    `;
    
    div.addEventListener("click", () => selectCompany(item));
    dropdown.appendChild(div);
  });

  dropdown.classList.add("active");
}

// Format company address from API response
function formatAddress(addressObj) {
  if (!addressObj) return "";
  
  const parts = [];
  if (addressObj.postal_code) parts.push(addressObj.postal_code);
  if (addressObj.locality) parts.push(addressObj.locality);
  if (addressObj.region) parts.push(addressObj.region);
  
  return parts.join(", ") || "No address";
}

// Handle company selection from suggestions
async function selectCompany(item) {
  const dropdown = document.getElementById("ch_api_suggestions");
  const selectedDiv = document.getElementById("ch_api_selected");
  const searchInput = document.getElementById("ch_api_search");
  
  if (dropdown) dropdown.classList.remove("active");
  if (searchInput) searchInput.value = "";
  
  // Show loading state
  if (selectedDiv) {
    selectedDiv.innerHTML = '<div class="ch-loading">Loading company details...</div>';
  }

  // Fetch full company profile
  const companyNumber = item.company_number;
  const profile = await getCompanyProfile(companyNumber);

  if (!profile) {
    if (selectedDiv) {
      selectedDiv.innerHTML = '<div class="ch-error">Failed to load company details</div>';
    }
    return;
  }

  // Display selected company
  displaySelectedCompany(profile);

  // Plot on map
  plotCompanyFromAPI(profile);
}

// Display selected company info
function displaySelectedCompany(profile) {
  const selectedDiv = document.getElementById("ch_api_selected");
  if (!selectedDiv) return;

  const name = profile.company_name || "Unknown";
  const number = profile.company_number || "";
  const status = profile.company_status || "";
  const address = profile.registered_office_address || {};
  
  const addressStr = formatFullAddress(address);

  selectedDiv.innerHTML = `
    <div class="ch-selected-card">
      <div class="ch-selected-name">${escapeHtml(name)}</div>
      <div class="ch-selected-detail">
        <span class="popup-label">Company #</span> ${escapeHtml(number)}
      </div>
      ${status ? `<div class="ch-selected-detail"><span class="popup-label">Status</span> <span class="popup-tag">${escapeHtml(status)}</span></div>` : ""}
      ${addressStr ? `<div class="ch-selected-detail">${escapeHtml(addressStr)}</div>` : ""}
      <button class="btn-secondary btn-sm" onclick="clearAPISelection()">Clear</button>
    </div>
  `;
}

// Format full address
function formatFullAddress(address) {
  if (!address) return "";
  
  const parts = [];
  if (address.address_line_1) parts.push(address.address_line_1);
  if (address.address_line_2) parts.push(address.address_line_2);
  if (address.locality) parts.push(address.locality);
  if (address.postal_code) parts.push(address.postal_code);
  
  return parts.join(", ");
}

// Clear API selection
function clearAPISelection() {
  const selectedDiv = document.getElementById("ch_api_selected");
  if (selectedDiv) selectedDiv.innerHTML = "";
}

// Plot company from API on map (using existing map infrastructure)
async function plotCompanyFromAPI(profile) {
  const address = profile.registered_office_address;
  if (!address || !address.postal_code) {
    setStatus("Company has no postcode - cannot plot on map");
    return;
  }

  // Extract postcode and convert to format for lookup
  const rawPostcode = address.postal_code;
  const postcode = rawPostcode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  
  // Use existing postcode lookup infrastructure
  const area = postcodeArea(postcode);
  if (!area) {
    setStatus(`Invalid postcode format: ${rawPostcode}`);
    return;
  }

  // Load postcode area if needed
  await loadPostcodeArea(area);
  
  const coords = lookupPostcode(postcode);
  if (!coords) {
    setStatus(`Postcode not found in database: ${rawPostcode}`);
    return;
  }

  // Create marker using existing company layer
  const name = profile.company_name || "Unknown Company";
  const number = profile.company_number || "";
  const status = profile.company_status || "";
  
  const popup = `
    <strong>${escapeHtml(name)}</strong>
    <span class="popup-label">Company #</span> ${escapeHtml(number)}<br>
    ${escapeHtml(formatFullAddress(address))}<br>
    ${status ? `<span class="popup-label">Status</span> <span class="popup-tag">${escapeHtml(status)}</span>` : ""}
    <span class="popup-tag" style="background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3);">Live API</span>
    <div class="popup-btn-row">
      <button class="popup-psc-btn" onclick="viewCompanyPsc('${escapeHtml(number)}', '${escapeHtml(name).replace(/'/g, "\\'")}')">View PSC</button>
      <button class="popup-psc-btn" onclick="downloadCompanyProfile('${escapeHtml(number)}', '${escapeHtml(name).replace(/'/g, "\\'")}')">Profile PDF</button>
      <button class="popup-psc-btn" onclick="downloadFilingHistory('${escapeHtml(number)}', '${escapeHtml(name).replace(/'/g, "\\'")}')">Filings PDF</button>
    </div>
  `;

  // Use custom icon or circle marker
  const useCircle = window._useCircleMarkers !== false;
  const marker = createCustomMarker([coords.lat, coords.lon], 'company', 'api', useCircle);
  marker.bindPopup(popup).addTo(layers.companies);

  // Ensure layer is visible
  if (!map.hasLayer(layers.companies)) {
    layers.companies.addTo(map);
    const cb = document.querySelector('[data-layer="companies"]');
    if (cb) cb.checked = true;
  }

  // Pan to marker (no zoom)
  map.panTo([coords.lat, coords.lon]);
  marker.openPopup();
  
  setStatus(`Plotted: ${name}`);
}

// ── Event Listeners (Initialized after DOM ready) ──

function initializeAPISearch() {
  const searchInput = document.getElementById("ch_api_search");
  const dropdown = document.getElementById("ch_api_suggestions");

  if (!searchInput) return;

  // Debounced search handler
  const handleSearch = debounceSearch(async (query) => {
    if (!query || query.trim().length < 2) {
      displaySuggestions([]);
      return;
    }

    const results = await searchCompaniesAPI(query, 20);
    displaySuggestions(results);
  }, 400);  // 400ms debounce

  // Input event
  searchInput.addEventListener("input", (e) => {
    handleSearch(e.target.value);
  });

  // Hide dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".autocomplete-wrapper") && dropdown) {
      dropdown.classList.remove("active");
    }
  });

  // Clear on escape
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dropdown) {
      dropdown.classList.remove("active");
      searchInput.value = "";
    }
  });
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAPISearch);
} else {
  initializeAPISearch();
}
