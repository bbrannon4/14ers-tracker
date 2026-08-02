/* 14ers Tracker — reads a public Google Sheet live and renders a leaderboard
   and a multi-person planning map. No build step, no API key. */

'use strict';

// ---- Config -------------------------------------------------------------
const SHEET_ID = '1NvByLvFZtVWlwqHZ6ZoQ0S8Ps_DRHhQjw3E9EmHgkoo';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

const gviz = (tab) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

// ---- State --------------------------------------------------------------
let PEAKS = [];              // merged peak list: {peak,state,cmc,range,elevation,lat,lon,mappable}
let PEAK_BY_NAME = new Map();
let HIKERS = [];             // ordered list of hiker names
// summitsByHiker: name -> { unique:Set<peak>, total:int, cmcUnique:Set<peak> }
let STATS = new Map();
// peakSummiters: peak -> Set<hiker> who summited it (Summited? = Yes)
let SUMMITERS = new Map();

// Trailhead / town data (bundled in trailheads.json, GUI-only — not from the sheet).
let TRAILHEADS = [];         // [{name, lat, lon, towns:[name], peaks:[name]}]
let TOWNS = {};              // name -> {lat, lon}
let TH_BY_PEAK = new Map();  // normPeak(peak) -> trailhead object
let PEAK_URLS = {};          // normPeak(peak) -> 14ers.com page URL (Colorado only)

let map, markerLayer, lineLayer, thLayer, townLayer;
const selectedHikers = new Set();
let lbSort = { key: 'unique', dir: -1 };

const TH_COLOR = '#2b6cb0';    // trailhead marker (blue)
const TOWN_COLOR = '#6b46c1';  // approach-town marker (purple)

// ---- Utilities ----------------------------------------------------------
// Normalize a peak name so the Hike Register and the 14ers tab join reliably
// even when they differ on "Mt." vs "Mount", punctuation, or spacing.
function normPeak(s) {
  return String(s).toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/^(mount|mt\.?)\s+/, 'mt ')
    .replace(/\./g, '');
}

// Parse "39.1503°N 107.0829°W" -> {lat, lon}
function parseCoords(str) {
  if (!str) return null;
  const m = str.match(/([\d.]+)\s*°?\s*([NS])[,\s]+([\d.]+)\s*°?\s*([EW])/i);
  if (!m) return null;
  let lat = parseFloat(m[1]); if (m[2].toUpperCase() === 'S') lat = -lat;
  let lon = parseFloat(m[3]); if (m[4].toUpperCase() === 'W') lon = -lon;
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon };
}

function parseElevation(str) {
  const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

// Parse a gviz CSV into row objects keyed by header name.
// We parse with header:false and map columns ourselves because these sheets
// carry ~20 trailing empty header columns; PapaParse's header:true dedup
// mangles those and silently drops the first data row. This also trims every
// value and tolerates column reordering (mapping is by header name, not index).
function fetchCsv(tab) {
  return new Promise((resolve, reject) => {
    Papa.parse(gviz(tab), {
      download: true,
      header: false,
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const rows = res.data;
        if (!rows.length) return resolve([]);
        const headers = rows[0].map((h) => String(h == null ? '' : h).trim());
        const objs = rows.slice(1).map((row) => {
          const o = {};
          headers.forEach((h, i) => { if (h) o[h] = String(row[i] == null ? '' : row[i]).trim(); });
          return o;
        });
        resolve(objs);
      },
      error: (err) => reject(err),
    });
  });
}

// ---- Data loading -------------------------------------------------------
async function loadData() {
  const [peakRows, regRows, thData] = await Promise.all([
    fetchCsv('14ers'),
    fetchCsv('Hike Register'),
    fetch('trailheads.json').then((r) => r.json()).catch(() => ({ trailheads: [], towns: {} })),
  ]);

  buildPeaks(peakRows);
  buildStats(regRows);
  buildHikerRoster(regRows);
  buildTrailheads(thData);

  document.getElementById('dataStatus').textContent =
    `${PEAKS.length} peaks · ${HIKERS.length} hikers · loaded ${new Date().toLocaleString()}`;
  document.getElementById('sheetLink').href = SHEET_URL;
}

