// ── CONFIGURATION & CONSTANTS ────────────────────────────────
const CONFIG = {
  populationTifPath: 'landscan_ethiopia_2024_packbits.tif',  // <- your Ethiopia population raster
  pm25TifPath:       'meanpm25_ethiopia_wustl_2023.tif',        // <- your Ethiopia PM2.5 raster
  // Vertical orientation override per raster: null = auto-detect from the GeoTIFF header,
  // true = force a vertical flip, false = force no flip.
  flipYPopulation: null,
  flipYPm25: null
};

// Ethiopia bounding box [SouthWest, NorthEast]. Statistics are computed inside this box.
const ETHIOPIA_BOUNDS = L.latLngBounds([3.3, 32.9], [15.0, 48.1]);

/* GEMM model constants (Burnett et al. 2018) */
const THETA = 0.143, ALPHA = 1.6, MU = 15.5, NU = 36.8, X0 = 2.4;

/* Morbidity effects: base = 'all' | 'adult' | 'under25' */
const EFFECTS = [
  { acr: "ACB", name: "Adult Chronic Bronchitis",      drf: 0.00004,  cost: 300000, base: "adult" },
  { acr: "CAB", name: "Child Acute Bronchitis",         drf: 0.000544, cost: 300000, base: "under25" },
  { acr: "RHA", name: "Respiratory Hospital Admission", drf: 0.000012, cost: 1000,   base: "all" },
  { acr: "CHA", name: "Cardiac Hospital Admission",     drf: 0.000005, cost: 100000, base: "adult" },
  { acr: "ERV", name: "Emergency Room Visit",           drf: 0.000235, cost: 1000,   base: "all" },
  { acr: "AA",  name: "Asthma Attacks",                 drf: 0.0029,   cost: 50,     base: "all" },
  { acr: "RAD", name: "Restricted Activity Days",       drf: 0.03828,  cost: 500,    base: "adult" },
  { acr: "RSD", name: "Respiratory Symptom Days",       drf: 0.183,    cost: 30,     base: "all" }
];
const BASE_LABEL = { all: "population base: all ages", adult: "population base: adult 25+", under25: "population base: under 25" };

const EARTH_R_KM = 6371.0088;

// ── UI HELPERS & ANIMATED COUNTER ─────────────────────────────
function updateText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function fmtMoney(n) {
  if (!isFinite(n)) n = 0;
  if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (Math.abs(n) >= 1e6) return "$" + Math.round(n / 1e6) + "M";
  return "$" + Math.round(n).toLocaleString('en-US');
}

function getDecimalPlaces(val) {
  if (!isFinite(val) || val >= 1000) return 0;
  if (val >= 100) return 1;
  if (val >= 1) return 4;
  if (val >= 0.1) return 6;
  return 4;
}

const activeAnimationTimers = {};

function animateCounter(id, targetValue, duration = 3600000, isCurrency = false) {
  const el = document.getElementById(id);
  if (!el || isNaN(targetValue)) return;

  if (activeAnimationTimers[id]) cancelAnimationFrame(activeAnimationTimers[id]);

  const startTime = performance.now();
  const decimals = getDecimalPlaces(targetValue);
  const fmt = v => isCurrency
    ? fmtMoney(v)
    : v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

  function step(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    el.textContent = fmt(targetValue * progress);
    if (progress < 1) activeAnimationTimers[id] = requestAnimationFrame(step);
    else el.textContent = fmt(targetValue);
  }
  activeAnimationTimers[id] = requestAnimationFrame(step);
}

// ── MAP INIT ──────────────────────────────────────────────────
const map = L.map('map', {
  zoomControl: true,
  maxBoundsViscosity: 1.0
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 18
}).addTo(map);

L.rectangle(ETHIOPIA_BOUNDS, { color: '#164D12', weight: 2, fillOpacity: 0.05 }).addTo(map);
map.fitBounds(ETHIOPIA_BOUNDS);

// Keep the view around Ethiopia
map.setMaxBounds(ETHIOPIA_BOUNDS.pad(0.5));
function clampMinZoom() {
  const fitZoom = map.getBoundsZoom(ETHIOPIA_BOUNDS, false);
  map.setMinZoom(fitZoom - 1);
}
clampMinZoom();
map.on('resize', clampMinZoom);

