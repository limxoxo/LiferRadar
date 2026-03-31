// ── Configuration ────────────────────────────────────────────────────────────

// IMPORTANT: After deploying the Cloudflare Worker, replace this URL with yours.
// For local development, set to "" to use the Python dev server as a fallback.
const PROXY_BASE = "";  // e.g., "https://ebird-proxy.youraccount.workers.dev"

// If PROXY_BASE is empty, fall back to direct eBird API (works locally or if
// the browser doesn't enforce CORS, e.g., extensions / local file).
const EBIRD_BASE = "https://api.ebird.org/v2";

function apiBase() {
  return PROXY_BASE || EBIRD_BASE;
}

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  apiKey: "",
  mySpecies: new Set(),        // scientific names the user has seen
  lat: null,
  lng: null,
  csvRaw: null,                // raw CSV text for re-parsing on mode/scope change
  results: [],                 // processed location results
  notableSet: new Set(),       // scientific names flagged as notable/rare
  taxonomyCache: {},           // locale -> { speciesCode -> comName }
};

// ── DOM refs ────────────────────────────────────────────────────────────────

const $apiKey       = document.getElementById("apiKey");
const $csvUpload    = document.getElementById("csvUpload");
const $csvStatus    = document.getElementById("csvStatus");
const $listMode     = document.getElementById("listMode");
const $scope        = document.getElementById("scope");
const $locale       = document.getElementById("locale");
const $locationSearch = document.getElementById("locationSearch");
const $radius       = document.getElementById("radius");
const $radiusVal    = document.getElementById("radiusVal");
const $back         = document.getElementById("back");
const $backVal      = document.getElementById("backVal");
const $searchBtn    = document.getElementById("searchBtn");
const $sortBy       = document.getElementById("sortBy");
const $sortPanel    = document.getElementById("sortPanel");
const $summary      = document.getElementById("summary");
const $results      = document.getElementById("results");
const $loading      = document.getElementById("loading");
const $loadingMsg   = document.getElementById("loadingMsg");
const $clearCsvBtn  = document.getElementById("clearCsvBtn");

// ── Map setup ───────────────────────────────────────────────────────────────

const map = L.map("map").setView([40, -95], 4);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  maxZoom: 18,
}).addTo(map);

let searchMarker = null;
let searchCircle = null;
let hotspotMarkers = [];

setTimeout(() => map.invalidateSize(), 200);

function setLocation(lat, lng) {
  state.lat = lat;
  state.lng = lng;
  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.marker([lat, lng]).addTo(map);
  map.setView([lat, lng], 10);
  updateSearchBtn();
  updateRadiusCircle();
}

function updateRadiusCircle() {
  if (searchCircle) map.removeLayer(searchCircle);
  if (state.lat == null) return;
  searchCircle = L.circle([state.lat, state.lng], {
    radius: parseInt($radius.value) * 1000,
    color: "#e94560", fillColor: "#e94560", fillOpacity: 0.06, weight: 1,
  }).addTo(map);
}

// ── Location geocoding (Nominatim) ─────────────────────────────────────────

let searchTimeout = null;
$locationSearch.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const q = $locationSearch.value.trim();
    if (!q || q.length < 3) return;
    const coordMatch = q.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      setLocation(parseFloat(coordMatch[1]), parseFloat(coordMatch[2]));
      return;
    }
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { "User-Agent": "eBirdLocationChecker/1.0" } }
      );
      const data = await resp.json();
      if (data.length > 0) {
        setLocation(parseFloat(data[0].lat), parseFloat(data[0].lon));
        $locationSearch.value = data[0].display_name.split(",").slice(0, 2).join(",");
      }
    } catch { /* ignore */ }
  }, 600);
});

// ── Sliders ─────────────────────────────────────────────────────────────────

$radius.addEventListener("input", () => {
  $radiusVal.textContent = $radius.value;
  updateRadiusCircle();
});
$back.addEventListener("input", () => {
  $backVal.textContent = $back.value;
});

// ── API key persistence ────────────────────────────────────────────────────

$apiKey.addEventListener("input", () => {
  state.apiKey = $apiKey.value.trim();
  localStorage.setItem("ebirdApiKey", state.apiKey);
  updateSearchBtn();
});

const savedKey = localStorage.getItem("ebirdApiKey");
if (savedKey) { $apiKey.value = savedKey; state.apiKey = savedKey; }

// ── CSV parsing (fully client-side) ────────────────────────────────────────

$csvUpload.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.csvRaw = await file.text();
  try { localStorage.setItem("ebirdCSV", state.csvRaw); } catch { /* quota */ }
  parseCSV();
});

$listMode.addEventListener("change", () => { if (state.csvRaw) parseCSV(); });
$scope.addEventListener("change", () => { if (state.csvRaw) parseCSV(); });