function buildPeaks(rows) {
  PEAKS = [];
  PEAK_BY_NAME = new Map();

  // The "14ers" tab is the source of truth for the peak universe and coordinates.
  for (const r of rows) {
    const name = (r.Peak || '').trim();
    if (!name) continue;
    const coords = parseCoords(r.Coordinates || '');
    PEAKS.push({
      peak: name,
      state: (r.State || '').trim() || 'Colorado',
      cmc: (r['CMC List'] || '').trim(),
      range: (r.Range || '').trim(),
      elevation: parseElevation(r.Elevation),
      lat: coords ? coords.lat : null,
      lon: coords ? coords.lon : null,
      mappable: !!coords,
    });
  }

  PEAKS.forEach((p) => PEAK_BY_NAME.set(normPeak(p.peak), p));
}

function buildStats(rows) {
  STATS = new Map();
  SUMMITERS = new Map();

  for (const r of rows) {
    const person = (r.Person || '').trim();
    const peak = (r.Peak || '').trim();
    if (!person || !peak) continue;
    if ((r['Summited?'] || '').trim().toLowerCase() !== 'yes') continue;

    const key = normPeak(peak);
    if (!STATS.has(person)) STATS.set(person, { unique: new Set(), total: 0, cmcUnique: new Set(), cmcTotal: 0 });
    const s = STATS.get(person);
    s.total += 1;
    s.unique.add(key);
    const meta = PEAK_BY_NAME.get(key);
    if (meta && meta.cmc.toLowerCase() === 'yes') { s.cmcUnique.add(key); s.cmcTotal += 1; }

    if (!SUMMITERS.has(key)) SUMMITERS.set(key, new Set());
    SUMMITERS.get(key).add(person);
  }
}

function buildHikerRoster(regRows) {
  // Roster = everyone who appears in the register, ordered by unique count desc.
  const names = new Set();
  for (const r of regRows) {
    const p = (r.Person || '').trim();
    if (p) names.add(p);
  }
  HIKERS = [...names].sort((a, b) => a.localeCompare(b));
}

function buildTrailheads(data) {
  TRAILHEADS = (data && data.trailheads) || [];
  TOWNS = (data && data.towns) || {};
  TH_BY_PEAK = new Map();
  for (const th of TRAILHEADS) {
    for (const pk of (th.peaks || [])) TH_BY_PEAK.set(normPeak(pk), th);
  }
  PEAK_URLS = (data && data.peakUrls) || {};
}

// ---- Leaderboard --------------------------------------------------------
function renderLeaderboard() {
  const cmcOnly = document.getElementById('cmcOnlyLb').checked;
  const body = document.getElementById('leaderboardBody');

  const rows = HIKERS.map((name) => {
    const s = STATS.get(name) || { unique: new Set(), total: 0, cmcUnique: new Set(), cmcTotal: 0 };
    // When CMC-only, "unique" and "total" are restricted to CMC-official peaks.
    const unique = cmcOnly ? s.cmcUnique.size : s.unique.size;
    const total = cmcOnly ? s.cmcTotal : s.total;
    const cmc = s.cmcUnique.size;
    return { name, unique, total, cmc };
  });

  const { key, dir } = lbSort;
  rows.sort((a, b) => {
    if (key === 'name') return dir * a.name.localeCompare(b.name);
    return dir * (a[key] - b[key]) || (b.unique - a.unique) || a.name.localeCompare(b.name);
  });

  const medals = ['🥇', '🥈', '🥉'];
  body.innerHTML = rows.map((r, i) => {
    const rankByUnique = (key === 'unique' && dir === -1);
    const medal = rankByUnique && i < 3 ? `<span class="rank-medal">${medals[i]}</span>` : (i + 1);
    return `<tr>
      <td>${medal}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="text-end fw-semibold stat-pill">${r.unique}</td>
      <td class="text-end stat-pill">${r.total}</td>
      <td class="text-end text-muted stat-pill">${r.cmc}</td>
    </tr>`;
  }).join('');

  // header arrow state
  document.querySelectorAll('th.sortable').forEach((th) => {
    const active = th.dataset.sort === key;
    th.classList.toggle('active', active);
    th.querySelector('.arrow').textContent = active ? (dir === -1 ? '▼' : '▲') : '';
  });
}