// ── STATE ─────────────────────────────────────────────────────
const rawTifInfo = { population: null, pm25: null };
const stats = {
  ready: false,
  areaKm2: 0,
  totalPop: 0,
  meanPm25: 0,
  popWeightedPm25: 0
};
let lastResults = null;
let mapLayerPop = null;
let mapLayerPm25 = null;

// ── RASTER COLOR SCHEMES ──────────────────────────────────────
function getPopColor(value) {
  if (value <= 0 || isNaN(value)) return null;
  if (value > 1000) return [8, 48, 107, 200];
  if (value > 500)  return [40, 121, 185, 190];
  if (value > 100)  return [115, 179, 216, 180];
  if (value > 10)   return [200, 221, 240, 170];
  return [247, 251, 255, 160];
}

function getPmColor(value) {
  if (value <= 0 || isNaN(value)) return null;
  if (value > 100) return [128, 0, 38, 200];
  if (value > 75)  return [189, 0, 38, 195];
  if (value > 50)  return [227, 26, 28, 190];
  if (value > 35)  return [252, 78, 42, 185];
  if (value > 15)  return [253, 141, 60, 180];
  if (value > 5)   return [254, 178, 76, 175];
  return [255, 237, 160, 160];
}

// ── LEGENDS ───────────────────────────────────────────────────
const POP_LEGEND = {
  title: 'Population (per cell)',
  rows: [
    { color: '#08306b', label: '> 1000' },
    { color: '#2879b9', label: '500 – 1000' },
    { color: '#73b3d8', label: '100 – 500' },
    { color: '#c8ddf0', label: '10 – 100' },
    { color: '#f7fbff', label: '0 – 10' }
  ]
};

const PM_LEGEND = {
  title: 'PM2.5 (µg/m³)',
  rows: [
    { color: '#800026', label: '> 100' },
    { color: '#bd0026', label: '75 – 100' },
    { color: '#e31a1c', label: '50 – 75' },
    { color: '#fc4e2a', label: '35 – 50' },
    { color: '#fd8d3c', label: '15 – 35' },
    { color: '#feb24c', label: '5 – 15' },
    { color: '#ffeda0', label: '0 – 5' }
  ]
};

function renderLegendGroup(group) {
  const rowsHtml = group.rows.map(r =>
    `<div class="legend-row"><span class="legend-swatch" style="background:${r.color}"></span><span>${r.label}</span></div>`
  ).join('');
  return `<div class="legend-group"><div class="legend-group-title">${group.title}</div>${rowsHtml}</div>`;
}

function updateLegend() {
  const legendEl = document.getElementById('raster-legend');
  if (!legendEl) return;

  const groups = [];
  if (mapLayerPop && map.hasLayer(mapLayerPop)) groups.push(POP_LEGEND);
  if (mapLayerPm25 && map.hasLayer(mapLayerPm25)) groups.push(PM_LEGEND);

  if (groups.length === 0) {
    legendEl.classList.add('hidden');
    legendEl.innerHTML = '';
    return;
  }
  legendEl.innerHTML = groups.map(renderLegendGroup).join('');
  legendEl.classList.remove('hidden');
}

