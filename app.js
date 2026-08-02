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

let map, markerLayer;
const selectedHikers = new Set();
let lbSort = { key: 'unique', dir: -1 };

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
  const [peakRows, regRows] = await Promise.all([
    fetchCsv('14ers'),
    fetchCsv('Hike Register'),
  ]);

  buildPeaks(peakRows);
  buildStats(regRows);
  buildHikerRoster(regRows);

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
  markerLayer = L.layerGroup().addTo(map);
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

function renderMap() {
  if (!map) return;
  markerLayer.clearLayers();
  const peaks = visiblePeaks();
  const n = selectedHikers.size;
  const selArr = [...selectedHikers];

  let doneAll = 0;
  for (const p of peaks) {
    const done = countDone(p);
    if (n > 0 && done === n) doneAll++;
    const color = colorFor(done, n);
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 6, color: '#222', weight: 1, fillColor: color, fillOpacity: 0.9,
    });
    marker.bindPopup(popupHtml(p, selArr));
    marker.bindTooltip(p.peak, { direction: 'top' });
    markerLayer.addLayer(marker);
  }

  const summary = n === 0
    ? `${peaks.length} peaks shown · select hikers to color them`
    : `${doneAll} / ${peaks.length} shown peaks summited by all ${n} selected`;
  document.getElementById('mapSummary').textContent = summary;
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
  return `<strong>${escapeHtml(p.peak)}</strong><br>
    <span class="text-muted small">${escapeHtml(p.range)}${p.range ? ' · ' : ''}${elev}</span>
    <div class="small mt-1">${total} total summiter${total === 1 ? '' : 's'} in the group${p.cmc.toLowerCase() === 'yes' ? ' · CMC 14er' : ''}</div>
    ${who}`;
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
  ['stateFilter', 'cmcOnlyMap', 'hideDone'].forEach((id) =>
    document.getElementById(id).addEventListener('change', renderMap));
  document.getElementById('fitBtn').addEventListener('click', fitToVisible);

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