// ---- Map ----------------------------------------------------------------
function initMap() {
  map = L.map('map', { scrollWheelZoom: true }).setView([39.1, -106.4], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  // Order matters for z-index: lines under peak dots, trailhead/town dots on top.
  lineLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  thLayer = L.layerGroup().addTo(map);
  townLayer = L.layerGroup().addTo(map);
  map.on('zoomend', updateLabelVisibility);
}

function visiblePeaks() {
  const state = document.getElementById('stateFilter').value;
  const cmcOnly = document.getElementById('cmcOnlyMap').checked;
  const hideDone = document.getElementById('hideDone').checked;
  const n = selectedHikers.size;

  return PEAKS.filter((p) => {
    if (!p.mappable) return false;
    if (state !== 'all' && p.state !== state) return false;
    if (cmcOnly && p.cmc.toLowerCase() !== 'yes') return false;
    if (hideDone && n > 0) {
      const done = countDone(p);
      if (done === n) return false;
    }
    return true;
  });
}

function countDone(peak) {
  const summiters = SUMMITERS.get(normPeak(peak.peak));
  if (!summiters) return 0;
  let c = 0;
  for (const h of selectedHikers) if (summiters.has(h)) c++;
  return c;
}

function colorFor(doneCount, selectedCount) {
  if (selectedCount === 0) return getCss('--neutral');
  if (doneCount === selectedCount) return getCss('--done');
  if (doneCount === 0) return getCss('--none');
  return getCss('--partial');
}

function getCss(v) {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}

// A Leaflet divIcon drawn as an SVG shape so peaks / trailheads / towns are
// distinguishable by shape (triangle / square / diamond), not just color.
function shapeIcon(shape, color, size) {
  const s = size;
  const stroke = '#1a202c';
  let inner;
  if (shape === 'square') {
    inner = `<rect x="1" y="1" width="${s - 2}" height="${s - 2}" fill="${color}" stroke="${stroke}"/>`;
  } else if (shape === 'diamond') {
    inner = `<polygon points="${s / 2},0.5 ${s - 0.5},${s / 2} ${s / 2},${s - 0.5} 0.5,${s / 2}" fill="${color}" stroke="${stroke}"/>`;
  } else { // triangle
    inner = `<polygon points="${s / 2},1 ${s - 1},${s - 1} 1,${s - 1}" fill="${color}" stroke="${stroke}"/>`;
  }
  const svg = `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" style="display:block">${inner}</svg>`;
  return L.divIcon({
    html: svg, className: 'shape-marker',
    iconSize: [s, s], iconAnchor: [s / 2, s / 2], popupAnchor: [0, -s / 2],
  });
}

// Trailhead icon: a blue square labelled "TH".
function thIcon() {
  return L.divIcon({
    html: '<div class="mk mk-th">TH</div>', className: 'mk-wrap',
    iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12], tooltipAnchor: [0, -12],
  });
}

// Town icon: a building glyph inside a purple circle.
function townIcon() {
  const c = TOWN_COLOR;
  const svg = `<svg width="22" height="22" viewBox="0 0 22 22" style="display:block">
    <circle cx="11" cy="11" r="9.5" fill="${c}" stroke="#1a202c" stroke-width="1.5"/>
    <rect x="7" y="6.3" width="8" height="9.4" fill="#fff"/>
    <rect x="8.3" y="7.8" width="1.6" height="1.6" fill="${c}"/>
    <rect x="12.1" y="7.8" width="1.6" height="1.6" fill="${c}"/>
    <rect x="8.3" y="10.4" width="1.6" height="1.6" fill="${c}"/>
    <rect x="12.1" y="10.4" width="1.6" height="1.6" fill="${c}"/>
    <rect x="10.2" y="12.8" width="1.6" height="2.9" fill="${c}"/>
  </svg>`;
  return L.divIcon({
    html: svg, className: 'mk-wrap',
    iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12], tooltipAnchor: [0, -12],
  });
}

// Permanent marker labels are shown only past these zoom levels (via CSS classes
// toggled on the map container) so the fully-zoomed-out view stays uncluttered.
const LABEL_ZOOM = { peak: 8, th: 11, town: 11 };
// Bind a marker's name label. With the "Icon labels" toggle on it's a permanent,
// zoom-gated label; off, it falls back to a plain hover tooltip (the old behavior).
function bindLabel(marker, text, cls, offset) {
  if (document.getElementById('showLabels').checked) {
    marker.bindTooltip(text, { permanent: true, direction: 'top', offset, className: 'mlabel ' + cls });
  } else {
    marker.bindTooltip(text, { direction: 'top' });
  }
}
function updateLabelVisibility() {
  if (!map) return;
  const z = map.getZoom();
  const c = map.getContainer();
  c.classList.toggle('lz-peak', z >= LABEL_ZOOM.peak);
  c.classList.toggle('lz-th', z >= LABEL_ZOOM.th);
  c.classList.toggle('lz-town', z >= LABEL_ZOOM.town);
}

// Remove all permanent label DOM. Leaflet's unbindTooltip does not reliably
// remove permanent-tooltip elements here, so we purge them directly before each
// re-render (every marker + label is rebuilt from scratch afterward).
function purgeLabels() {
  document.querySelectorAll('.leaflet-tooltip.mlabel').forEach((el) => el.remove());
}