// ── RASTER LAYER GENERATOR ────────────────────────────────────
// Per-tile lat/lng are computed once per row/column (Web Mercator), which is
// much faster than calling map.unproject for every pixel.
function createRasterLayer(tifInfo, colorScaleFn, zIndex) {
  const layer = L.gridLayer({ opacity: 0.7, zIndex: zIndex });

  layer.createTile = function(coords, done) {
    const tile = L.DomUtil.create('canvas', 'leaflet-tile');
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    const ctx = tile.getContext('2d');

    const { data, nodata, width, height, originX, originY, pixelW, pixelH } = tifInfo;
    const worldPx = size.x * Math.pow(2, coords.z);
    const x0 = coords.x * size.x;
    const y0 = coords.y * size.y;

    const cols = new Int32Array(size.x);
    for (let x = 0; x < size.x; x++) {
      const lng = ((x0 + x + 0.5) / worldPx) * 360 - 180;
      cols[x] = Math.floor((lng - originX) / pixelW);
    }
    const rows = new Int32Array(size.y);
    for (let y = 0; y < size.y; y++) {
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y0 + y + 0.5) / worldPx))) * 180 / Math.PI;
      rows[y] = Math.floor((originY - lat) / pixelH);
    }

    const imgData = ctx.createImageData(size.x, size.y);
    const pixels = imgData.data;

    for (let y = 0; y < size.y; y++) {
      const row = rows[y];
      if (row < 0 || row >= height) continue;
      for (let x = 0; x < size.x; x++) {
        const col = cols[x];
        if (col < 0 || col >= width) continue;
        const val = data[row * width + col];
        if (val === null || val === undefined || isNaN(val) || val === nodata || val <= 0) continue;
        const rgba = colorScaleFn(val);
        if (!rgba) continue;
        const idx = (y * size.x + x) * 4;
        pixels[idx] = rgba[0];
        pixels[idx + 1] = rgba[1];
        pixels[idx + 2] = rgba[2];
        pixels[idx + 3] = rgba[3];
      }
    }

    ctx.putImageData(imgData, 0, 0);
    setTimeout(() => done(null, tile), 0);
    return tile;
  };

  return layer;
}

// ── GEOTIFF LOADER ────────────────────────────────────────────
async function loadTifDataHelper(arrayBuffer, flipOverride = null, label = '') {
  const tif = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tif.getImage();
  const fileDir = image.getFileDirectory();
  const width = image.getWidth();
  const height = image.getHeight();

  const nodata = fileDir.GDAL_NODATA !== undefined ? parseFloat(fileDir.GDAL_NODATA) : null;
  const rasters = await image.readRasters({ interleave: false });
  let data = rasters[0];

  // Extent (W, S, E, N) and the world coordinates of the first row's edge.
  // In a north-up raster the origin Y is the north edge; in a south-up raster
  // (positive Y scale) the origin Y is the south edge, i.e. row 0 is the BOTTOM
  // of the map and the rows must be flipped before use.
  const bbox = image.getBoundingBox();
  const origin = image.getOrigin();
  const southUp = Math.abs(origin[1] - bbox[1]) < Math.abs(origin[1] - bbox[3]);

  let originX = bbox[0];
  let northY = bbox[3];
  const pixelW = (bbox[2] - bbox[0]) / width;
  const pixelH = (bbox[3] - bbox[1]) / height;

  // PixelIsPoint rasters reference pixel centres, so shift by half a pixel
  try {
    const gk = image.getGeoKeys();
    if (gk && gk.GTRasterTypeGeoKey === 2) {
      originX -= pixelW / 2;
      northY  += pixelH / 2;
    }
  } catch (e) { /* ignore */ }

  const doFlip = flipOverride === null ? southUp : flipOverride;
  if (doFlip) {
    const flipped = new data.constructor(data.length);
    for (let r = 0; r < height; r++) {
      flipped.set(data.subarray(r * width, (r + 1) * width), (height - 1 - r) * width);
    }
    data = flipped;
  }

  console.log(`[${label}] bbox(W,S,E,N)=${bbox.map(v => v.toFixed(3)).join(', ')} size=${width}x${height} ` +
              `pixel=${pixelW.toFixed(5)}x${pixelH.toFixed(5)} nodata=${nodata} ` +
              `originY=${origin[1].toFixed(3)} southUp=${southUp} flipped=${doFlip}`);

  return {
    data, nodata, width, height,
    originX, originY: northY, pixelW, pixelH,
    bbox: [originX, northY - pixelH * height, originX + pixelW * width, northY]
  };
}

