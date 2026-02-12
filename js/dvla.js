// ================== dvla.js ==================
// DVLA Vehicle Enquiry Service integration via proxy.

const DVLA_STATE = {
  lastResult: null
};

function normalizeVrmInput(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function fetchDvlaVehicle(vrm) {
  const registrationNumber = normalizeVrmInput(vrm);
  if (!registrationNumber) {
    throw new Error("Registration number is required.");
  }
  const resp = await fetch(apiUrl("/dvla/vehicle"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({ registrationNumber })
  });
  let payload = {};
  try {
    payload = await resp.json();
  } catch (_) {
    payload = {};
  }
  if (!resp.ok) {
    const msg = payload?.error || payload?.detail || `DVLA HTTP ${resp.status}`;
    throw new Error(String(msg));
  }
  if (!payload || !payload.registrationNumber) {
    throw new Error("DVLA returned no vehicle record.");
  }
  return payload;
}

function renderDvlaResult(vehicle) {
  const wrap = document.getElementById("dvla-results");
  if (!wrap) return;
  const matchedIconPath = typeof window.getDvlaVehicleIconPath === "function"
    ? String(window.getDvlaVehicleIconPath(vehicle || {}) || "")
    : "";
  const logoPath = matchedIconPath || (typeof window.getVehicleMakeLogoPath === "function"
    ? String(window.getVehicleMakeLogoPath(vehicle.make || "") || "")
    : "");
  const logoAlt = matchedIconPath
    ? `${String(vehicle.make || "Vehicle")} matched icon`
    : `${String(vehicle.make || "Vehicle")} logo`;
  const logoHtml = logoPath
    ? `<div class="dvla-logo-wrap"><img class="dvla-logo" src="${escapeHtml(logoPath)}" alt="${escapeHtml(logoAlt)}" /></div>`
    : "";

  const rows = [
    ["Registration", vehicle.registrationNumber || ""],
    ["Make", vehicle.make || ""],
    ["Model", vehicle.model || ""],
    ["First Registered", vehicle.monthOfFirstRegistration || ""],
    ["Colour", vehicle.colour || ""],
    ["Fuel", vehicle.fuelType || ""],
    ["Year", vehicle.yearOfManufacture || ""],
    ["MOT", vehicle.motStatus || ""],
    ["Tax", vehicle.taxStatus || ""],
    ["Engine (cc)", vehicle.engineCapacity || ""],
    ["CO2", vehicle.co2Emissions || ""]
  ].filter((r) => String(r[1] || "").trim());

  const details = rows
    .map(([k, v]) => `<div class="dvla-row"><span class="dvla-key">${escapeHtml(k)}</span><span class="dvla-val">${escapeHtml(String(v))}</span></div>`)
    .join("");

  wrap.innerHTML =
    `<div class="dvla-card">` +
    `<div class="dvla-title">${escapeHtml(vehicle.registrationNumber || "Vehicle")}</div>` +
    logoHtml +
    details +
    `<div class="cp-btn-row" style="margin-top:8px;">` +
    `<button id="dvla-add-map-btn" class="btn-secondary btn-sm" type="button">Add Vehicle To Map</button>` +
    `</div>` +
    `</div>`;

  const addBtn = document.getElementById("dvla-add-map-btn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (typeof window.addDvlaVehicleEntity === "function") {
        window.addDvlaVehicleEntity(vehicle);
      }
    });
  }
}

async function runDvlaLookup() {
  const input = document.getElementById("dvla-vrm-input");
  const wrap = document.getElementById("dvla-results");
  const vrm = normalizeVrmInput(input?.value || "");
  if (!vrm) {
    if (wrap) wrap.innerHTML = `<div class="nr-empty">Enter a registration (VRM)</div>`;
    return;
  }
  if (wrap) wrap.innerHTML = `<div class="ch-loading">Querying DVLA...</div>`;
  setStatus(`Checking DVLA for ${vrm}...`);
  try {
    const vehicle = await fetchDvlaVehicle(vrm);
    DVLA_STATE.lastResult = vehicle;
    renderDvlaResult(vehicle);
    setStatus(`DVLA record loaded: ${vehicle.registrationNumber || vrm}`);
  } catch (err) {
    const msg = String(err?.message || err);
    if (wrap) wrap.innerHTML = `<div class="nr-alert">DVLA lookup failed: ${escapeHtml(msg)}</div>`;
    setStatus("DVLA lookup failed");
  }
}

function clearDvlaLookup() {
  const input = document.getElementById("dvla-vrm-input");
  const wrap = document.getElementById("dvla-results");
  if (input) input.value = "";
  if (wrap) wrap.innerHTML = "";
  DVLA_STATE.lastResult = null;
  setStatus("DVLA cleared");
}

document.addEventListener("DOMContentLoaded", () => {
  const lookupBtn = document.getElementById("dvla-lookup-btn");
  const clearBtn = document.getElementById("dvla-clear-btn");
  const input = document.getElementById("dvla-vrm-input");
  if (lookupBtn) lookupBtn.addEventListener("click", runDvlaLookup);
  if (clearBtn) clearBtn.addEventListener("click", clearDvlaLookup);
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runDvlaLookup();
      }
    });
  }
});