function renderMap() {
  if (!map) return;
  purgeLabels();
  markerLayer.clearLayers();
  const peaks = visiblePeaks();
  const n = selectedHikers.size;
  const selArr = [...selectedHikers];

  let doneAll = 0;
  for (const p of peaks) {
    const done = countDone(p);
    if (n > 0 && done === n) doneAll++;
    const color = colorFor(done, n);
    const marker = L.marker([p.lat, p.lon], { icon: shapeIcon('triangle', color, 15) });
    marker.bindPopup(popupHtml(p, selArr));
    bindLabel(marker, p.peak, 'mlabel-peak', [0, -6]);
    markerLayer.addLayer(marker);
  }

  const summary = n === 0
    ? `${peaks.length} peaks shown · select hikers to color them`
    : `${doneAll} / ${peaks.length} shown peaks summited by all ${n} selected`;
  document.getElementById('mapSummary').textContent = summary;

  renderOverlays(peaks);
  updateLabelVisibility();
}

// Draw trailhead + approach-town markers and their connector lines for the
// currently-visible peaks, honoring the two filter toggles.
function renderOverlays(peaks) {
  lineLayer.clearLayers();
  thLayer.clearLayers();
  townLayer.clearLayers();

  const showTH = document.getElementById('showTrailheads').checked;
  const showTowns = document.getElementById('showTowns').checked;
  document.getElementById('legendTH').style.display = showTH ? '' : 'none';
  document.getElementById('legendTown').style.display = showTowns ? '' : 'none';
  if (!showTH) return;

  const visible = new Set(peaks.map((p) => normPeak(p.peak)));

  // Unique trailheads serving at least one visible peak.
  const ths = new Map();
  for (const p of peaks) {
    const th = TH_BY_PEAK.get(normPeak(p.peak));
    if (th) ths.set(th.name, th);
  }

  const drawnTowns = new Set();
  for (const th of ths.values()) {
    // Dashed line from each visible peak this trailhead serves to the trailhead.
    for (const pkName of th.peaks) {
      if (!visible.has(normPeak(pkName))) continue;
      const pk = PEAK_BY_NAME.get(normPeak(pkName));
      if (!pk || !pk.mappable) continue;
      // Peak → trailhead: dashed gray line.
      L.polyline([[pk.lat, pk.lon], [th.lat, th.lon]],
        { color: '#4a5568', weight: 1.6, opacity: 0.55, dashArray: '7,6' }).addTo(lineLayer);
    }
    // Trailhead marker: "TH" square, with a zoom-revealed name label.
    const thm = L.marker([th.lat, th.lon], { icon: thIcon() }).bindPopup(thPopupHtml(th));
    bindLabel(thm, th.name, 'mlabel-th', [0, -4]);
    thm.addTo(thLayer);

    // Approach towns: a line per (trailhead, town), each town marker drawn once.
    if (showTowns) {
      for (const tname of (th.towns || [])) {
        const t = TOWNS[tname];
        if (!t) continue;
        // Trailhead → town: dotted purple line (round caps).
        L.polyline([[th.lat, th.lon], [t.lat, t.lon]],
          { color: TOWN_COLOR, weight: 2.2, opacity: 0.75, dashArray: '1,9', lineCap: 'round' }).addTo(lineLayer);
        if (!drawnTowns.has(tname)) {
          drawnTowns.add(tname);
          const tm = L.marker([t.lat, t.lon], { icon: townIcon() })
            .bindPopup(`<strong>${escapeHtml(tname)}</strong><br><span class="small text-muted">approach town</span>`);
          bindLabel(tm, tname, 'mlabel-town', [0, -4]);
          tm.addTo(townLayer);
        }
      }
    }
  }
}

function thPopupHtml(th) {
  return `<strong>${escapeHtml(th.name)}</strong>
    <div class="small text-muted">Trailhead</div>
    <div class="small mt-1"><strong>Peaks:</strong> ${th.peaks.map(escapeHtml).join(', ')}</div>
    <div class="small"><strong>Town${th.towns.length === 1 ? '' : 's'}:</strong> ${th.towns.map(escapeHtml).join(', ')}</div>`;
}