$clearCsvBtn.addEventListener("click", () => {
  localStorage.removeItem("ebirdCSV");
  state.csvRaw = null;
  state.mySpecies = new Set();
  $csvUpload.value = "";
  $csvStatus.classList.add("hidden");
  $clearCsvBtn.classList.add("hidden");
  $scope.innerHTML = '<option value="world">World</option>';
  updateSearchBtn();
});

const savedCSV = localStorage.getItem("ebirdCSV");
if (savedCSV) { state.csvRaw = savedCSV; parseCSV(); }

function parseCSV() {
  const mode = $listMode.value;
  const scope = $scope.value;
  const currentYear = new Date().getFullYear();

  try {
    const rows = parseCSVRows(state.csvRaw);
    if (rows.length === 0) throw new Error("No data rows found");

    const seen = new Set();
    for (const row of rows) {
      const sciName = (row["Scientific Name"] || "").trim();
      if (!sciName) continue;

      // Scope filter
      if (scope !== "world") {
        const stateProv = (row["State/Province"] || "").trim();
        const country = stateProv.includes("-") ? stateProv.split("-")[0] : stateProv;
        if (scope.includes("-")) {
          if (stateProv !== scope) continue;
        } else {
          if (country !== scope) continue;
        }
      }

      // Year filter
      if (mode === "year") {
        const dateStr = (row["Date"] || "").trim();
        if (!dateStr) continue;
        const yr = parseInt(dateStr.split("-")[0]);
        if (yr !== currentYear) continue;
      }

      seen.add(sciName);
    }

    state.mySpecies = seen;
    $csvStatus.textContent = `${seen.size} species in your ${mode === "year" ? "year" : "life"} list`;
    $csvStatus.className = "status-badge success";
    $csvStatus.classList.remove("hidden");
    $clearCsvBtn.classList.remove("hidden");

    populateScopes();
    updateSearchBtn();
  } catch (err) {
    $csvStatus.textContent = `Error: ${err.message}`;
    $csvStatus.className = "status-badge error";
    $csvStatus.classList.remove("hidden");
  }
}

function parseCSVRows(raw) {
  // Parse CSV string into array of {header: value} objects
  const lines = raw.split("\n");
  if (lines.length < 2) return [];

  const headers = csvSplitRow(lines[0]).map(h => h.replace(/^\uFEFF/, "").trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = csvSplitRow(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cols[idx] || "").trim(); });
    rows.push(obj);
  }
  return rows;
}

function csvSplitRow(row) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (const ch of row) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current); current = ""; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

