// ================== system_health.js ==================
// Simple runtime checks so users can verify hosted-mode readiness.

async function checkHealthEndpoint(name, path, expected = 200) {
  try {
    const r = await fetch(apiUrl(path), { headers: { Accept: "application/json" } });
    return {
      name,
      ok: r.status === expected || r.ok,
      status: r.status
    };
  } catch (_) {
    return {
      name,
      ok: false,
      status: 0
    };
  }
}

function renderSystemHealth(items) {
  const wrap = document.getElementById("system-health-results");
  const mini = document.getElementById("status-health-mini");

  const html = items.map((item) => {
    const cls = item.ok ? "system-health-ok" : (item.status ? "system-health-warn" : "system-health-bad");
    const label = item.ok ? "OK" : (item.status ? `HTTP ${item.status}` : "DOWN");
    return (
      `<div class="system-health-item">` +
      `<span class="system-health-name">${escapeHtml(item.name)}</span>` +
      `<span class="system-health-badge ${cls}">${escapeHtml(label)}</span>` +
      `</div>`
    );
  }).join("");

  if (wrap) {
    wrap.innerHTML = html;
  }

  if (mini) {
    mini.innerHTML = items.map((item) => {
      const cls = item.ok ? "system-health-ok" : (item.status ? "system-health-warn" : "system-health-bad");
      const label = item.ok ? "OK" : (item.status ? `HTTP ${item.status}` : "DOWN");
      return `<span class="status-health-chip ${cls}">${escapeHtml(item.name)}: ${escapeHtml(label)}</span>`;
    }).join("");
  }
}

async function runSystemHealthChecks() {
  const tests = [
    ["TfL API", "/tfl/Line/Mode/tube/Status", 200],
    ["WebTRIS Roads", "/webtris/v1.0/sites", 200],
    ["Rail Stations", "/nre/stations?q=kgx&limit=3", 200],
    ["Companies House", "/ch/search/companies?q=hsbc&items_per_page=1", 200],
    ["Postcodes", "/postcodes/postcodes/SW1A1AA", 200]
  ];

  const results = [];
  for (const [name, path, expected] of tests) {
    results.push(await checkHealthEndpoint(name, path, expected));
  }
  renderSystemHealth(results);
}

function initMobilePanelToggle() {
  const btn = document.getElementById("mobile-panel-toggle");
  const panel = document.getElementById("control-panel");
  if (!btn || !panel) return;
  btn.addEventListener("click", () => {
    panel.classList.toggle("mobile-hidden");
    btn.textContent = panel.classList.contains("mobile-hidden") ? "Open" : "Panel";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initMobilePanelToggle();
  runSystemHealthChecks();
  setInterval(runSystemHealthChecks, 120000);
});