function popupHtml(p, selArr) {
  const summiters = SUMMITERS.get(normPeak(p.peak)) || new Set();
  const elev = p.elevation ? `${p.elevation.toLocaleString()} ft` : '';
  let who = '';
  if (selArr.length) {
    const done = selArr.filter((h) => summiters.has(h));
    const notDone = selArr.filter((h) => !summiters.has(h));
    who = `<div class="mt-1 small">`;
    if (done.length) who += `<div><span style="color:var(--done)">✔</span> ${done.map(escapeHtml).join(', ')}</div>`;
    if (notDone.length) who += `<div><span style="color:var(--none)">✗</span> ${notDone.map(escapeHtml).join(', ')}</div>`;
    who += `</div>`;
  }
  const total = summiters.size;
  const th = TH_BY_PEAK.get(normPeak(p.peak));
  const thLine = th
    ? `<div class="small mt-1">🥾 ${escapeHtml(th.name)}<br><span class="text-muted">Town${th.towns.length === 1 ? '' : 's'}: ${th.towns.map(escapeHtml).join(', ')}</span></div>`
    : '';
  const url = PEAK_URLS[normPeak(p.peak)];
  const link = url
    ? `<div class="small mt-1"><a href="${url}" target="_blank" rel="noopener">View on 14ers.com ↗</a></div>`
    : '';
  return `<strong>${escapeHtml(p.peak)}</strong><br>
    <span class="text-muted small">${escapeHtml(p.range)}${p.range ? ' · ' : ''}${elev}</span>
    <div class="small mt-1">${total} total summiter${total === 1 ? '' : 's'} in the group${p.cmc.toLowerCase() === 'yes' ? ' · CMC 14er' : ''}</div>
    ${thLine}${link}${who}`;
}

function fitToVisible() {
  const peaks = visiblePeaks();
  if (!peaks.length) return;
  const bounds = L.latLngBounds(peaks.map((p) => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [30, 30], maxZoom: 11 });
}

// ---- Hiker selector -----------------------------------------------------
function renderHikerList() {
  const el = document.getElementById('hikerList');
  el.innerHTML = HIKERS.map((name) => {
    const u = STATS.get(name)?.unique.size || 0;
    const id = 'hk_' + name.replace(/\W/g, '_');
    const checked = selectedHikers.has(name) ? 'checked' : '';
    return `<div class="form-check">
      <input class="form-check-input hiker-cb" type="checkbox" id="${id}" value="${escapeHtml(name)}" ${checked}>
      <label class="form-check-label d-flex justify-content-between" for="${id}">
        <span>${escapeHtml(name)}</span><span class="text-muted small">${u}</span>
      </label>
    </div>`;
  }).join('');
  el.querySelectorAll('.hiker-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedHikers.add(cb.value); else selectedHikers.delete(cb.value);
      renderMap();
    });
  });
}

// ---- Helpers ------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Wire up ------------------------------------------------------------
function attachEvents() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (lbSort.key === key) lbSort.dir *= -1;
      else lbSort = { key, dir: key === 'name' ? 1 : -1 };
      renderLeaderboard();
    });
  });
  document.getElementById('cmcOnlyLb').addEventListener('change', renderLeaderboard);

  document.getElementById('selAll').addEventListener('click', () => {
    HIKERS.forEach((h) => selectedHikers.add(h));
    renderHikerList(); renderMap();
  });
  document.getElementById('selNone').addEventListener('click', () => {
    selectedHikers.clear();
    renderHikerList(); renderMap();
  });
  ['stateFilter', 'cmcOnlyMap', 'hideDone', 'showLabels'].forEach((id) =>
    document.getElementById(id).addEventListener('change', renderMap));
  document.getElementById('fitBtn').addEventListener('click', fitToVisible);

  // Trailhead / approach-town overlays. Towns depend on trailheads:
  // turning towns on forces trailheads on; turning trailheads off clears towns.
  const showTH = document.getElementById('showTrailheads');
  const showTowns = document.getElementById('showTowns');
  showTH.addEventListener('change', () => {
    if (!showTH.checked) showTowns.checked = false;
    renderMap();
  });
  showTowns.addEventListener('change', () => {
    if (showTowns.checked) showTH.checked = true;
    renderMap();
  });

  // Map tab needs a size invalidation when first shown (Leaflet quirk in hidden divs).
  document.getElementById('tab-map').addEventListener('shown.bs.tab', () => {
    map.invalidateSize();
    renderMap();
  });
}

// ---- Boot ---------------------------------------------------------------
(async function main() {
  attachEvents();
  initMap();
  try {
    await loadData();
    renderLeaderboard();
    renderHikerList();
    renderMap();
  } catch (err) {
    console.error(err);
    document.getElementById('loadError').style.display = 'block';
    document.getElementById('loadErrorDetail').textContent = String(err && err.message || err);
    document.getElementById('dataStatus').textContent = 'Load failed';
  }
})();