async function fetchTif(path, flipOverride, label) {
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${path}`);
  return loadTifDataHelper(await resp.arrayBuffer(), flipOverride, label);
}

// ── RASTER STATISTICS (PM2.5 mean, pop-weighted PM2.5, total pop, area) ──
function isValidPm(v, nodata) {
  return v !== null && v !== undefined && isFinite(v) && v !== nodata && v > 0 && v < 1000;
}

function sampleRaster(info, lng, lat) {
  const col = Math.floor((lng - info.originX) / info.pixelW);
  const row = Math.floor((info.originY - lat) / info.pixelH);
  if (col < 0 || col >= info.width || row < 0 || row >= info.height) return null;
  return info.data[row * info.width + col];
}

function pixelWindow(info, b) {
  return {
    c0: Math.max(0, Math.floor((b.getWest() - info.originX) / info.pixelW)),
    c1: Math.min(info.width - 1, Math.floor((b.getEast() - info.originX) / info.pixelW)),
    r0: Math.max(0, Math.floor((info.originY - b.getNorth()) / info.pixelH)),
    r1: Math.min(info.height - 1, Math.floor((info.originY - b.getSouth()) / info.pixelH))
  };
}

function computeStats() {
  const pm = rawTifInfo.pm25;
  const pop = rawTifInfo.population;
  if (!pm || !pop) return;

  // 1) Simple mean PM2.5 and area over valid PM2.5 pixels in Ethiopia's box
  {
    const { c0, c1, r0, r1 } = pixelWindow(pm, ETHIOPIA_BOUNDS);
    const dLng = pm.pixelW * Math.PI / 180;
    const dLat = pm.pixelH * Math.PI / 180;
    let sum = 0, n = 0, area = 0;
    for (let r = r0; r <= r1; r++) {
      const latC = (pm.originY - (r + 0.5) * pm.pixelH) * Math.PI / 180;
      const cellArea = EARTH_R_KM * EARTH_R_KM * dLng * dLat * Math.cos(latC);
      const base = r * pm.width;
      for (let c = c0; c <= c1; c++) {
        const v = pm.data[base + c];
        if (isValidPm(v, pm.nodata)) { sum += Number(v); n++; area += cellArea; }
      }
    }
    stats.meanPm25 = n > 0 ? sum / n : 0;
    stats.areaKm2 = area;
  }

  // 2) Total population and population-weighted PM2.5
  {
    const { c0, c1, r0, r1 } = pixelWindow(pop, ETHIOPIA_BOUNDS);
    let totalPop = 0, wSum = 0, wPop = 0;
    for (let r = r0; r <= r1; r++) {
      const lat = pop.originY - (r + 0.5) * pop.pixelH;
      const base = r * pop.width;
      for (let c = c0; c <= c1; c++) {
        const p = pop.data[base + c];
        if (!(p > 0) || p === pop.nodata) continue;
        totalPop += Number(p);
        const lng = pop.originX + (c + 0.5) * pop.pixelW;
        const v = sampleRaster(pm, lng, lat);
        if (isValidPm(v, pm.nodata)) { wSum += Number(p) * Number(v); wPop += Number(p); }
      }
    }
    stats.totalPop = totalPop;
    stats.popWeightedPm25 = wPop > 0 ? wSum / wPop : 0;
  }

  stats.ready = true;
}

// ── APP INITIALIZATION ────────────────────────────────────────
async function init() {
  const btnPop = document.getElementById('btn-population');
  const btnPm25 = document.getElementById('btn-pm25');
  const statusEl = document.getElementById('load-status');
  const errors = [];

  const popTask = fetchTif(CONFIG.populationTifPath, CONFIG.flipYPopulation, 'population').then(info => {
    rawTifInfo.population = info;
    mapLayerPop = createRasterLayer(info, getPopColor, 4);
    btnPop.textContent = '👁 Population';
    btnPop.disabled = false;
  }).catch(err => {
    btnPop.textContent = 'Pop Error';
    errors.push('Population: ' + err.message);
    console.error('Failed to load Population TIF:', err);
  });

  const pmTask = fetchTif(CONFIG.pm25TifPath, CONFIG.flipYPm25, 'pm25').then(info => {
    rawTifInfo.pm25 = info;
    mapLayerPm25 = createRasterLayer(info, getPmColor, 5);
    btnPm25.textContent = '👁 PM2.5';
    btnPm25.disabled = false;
  }).catch(err => {
    btnPm25.textContent = 'PM2.5 Error';
    errors.push('PM2.5: ' + err.message);
    console.error('Failed to load PM2.5 TIF:', err);
  });

  await Promise.all([popTask, pmTask]);

  if (errors.length) {
    statusEl.textContent = errors.join(' · ');
    statusEl.classList.add('error');
    return;
  }

  statusEl.textContent = 'Computing statistics…';
  // let the browser paint the status text before the heavy loop
  await new Promise(r => setTimeout(r, 30));
  computeStats();
  statusEl.textContent = 'Rasters loaded.';
  renderHealthImpacts();
}

// ── LAYER TOGGLES ─────────────────────────────────────────────
function wireToggle(btnId, getLayer) {
  document.getElementById(btnId)?.addEventListener('click', function() {
    const layer = getLayer();
    if (!layer) return;
    if (map.hasLayer(layer)) {
      map.removeLayer(layer);
      this.classList.remove('active');
    } else {
      map.addLayer(layer);
      this.classList.add('active');
    }
    updateLegend();
  });
}
wireToggle('btn-population', () => mapLayerPop);
wireToggle('btn-pm25', () => mapLayerPm25);

// ── HEALTH MATH ───────────────────────────────────────────────
// GEMM attributable fraction (non-accidental mortality, ages 25+)
function gemmAttributableFraction(pm25) {
  const z = Math.max(pm25 - X0, 0);
  const dum1 = THETA * Math.log(1 + z / ALPHA);
  const dum2 = 1 + Math.exp(-(z - MU) / NU);
  const HR = Math.exp(dum1 / dum2);
  return (HR - 1) / HR;
}

function renderHealthImpacts() {
  if (!stats.ready) return;

  const num = (id, fallback) => {
    const el = document.getElementById(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isNaN(v) ? fallback : v;
  };

  const baselineDeathRate = num('deathRate', 5.5);
  const frac25 = num('pop25', 40) / 100;
  const gdp = num('gdp', 0);
  const gdpRef = num('gdpRef', 1);
  const vslRef = num('vslRef', 0);
  const elasticity = num('elasticity', 0);

  const gdpCorrection = (gdp > 0 && gdpRef > 0) ? Math.pow(gdp / gdpRef, elasticity) : 1;
  const VSL = vslRef * gdpCorrection;

  const basis = document.getElementById('pmBasis')?.value || 'mean';
  const pmUsed = basis === 'popweighted' ? stats.popWeightedPm25 : stats.meanPm25;

  const AF = gemmAttributableFraction(pmUsed);
  const popAdult = stats.totalPop * frac25;
  const totalMortality = AF * (baselineDeathRate / 1000) * popAdult;   // cases per year
  const totalCost = totalMortality * VSL;

  updateText('stat-area', `${stats.areaKm2.toLocaleString('en-US', { maximumFractionDigits: 0 })} km²`);
  updateText('stat-pop-total', Math.round(stats.totalPop).toLocaleString('en-US'));
  updateText('stat-mean-pm25', `${stats.meanPm25.toFixed(1)} µg/m³`);
  updateText('stat-pw-pm25', `${stats.popWeightedPm25.toFixed(1)} µg/m³`);
  updateText('stat-avg-pm25', `${pmUsed.toFixed(1)} µg/m³`);

  // Per-hour counters, animated over one hour (same as the original page)
  animateCounter('totalMortalityCount', totalMortality / (365 * 24), 3600000, false);
  animateCounter('totalMortalityCost', totalCost / (365 * 24), 3600000, true);

  const { morbidityCostUSD, breakdown } = calculateMorbidity(stats.totalPop, frac25, gdpCorrection);
  updateText('totalMorbidityCost', fmtMoney(morbidityCostUSD));
  updateText('totalCombinedCost', fmtMoney(totalCost + morbidityCostUSD));

  lastResults = {
    areaKm2: stats.areaKm2, totalPop: stats.totalPop,
    meanPm25: stats.meanPm25, popWeightedPm25: stats.popWeightedPm25,
    pmBasis: basis, pmUsed,
    baselineDeathRate, frac25: frac25 * 100, vsl: VSL, gdpCorrection,
    totalMortality, totalMortalityCostUSD: totalCost,
    morbidityCostUSD, combinedCostUSD: totalCost + morbidityCostUSD,
    breakdown
  };

  const downloadBtn = document.getElementById('btn-download-box-csv');
  if (downloadBtn) downloadBtn.disabled = false;
}

// ── MORBIDITY ─────────────────────────────────────────────────
function buildMorbidityRows() {
  const tbody = document.getElementById('morbidity-body');
  if (!tbody) return;
  tbody.innerHTML = EFFECTS.map((eff, i) => `
    <tr>
      <td class="effect-name">
        <div class="name">${eff.name}</div>
        <div class="acronym">${eff.acr} · ${BASE_LABEL[eff.base]}</div>
      </td>
      <td><span class="impact-val" id="morb-cases-${i}">—</span></td>
      <td><span class="cost-val" id="morb-cost-${i}">—</span></td>
    </tr>
  `).join('');
}

function calculateMorbidity(totalPop, frac25, gdpCorrection = 1) {
  const popAdult = totalPop * frac25;
  const popByBase = { all: totalPop, adult: popAdult, under25: totalPop - popAdult };

  let morbidityCostUSD = 0;
  const breakdown = [];
  EFFECTS.forEach((eff, i) => {
    const cases = eff.drf * popByBase[eff.base];
    const costUSD = cases * eff.cost * gdpCorrection;
    morbidityCostUSD += costUSD;
    breakdown.push({ acr: eff.acr, name: eff.name, cases, costUSD });
    updateText(`morb-cases-${i}`, Math.round(cases).toLocaleString('en-US'));
    updateText(`morb-cost-${i}`, fmtMoney(costUSD));
  });

  return { morbidityCostUSD, breakdown };
}

document.getElementById('morbidity-toggle')?.addEventListener('click', function() {
  const content = document.getElementById('morbidity-content');
  if (!content) return;
  const isOpen = !content.classList.contains('hidden');
  content.classList.toggle('hidden', isOpen);
  this.classList.toggle('open', !isOpen);
});

buildMorbidityRows();

['deathRate', 'pop25', 'gdp', 'gdpRef', 'vslRef', 'elasticity', 'pmBasis'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', renderHealthImpacts);
});

// ── EXPORT TO CSV ─────────────────────────────────────────────
function buildResultsCsv(r) {
  const rows = [
    ['Metric', 'Value'],
    ['Area of valid PM2.5 cells (km2)', r.areaKm2.toFixed(0)],
    ['Total Population', Math.round(r.totalPop)],
    ['Mean PM2.5 (ug/m3)', r.meanPm25.toFixed(2)],
    ['Population-weighted PM2.5 (ug/m3)', r.popWeightedPm25.toFixed(2)],
    ['PM2.5 basis used', r.pmBasis === 'popweighted' ? 'Population-weighted mean' : 'Simple mean'],
    ['PM2.5 used (ug/m3)', r.pmUsed.toFixed(2)],
    ['Baseline Death Rate (per 1000)', r.baselineDeathRate],
    ['Population Aged 25+ (%)', r.frac25.toFixed(1)],
    ['GDP Correction Factor', r.gdpCorrection.toFixed(4)],
    ['Adjusted VSL (USD)', r.vsl.toFixed(2)],
    [''],
    ['Estimated Mortality (cases/yr)', r.totalMortality.toFixed(2)],
    ['Cost of Mortality (USD/yr)', r.totalMortalityCostUSD.toFixed(2)],
    ['Total Morbidity Cost (USD/yr)', r.morbidityCostUSD.toFixed(2)],
    ['Combined Mortality + Morbidity Cost (USD/yr)', r.combinedCostUSD.toFixed(2)],
    [''],
    ['Morbidity Effect', 'Cases/yr', 'Cost (USD)']
  ];
  r.breakdown.forEach(b => rows.push([`${b.name} (${b.acr})`, b.cases.toFixed(2), b.costUSD.toFixed(2)]));

  return rows.map(row => row.map(cell => {
    const s = String(cell);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

document.getElementById('btn-download-box-csv')?.addEventListener('click', function() {
  if (!lastResults) return;
  const blob = new Blob([buildResultsCsv(lastResults)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ethiopia_results.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// Start the application
init();