function populateScopes() {
  const lines = state.csvRaw.split("\n");
  if (lines.length < 2) return;
  const header = lines[0].split(",").map(h => h.replace(/"/g, "").replace(/^\uFEFF/, "").trim());
  const stateIdx = header.indexOf("State/Province");
  const countries = new Set();
  const states = new Set();

  for (let i = 1; i < lines.length; i++) {
    const cols = csvSplitRow(lines[i]);
    if (stateIdx >= 0 && cols[stateIdx]) {
      const sp = cols[stateIdx].replace(/"/g, "").trim();
      if (sp) {
        states.add(sp);
        const dash = sp.indexOf("-");
        if (dash > 0) countries.add(sp.substring(0, dash));
      }
    }
  }

  const current = $scope.value;
  $scope.innerHTML = '<option value="world">World</option>';
  [...countries].sort().forEach(c => {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = c;
    $scope.appendChild(opt);
  });
  [...states].sort().forEach(s => {
    if (!s) return;
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s;
    $scope.appendChild(opt);
  });
  if ([...countries, ...states, "world"].includes(current)) $scope.value = current;
}

// ── Search button state ─────────────────────────────────────────────────────

function updateSearchBtn() {
  $searchBtn.disabled = !(state.apiKey && state.lat != null && state.mySpecies.size > 0);
}

// ── eBird API helpers ───────────────────────────────────────────────────────

async function ebirdGet(path, params = {}) {
  const url = new URL(apiBase() + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  });

  const resp = await fetch(url.toString(), {
    headers: { "X-eBirdApiToken": state.apiKey },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`eBird API error ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

// Multi-point tiling for radii > 50km
function queryPoints(lat, lng, distKm) {
  const MAX_R = 50;
  if (distKm <= MAX_R) return [{ lat, lng, dist: distKm }];

  const points = [];
  const step = 70;
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos(lat * Math.PI / 180);
  const stepsLat = Math.floor(distKm / step) + 1;
  const stepsLng = Math.floor(distKm / step) + 1;

  for (let i = -stepsLat; i <= stepsLat; i++) {
    for (let j = -stepsLng; j <= stepsLng; j++) {
      const plat = lat + (i * step) / kmPerDegLat;
      const plng = lng + (j * step) / Math.max(kmPerDegLng, 1);
      const dlat = (plat - lat) * kmPerDegLat;
      const dlng = (plng - lng) * kmPerDegLng;
      if (Math.sqrt(dlat * dlat + dlng * dlng) <= distKm + MAX_R) {
        points.push({ lat: Math.round(plat * 100) / 100, lng: Math.round(plng * 100) / 100, dist: MAX_R });
      }
    }
  }
  return points;
}

async function multiGeoQuery(path, lat, lng, distKm, extraParams) {
  const points = queryPoints(lat, lng, distKm);

  const batches = await Promise.all(
    points.map(p => ebirdGet(path, { lat: p.lat, lng: p.lng, dist: p.dist, ...extraParams })
      .catch(() => []))  // Don't fail entire search if one tile errors
  );

  // Flatten, deduplicate, filter to actual radius
  const seenKeys = new Set();
  const merged = [];
  for (const batch of batches) {
    for (const obs of batch) {
      const obsLat = obs.lat;
      const obsLng = obs.lng;
      if (obsLat != null && obsLng != null && haversine(lat, lng, obsLat, obsLng) > distKm) continue;

      const key = obs.speciesCode
        ? `${obs.locId}|${obs.speciesCode}|${obs.subId || ""}`
        : obs.locId;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        merged.push(obs);
      }
    }
  }
  return merged;
}

// ── Taxonomy (for locale-correct names) ────────────────────────────────────

async function getTaxonomy(locale) {
  if (state.taxonomyCache[locale]) return state.taxonomyCache[locale];

  try {
    // Taxonomy endpoint doesn't need auth
    const url = `https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&locale=${locale}&cat=species`;
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const data = await resp.json();
    const mapping = {};
    for (const item of data) {
      mapping[item.speciesCode] = item.comName;
    }
    state.taxonomyCache[locale] = mapping;
    return mapping;
  } catch {
    return {};
  }
}

function applyLocaleNames(observations, taxonomy) {
  for (const obs of observations) {
    if (obs.speciesCode && taxonomy[obs.speciesCode]) {
      obs.comName = taxonomy[obs.speciesCode];
    }
  }
  return observations;
}

// ── Main search ─────────────────────────────────────────────────────────────

$searchBtn.addEventListener("click", runSearch);

async function runSearch() {
  const lat = state.lat;
  const lng = state.lng;
  const dist = parseInt($radius.value);
  const back = parseInt($back.value);
  const locale = $locale.value;

  showLoading("Fetching observations...");

  try {
    // Fetch hotspots, observations, notable, and taxonomy in parallel
    const [hotspots, observations, notable, taxonomy] = await Promise.all([
      multiGeoQuery("/ref/hotspot/geo", lat, lng, dist, { back, fmt: "json" }),
      multiGeoQuery("/data/obs/geo/recent", lat, lng, dist, {
        back, cat: "species", hotspot: true, includeProvisional: true, maxResults: 10000, locale,
      }),
      multiGeoQuery("/data/obs/geo/recent/notable", lat, lng, dist, {
        back, hotspot: true, locale,
      }),
      getTaxonomy(locale),
    ]);

    setLoadingMsg("Processing results...");

    // Apply locale names
    applyLocaleNames(observations, taxonomy);
    applyLocaleNames(notable, taxonomy);

    // Build notable set (by scientific name)
    state.notableSet = new Set(notable.map(o => o.sciName));

    // Group observations by location
    const locMap = new Map();

    for (const hs of hotspots) {
      locMap.set(hs.locId, {
        locId: hs.locId, locName: hs.locName,
        lat: hs.lat, lng: hs.lng,
        numSpeciesAllTime: hs.numSpeciesAllTime,
        species: [], newSpecies: [],
      });
    }

    for (const obs of observations) {
      let loc = locMap.get(obs.locId);
      if (!loc) {
        loc = {
          locId: obs.locId, locName: obs.locName,
          lat: obs.lat, lng: obs.lng,
          numSpeciesAllTime: null,
          species: [], newSpecies: [],
        };
        locMap.set(obs.locId, loc);
      }

      if (!loc.species.find(s => s.sciName === obs.sciName)) {
        const isNew = !state.mySpecies.has(obs.sciName);
        const isNotable = state.notableSet.has(obs.sciName);
        const entry = {
          comName: obs.comName, sciName: obs.sciName,
          speciesCode: obs.speciesCode, obsDt: obs.obsDt,
          howMany: obs.howMany, isNew, isNotable,
        };
        loc.species.push(entry);
        if (isNew) loc.newSpecies.push(entry);
      }
    }

    state.results = [...locMap.values()].filter(l => l.newSpecies.length > 0);
    state.results.forEach(loc => {
      loc.distance = haversine(lat, lng, loc.lat, loc.lng);
      loc.rarityScore = loc.newSpecies.filter(s => s.isNotable).length;
    });

    sortResults();
    renderResults();
    renderMap();

  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    hideLoading();
  }
}

function sortResults() {
  const by = $sortBy.value;
  state.results.sort((a, b) => {
    if (by === "newSpecies") return b.newSpecies.length - a.newSpecies.length;
    if (by === "distance") return a.distance - b.distance;
    if (by === "rarity") return b.rarityScore - a.rarityScore;
    return 0;
  });
}

$sortBy.addEventListener("change", () => { sortResults(); renderResults(); });

// ── Rendering ───────────────────────────────────────────────────────────────

function renderResults() {
  $sortPanel.style.display = state.results.length > 0 ? "" : "none";

  const totalNew = new Set(state.results.flatMap(l => l.newSpecies.map(s => s.sciName))).size;
  if (state.results.length > 0) {
    $summary.textContent = `${totalNew} new species across ${state.results.length} locations`;
    $summary.classList.remove("hidden");
  } else {
    $summary.textContent = "No new species found in this area and timeframe.";
    $summary.classList.remove("hidden");
  }

  $results.innerHTML = "";
  state.results.forEach((loc, i) => {
    const card = document.createElement("div");
    card.className = "location-card";

    const notableCount = loc.newSpecies.filter(s => s.isNotable).length;
    const metaParts = [`${loc.distance.toFixed(1)} km away`];
    if (loc.numSpeciesAllTime) metaParts.push(`${loc.numSpeciesAllTime} species all-time`);

    card.innerHTML = `
      <div class="location-header" data-idx="${i}">
        <div>
          <div class="location-name">${esc(loc.locName)}</div>
          <div class="location-meta">${metaParts.join(" &middot; ")}</div>
        </div>
        <div>
          <span class="badge badge-new">${loc.newSpecies.length} new</span>
          ${notableCount > 0 ? `<span class="badge badge-notable">${notableCount} rare</span>` : ""}
        </div>
      </div>
      <div class="species-list" id="species-${i}">
        ${loc.newSpecies
          .sort((a, b) => (b.isNotable ? 1 : 0) - (a.isNotable ? 1 : 0))
          .map(s => `
            <div class="species-item">
              <div>
                <span>${esc(s.comName)}</span>
                ${s.isNotable ? '<span class="badge badge-notable">rare</span>' : ""}
                ${s.howMany ? `<span style="color:var(--text-dim);font-size:0.75rem"> (${s.howMany})</span>` : ""}
              </div>
              <span class="species-date">${formatDate(s.obsDt)}</span>
            </div>
          `).join("")}
      </div>
    `;

    card.querySelector(".location-header").addEventListener("click", () => {
      document.getElementById(`species-${i}`).classList.toggle("open");
      map.setView([loc.lat, loc.lng], 13);
    });

    $results.appendChild(card);
  });
}

function renderMap() {
  hotspotMarkers.forEach(m => map.removeLayer(m));
  hotspotMarkers = [];
  if (state.results.length === 0) return;

  const maxNew = Math.max(...state.results.map(l => l.newSpecies.length));

  state.results.forEach(loc => {
    const ratio = loc.newSpecies.length / Math.max(maxNew, 1);
    const color = ratio > 0.66 ? "#e94560" : ratio > 0.33 ? "#f39c12" : "#2ecc71";

    const marker = L.circleMarker([loc.lat, loc.lng], {
      radius: 6 + ratio * 10,
      fillColor: color, color: "#fff", weight: 1, fillOpacity: 0.85,
    }).addTo(map);

    const notableNames = loc.newSpecies.filter(s => s.isNotable).map(s => s.comName);
    marker.bindPopup(`
      <strong>${esc(loc.locName)}</strong><br/>
      <span>${loc.newSpecies.length} new species</span><br/>
      ${notableNames.length > 0 ? `<em style="color:#9b59b6">Rare: ${notableNames.map(esc).join(", ")}</em>` : ""}
    `);
    hotspotMarkers.push(marker);
  });

  const group = L.featureGroup(hotspotMarkers);
  if (searchMarker) group.addLayer(searchMarker);
  map.fitBounds(group.getBounds().pad(0.1));
}

// ── Utilities ───────────────────────────────────────────────────────────────

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function formatDate(dt) {
  if (!dt) return "";
  const d = new Date(dt.replace(" ", "T"));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function showLoading(msg) { $loading.classList.remove("hidden"); $loadingMsg.textContent = msg; }
function setLoadingMsg(msg) { $loadingMsg.textContent = msg; }
function hideLoading() { $loading.classList.add("hidden"); }
